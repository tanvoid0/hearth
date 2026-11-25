import { listDir, pathExists, readTextFile, searchFiles, writeTextFile } from "./fs";
import { exportedSymbols, formatRepoMap, isSourceFile } from "./repomap";
import { isSecretFile, redactEnv } from "./secrets";
import { applyEdits, changedLines, resolveInProject, samePath, type Edit } from "./edit";
import { CANCELLED, chat, DEFAULT_NUM_CTX, type CallStats, type ChatMessage, type ToolCall } from "./ollama";
import {
  addCall,
  contextLimits,
  isServerScript,
  sendWindow,
  stalled,
  worthRepairing,
  wroteThisTurn,
  type TurnStats,
} from "./session";
import { useHearthStore } from "./store";
import { useRunner } from "./runner";
import { consoleTail, countErrorsSince, devLogTail } from "./runlog";
import { hasChecked, useLsp } from "./lsp";
import { problemTail } from "./problems";
import { runCommand } from "./terminal";

// Tool surface is P0's validated set (build plan §5), plus `get_errors` — all
// three of plan §10's sources merged: type errors, the dev server's output and
// the preview's browser console — plus §11's `search` and `repo_map`.
export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories under a path (depth-limited).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative path, defaults to project root ('.')" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file, relative to the project root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative file path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Apply one or more search/replace edits to an existing file. Each edit's `search` must match existing file content exactly (or up to whitespace); it is replaced with `replace`.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                search: { type: "string", description: "Exact existing text to find" },
                replace: { type: "string", description: "Text to replace it with" },
              },
              required: ["search", "replace"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a brand-new file with the given content. Fails if the file already exists.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path for the new file" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Find which files contain a piece of text — a function name, a string in the UI, an import. Case-insensitive and literal, not a regex. Use this instead of reading files one at a time to find where something lives.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The text to look for" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_map",
      description:
        "List every source file in the project with the names it exports. Use this first on an unfamiliar project to see what exists before reading anything.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_errors",
      description:
        "Check the project for errors from three sources: the TypeScript compiler (undefined names, wrong arguments, misspelled props — reported for every file, whether or not the app is running), the dev server's build output, and the running app's browser console. Call this after editing files to check the change compiles AND runs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "start_app",
      description:
        "Start the project's dev server and wait until it is serving, then return its URL and any build output. Use this rather than running the dev script with run_command: a dev server never exits, so run_command would sit there until it times out and then kill the server. Safe to call when it is already running.",
      parameters: {
        type: "object",
        properties: {
          script: { type: "string", description: "package.json script to run, defaults to 'dev'" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run one program in the project directory and read its output and exit code — tests, builds, type checks. The program has to exit on its own: use start_app for the dev server. One program per call: no pipes, redirects, or && chaining, and no code on the command line (`node -e`, `python -c`) — put it in a file and run the file. Allowed: npm, pnpm, yarn, npx, node, deno, bun, cargo, tsc, vitest, jest, python, and read-only git (status, diff, log, show, branch, ls-files, describe).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command, e.g. 'npm test' or 'npx tsc --noEmit'" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Call this when the task is complete to end the turn.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "Short summary of what was done" } },
        required: ["summary"],
      },
    },
  },
] as const;

/** Build plan §6 puts ACT at "max ~15". The repair rounds below need headroom
 *  inside it, since a repair spends iterations like anything else. */
const MAX_ITERATIONS = 15;
/** How many times a `finish` that doesn't hold up may be bounced back. Plan
 *  §6: "errors → back into ACT, max 3 auto-repair rounds". */
const MAX_REPAIR_ROUNDS = 3;
/** Identical (call, result) pairs before the turn is called stuck. */
const MAX_IDENTICAL_CALLS = 3;
/** A cold `npm install` runs for minutes; anything past this is hung, and a
 *  hung command would otherwise hold the whole turn open. */
const COMMAND_TIMEOUT_SECS = 180;
/** How long `start_app` waits for the server to say it's serving. Generous
 *  because a cold project installs first — the same minutes `install` allows,
 *  since it is the same install. */
const START_TIMEOUT_SECS = 300;
const MAX_LISTED_ENTRIES = 400;
/** `list_files` is described to the model as depth-limited, and a listing is
 *  something it asks for one directory at a time. */
const MAX_LIST_DEPTH = 3;
/** `repo_map` claims to cover the whole project, so it goes deeper: a monorepo
 *  keeps its code four or five levels down, and a map that stops at three
 *  reports the rest as if it didn't exist. */
const MAX_MAP_DEPTH = 8;
/** Enough to see the shape of a match set, few enough that a common word
 *  doesn't cost the whole context window. */
const MAX_SEARCH_HITS = 60;
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", ".hearth"]);

export interface ToolResult {
  ok: boolean;
  output: string;
}

/** Returns whether anything was left out — either cap silently drops files, and
 *  a model told a listing is complete stops looking for what isn't in it. */
async function walk(dir: string, root: string, depth: number, out: string[], maxDepth: number): Promise<boolean> {
  if (out.length >= MAX_LISTED_ENTRIES) return true;
  if (depth > maxDepth) return true;
  let cut = false;
  for (const entry of await listDir(dir)) {
    if (out.length >= MAX_LISTED_ENTRIES) return true;
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = entry.path.slice(root.length + 1).replace(/\\/g, "/");
    if (entry.is_dir) {
      out.push(rel + "/");
      cut = (await walk(entry.path, root, depth + 1, out, maxDepth)) || cut;
    } else {
      out.push(rel);
    }
  }
  return cut;
}

async function dispatchTool(root: string, name: string, args: any, maxRead: number): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_files": {
        const target = resolveInProject(root, args?.path ?? ".");
        const out: string[] = [];
        const cut = await walk(target, root, 0, out, MAX_LIST_DEPTH);
        const truncated = cut ? `\n… (not everything is listed — ${MAX_LIST_DEPTH} levels deep at most, list a subdirectory for the rest)` : "";
        return { ok: true, output: out.sort().join("\n") + truncated };
      }
      case "read_file": {
        const target = resolveInProject(root, args?.path);
        // Keys, never values (build plan §14). Not about trusting the model:
        // the reply goes into the transcript, which is written to localStorage
        // and sent back as history on every subsequent turn.
        const raw = await readTextFile(target, root);
        const content = isSecretFile(target) ? redactEnv(raw) : raw;
        return content.length > maxRead
          ? { ok: true, output: content.slice(0, maxRead) + "\n… (file truncated)" }
          : { ok: true, output: content };
      }
      case "edit_file": {
        const target = resolveInProject(root, args?.path);
        const edits: Edit[] = args?.edits ?? [];

        // Refuse to clobber unsaved editor state — the agent's write would
        // silently lose whatever the user has typed but not saved.
        const dirty = useHearthStore
          .getState()
          .tabs.find((t) => samePath(t.path, target) && t.content !== t.savedContent);
        if (dirty) {
          return {
            ok: false,
            output: `error: ${args?.path} has unsaved changes open in the editor — ask the user to save or revert it first`,
          };
        }

        const before = await readTextFile(target, root);
        const { content, failures } = applyEdits(before, edits);
        if (failures.length > 0) {
          return { ok: false, output: `edit_file failed, no changes applied:\n${failures.join("\n\n")}` };
        }
        await writeTextFile(target, content, root);
        // Tell tsserver before the next get_errors asks it. It holds open files
        // in memory, so a write it doesn't hear about is a file it keeps
        // type-checking at its previous contents.
        useLsp.getState().touch(target, content);
        // Before syncFromDisk, which replaces the tab's content — after it,
        // there's nothing left to compare against.
        useHearthStore.getState().markAgentWrite(target, changedLines(before, content));
        await useHearthStore.getState().syncFromDisk(target);
        return { ok: true, output: `applied ${edits.length} edit(s) to ${args?.path}` };
      }
      case "write_file": {
        const target = resolveInProject(root, args?.path);
        if (await pathExists(target)) {
          return {
            ok: false,
            output: `error: ${args?.path} already exists — write_file is for new files only, use edit_file to modify it`,
          };
        }
        await writeTextFile(target, args?.content ?? "", root);
        useLsp.getState().touch(target, args?.content ?? "");
        useHearthStore.getState().markAgentWrite(target, changedLines("", args?.content ?? ""));
        await useHearthStore.getState().syncFromDisk(target);
        return { ok: true, output: `created ${args?.path}` };
      }
      case "search": {
        const query = String(args?.query ?? "");
        const hits = await searchFiles(root, query, MAX_SEARCH_HITS);
        if (hits.length === 0) return { ok: true, output: `no matches for "${query}"` };
        // The cap has to be visible: a model told "12 matches" when there were
        // 300 will edit the twelve and call the job done.
        const capped = hits.length >= MAX_SEARCH_HITS ? `\n… (stopped at ${MAX_SEARCH_HITS} matches — narrow the query)` : "";
        // The line is the match, and in a .env file the match is the secret.
        // The path still comes back, so "which file sets this" is answerable.
        const body = hits.map((h) => `${h.path}:${h.line}: ${isSecretFile(h.path) ? "(redacted)" : h.text}`);
        return { ok: true, output: body.join("\n") + capped };
      }
      case "repo_map": {
        const entries: string[] = [];
        const cut = await walk(root, root, 0, entries, MAX_MAP_DEPTH);
        const sources = entries.filter((rel) => !rel.endsWith("/") && isSourceFile(rel));
        const files = await Promise.all(
          sources.map(async (rel) => ({
            path: rel,
            symbols: exportedSymbols(await readTextFile(resolveInProject(root, rel), root).catch(() => "")),
          })),
        );
        return { ok: true, output: formatRepoMap(files, cut) };
      }
      case "get_errors": {
        // Type errors first: they cover every file rather than only the one
        // being served, and they exist before the app is ever run.
        await useLsp.getState().checkProject();
        const { status, problems } = useLsp.getState();
        const { status: run, url, log, consoleAttached, consoleLog, consoleMark } = useRunner.getState();
        return {
          ok: true,
          output: [
            problemTail(status === "ok" && !hasChecked() ? "idle" : status, problems, root),
            devLogTail(run, url, log),
            consoleTail(consoleAttached, consoleLog, consoleMark),
          ].join("\n\n"),
        };
      }
      case "start_app": {
        const runner = useRunner.getState();
        if (!runner.running) await runner.start(root, args?.script);
        // `start` returns once the process is spawned; the status machine only
        // reaches "ready" later, off the server's own output. Polled rather
        // than subscribed because this is the one place that waits for it.
        const deadline = Date.now() + START_TIMEOUT_SECS * 1000;
        while (Date.now() < deadline && ["installing", "starting"].includes(useRunner.getState().status)) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const { status, url, log } = useRunner.getState();
        return { ok: status === "ready", output: devLogTail(status, url, log) };
      }
      case "run_command": {
        const command = String(args?.command ?? "");
        if (isServerScript(command)) {
          return {
            ok: false,
            output:
              "refused: that starts a server and never returns. Use start_app instead — it starts the dev server, waits for it, and leaves it running.",
          };
        }
        const result = await runCommand(root, command, COMMAND_TIMEOUT_SECS);
        // Tail, not head: a failing test run ends with the failure and begins
        // with a banner, and the tail is what the model needs.
        const body =
          result.output.length > maxRead
            ? `… (earlier output omitted)\n${result.output.slice(-maxRead)}`
            : result.output || "(no output)";
        const status = result.timed_out
          ? `timed out after ${COMMAND_TIMEOUT_SECS}s and was killed`
          : `exited ${result.exit_code}`;
        return { ok: result.exit_code === 0 && !result.timed_out, output: `${status}\n\n${body}` };
      }
      case "finish":
        return { ok: true, output: "turn finished" };
      default:
        return { ok: false, output: `error: unknown tool '${name}'` };
    }
  } catch (err) {
    return { ok: false, output: `error: ${(err as Error).message}` };
  }
}

/**
 * The VERIFY step of build plan §6, run when the model says it's finished.
 *
 * Counts only what can be counted honestly. Type errors and browser-console
 * errors are unambiguous; the dev server's output deliberately has no
 * classifier (see `devLogTail`), so a build failure doesn't trigger a repair
 * round on its own — though it is still in the report the model gets, and in
 * practice a build that won't compile shows up as a type error too.
 */
async function verify(root: string, maxRead: number): Promise<{ blocking: number; report: string }> {
  const result = await dispatchTool(root, "get_errors", {}, maxRead);
  const { status, problems } = useLsp.getState();
  const { consoleAttached, consoleLog, consoleMark } = useRunner.getState();
  return {
    blocking:
      (status === "ok" ? problems.filter((p) => p.severity === "error").length : 0) +
      (consoleAttached ? countErrorsSince(consoleLog, consoleMark) : 0),
    report: result.output,
  };
}

function summarize(name: string, args: any): string {
  switch (name) {
    case "edit_file":
      return `edit_file ${args?.path} (${args?.edits?.length ?? 0} edit${args?.edits?.length === 1 ? "" : "s"})`;
    case "list_files":
      return `list_files ${args?.path ?? "."}`;
    case "search":
      return `search "${args?.query ?? ""}"`;
    case "repo_map":
      return "repo_map";
    // The user is the only check on what the agent runs, so the row has to show
    // the command itself rather than just the tool's name.
    case "run_command":
      return `$ ${args?.command ?? ""}`.trim();
    case "finish":
      return "finish";
    default:
      return `${name} ${args?.path ?? ""}`.trim();
  }
}

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "assistant"; content: string }
  | { type: "plan"; text: string }
  /** A tool that has started but not returned. The row below only appears once
   *  it has, and a command can run for minutes — without this the panel says
   *  "thinking" while the test suite is what's actually taking the time. */
  | { type: "running"; label: string }
  | { type: "tool"; label: string; ok: boolean; detail: string }
  | { type: "error"; text: string }
  /** The turn's cost so far, re-emitted as each model call returns rather than
   *  once at the end. A twelve-step turn on a model that spilled to CPU is
   *  worth abandoning at step three, and the rate is what says so. */
  | { type: "stats"; stats: TurnStats }
  | { type: "done"; reason: string };

/** What an approval gate is asked about. `detail` is the change itself — the
 *  new file content, the search/replace pairs, the command — because a gate
 *  that only shows a tool name is a gate you learn to click through. */
export interface ApprovalRequest {
  label: string;
  detail: string;
}

export interface RunAgentOptions {
  model: string;
  root: string;
  prompt: string;
  history: ChatMessage[];
  activeFile?: string | null;
  /** Context window for every call in this turn. Bigger holds more files, and
   *  costs VRAM the model itself is competing for. */
  numCtx?: number;
  /** Names every model call in this turn, so Stop can abort the one in flight
   *  rather than only stopping the next one. */
  cancelId?: string;
  /** Ask the model for a plan before it touches anything (build plan §6). */
  plan?: boolean;
  /** Messages from a turn that was cut off mid-flight. When set, the turn picks
   *  up from them instead of opening a new one: `prompt` is already the last
   *  user message in there, along with every tool result collected before the
   *  interruption. The PLAN step doesn't re-run — either it's in here already,
   *  or the turn died before it produced one. */
  resume?: ChatMessage[];
  /** Called at each point the message list is a place the turn could restart
   *  from: before every model call, never part-way through a tool-call batch.
   *  Persisted by the caller, so a reload doesn't cost the work already done. */
  onStep?: (messages: ChatMessage[]) => void;
  /** Called before every write and every command when set. Resolving false
   *  refuses that one call and lets the turn carry on. */
  approve?: (request: ApprovalRequest) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
  /** Polled between model calls — the Stop button flips this. */
  shouldStop: () => boolean;
}

/** Tools that change something outside Hearth. Reading is not gated: an
 *  approval prompt on every `read_file` is one nobody reads by the third turn,
 *  and reads are what the model has to do a lot of to be any good. */
const GATED_TOOLS = new Set(["edit_file", "write_file", "run_command"]);

/** Longest change shown in an approval prompt. A generated file can be
 *  thousands of lines, and a dialog nobody can scroll to the end of is a
 *  dialog nobody reads. */
const MAX_APPROVAL_CHARS = 4000;

/** The change itself, in whatever form the tool takes it. */
function preview(name: string, args: any): string {
  const body =
    name === "edit_file"
      ? (args?.edits ?? []).map((e: Edit) => `- ${e.search}\n+ ${e.replace}`).join("\n\n")
      : name === "write_file"
        ? String(args?.content ?? "")
        : name === "run_command"
          ? String(args?.command ?? "")
          : JSON.stringify(args ?? {}, null, 2);
  return body.length > MAX_APPROVAL_CHARS ? `${body.slice(0, MAX_APPROVAL_CHARS)}\n… (truncated)` : body;
}

/**
 * The PLAN step of build plan §6, which calls it "the biggest quality lever for
 * local models".
 *
 * One tool-free call before the loop starts. Tool-free is the point: a model
 * handed tools uses them, and what's wanted here is the thinking that would
 * otherwise happen one tool call at a time — and be re-derived from scratch
 * every time the context window trims. Costs one extra call per turn, which is
 * why it's a switch rather than a law.
 */
export const PLAN_PROMPT =
  "Before touching anything, write a short numbered plan for this task: which files you expect to " +
  "read or change, what the change is, and what you will check afterwards. At most five steps. " +
  "Do not call any tools yet and do not write out the code — just the plan.";

export const PLAN_ACK = "Now carry that out with the tools, adjusting the plan if what you read contradicts it.";

export function systemPrompt(root: string, activeFile?: string | null): string {
  return [
    `You are a coding agent working inside the project at ${root}.`,
    "You have tools to inspect and edit files. Use them to complete the user's task, then call",
    'the "finish" tool with a short summary. Work in as few steps as needed. Always read a file',
    "with read_file before editing it — never guess its contents. Use edit_file for existing files",
    "and write_file only for brand-new files. All paths are relative to the project root.",
    "To find where something lives, use search (which files contain this text) or repo_map (what",
    "this project exports, by file) rather than reading files one at a time.",
    "After you change a file, call get_errors. It reports type errors from the TypeScript compiler,",
    "the dev server's build output, and the running page's browser console — code that compiles can",
    "still crash on load, and a type error is reported whether or not the app is running. Fix",
    "anything it reports and check again before finishing.",
    "Use run_command for anything that needs to actually execute — the test suite, a type check,",
    "a build. Prefer it over asking the user to run something and paste the result back. For the",
    "dev server use start_app, not run_command: it waits for the server to come up and leaves it",
    "running, which is what makes the browser console half of get_errors report anything.",
    "Calling finish re-checks the project: if errors remain you will be handed them and asked to",
    "keep going, so check and fix before finishing rather than after.",
    activeFile ? `The user currently has ${activeFile} open in the editor.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Run one user turn to completion: model call → tool calls → repeat until the
 * model calls finish, stops asking for tools, or hits the iteration cap.
 * Returns the extended history so the next turn keeps the context.
 */
export async function runAgent(opts: RunAgentOptions): Promise<ChatMessage[]> {
  const { model, root, prompt, onEvent, shouldStop, numCtx = DEFAULT_NUM_CTX, cancelId = "" } = opts;
  const { history: budget, read: maxRead } = contextLimits(numCtx);
  const resuming = (opts.resume?.length ?? 0) > 0;
  const messages: ChatMessage[] = resuming
    ? [...opts.resume!]
    : opts.history.length > 0
      ? [...opts.history]
      : [{ role: "system", content: systemPrompt(root, opts.activeFile) }];
  if (!resuming) messages.push({ role: "user", content: prompt });

  let repairs = 0;
  /** Reset on every bounce. See `worthRepairing`: a finish that follows one
   *  without a single write in between is the same claim over the same files,
   *  so re-verifying it can only produce the same answer. */
  let wroteSinceRepair = false;
  /** Whether this turn changed anything on disk — what makes an unfinished
   *  turn worth verifying rather than just ending. Recovered from the messages
   *  when resuming: those writes happened, even though this process didn't make
   *  them. */
  let wrote = resuming && wroteThisTurn(messages);
  /** One entry per tool call: the call and what it returned. See `stalled`. */
  const signatures: string[] = [];
  /** Where the sent window starts. Carried across calls rather than recomputed,
   *  which is the whole point — see `sendWindow`. */
  let sentStart = 0;
  /** What the turn has cost so far. Not carried across turns: it answers "is
   *  this model worth waiting for on this machine", which is a question about
   *  the run in front of you. */
  let stats: TurnStats | null = null;

  /** Fold one call's cost in and report the new total. Every `chat` in this
   *  function goes through it — a call counted in one place and not another
   *  would make the tok/s the average of an arbitrary subset. */
  function counted(result: { message: ChatMessage; stats: CallStats | null }): ChatMessage {
    stats = addCall(stats, result.stats);
    onEvent({ type: "stats", stats });
    return result.message;
  }

  try {
    if (opts.plan && !resuming) {
      messages.push({ role: "user", content: PLAN_PROMPT });
      const plannedWindow = sendWindow(messages, budget, sentStart);
      sentStart = plannedWindow.start;
      const planned = counted(
        await chat(
          model,
          plannedWindow.messages,
          [], // no tools: the point is the thinking, not an early edit
          (text) => {
            if (!shouldStop()) onEvent({ type: "token", text });
          },
          numCtx,
          cancelId
        )
      );
      messages.push(planned);
      messages.push({ role: "user", content: PLAN_ACK });
      onEvent({ type: "plan", text: planned.content.trim() });
    }

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (shouldStop()) {
        onEvent({ type: "done", reason: "stopped" });
        return messages;
      }

      // The last safe place to restart from. Here rather than after each push:
      // the list ends on the user's prompt or on a complete set of tool
      // results, never on a tool call whose result is still missing — which is
      // a history no model can be handed. The cost of the split second between
      // here and the reply is re-asking one question; the cost of persisting
      // mid-batch is a conversation that can't be resumed at all.
      opts.onStep?.(messages);

      // Send a windowful, keep the whole thing. A conversation outgrows the
      // context long before it outgrows storage, and Ollama's own overflow
      // handling drops from the front — which silently takes the system prompt
      // with it, so the agent stops following its own instructions partway
      // through a session. Re-checked every iteration because tool results
      // (a file read is up to 40k chars) grow the list mid-turn, not just
      // between turns — but the window only actually moves when it stops
      // fitting, so the prefix Ollama caches on holds still in between.
      const window = sendWindow(messages, budget, sentStart);
      sentStart = window.start;
      const reply = counted(
        await chat(
          model,
          window.messages,
          TOOL_DEFS,
          (text) => {
            if (!shouldStop()) onEvent({ type: "token", text });
          },
          numCtx,
          cancelId
        )
      );
      messages.push(reply);
      if (reply.content.trim()) onEvent({ type: "assistant", content: reply.content });

      const calls: ToolCall[] = reply.tool_calls ?? [];
      if (calls.length === 0) {
        // Stopping without calling finish is a real exit, not a repair
        // opportunity: the model may be asking the user something, and bouncing
        // a question back with a build log would be worse than useless. But a
        // turn that *changed files* and then trailed off is the most common way
        // a weak model fails — measured: llama3.1:8b edits once, the edit
        // fails, and it stops — and the user is otherwise left believing it
        // worked. Say so rather than repair it. Gated on having written
        // something, so a conversational reply doesn't pay for a project check.
        if (wrote) {
          const verdict = await verify(root, maxRead);
          if (verdict.blocking > 0) {
            onEvent({ type: "done", reason: `stopped without finishing — ${verdict.blocking} error(s) still reported` });
            return messages;
          }
        }
        onEvent({ type: "done", reason: "replied" });
        return messages;
      }

      let finished = false;
      let remaining = 0;
      for (const call of calls) {
        const name = call.function.name;
        let args: any = call.function.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            messages.push({ role: "tool", tool_name: name, content: "error: arguments were not valid JSON" });
            onEvent({ type: "tool", label: name, ok: false, detail: "arguments were not valid JSON" });
            continue;
          }
        }

        if (name === "finish") {
          // Don't take its word for it. Declaring victory on a broken build is
          // the failure mode the probe measures, and the one thing that turns
          // this from a chat window into something that finishes a job.
          const verdict = await verify(root, maxRead);
          if (verdict.blocking > 0 && worthRepairing(repairs, MAX_REPAIR_ROUNDS, wroteSinceRepair)) {
            repairs++;
            wroteSinceRepair = false;
            messages.push({
              role: "tool",
              tool_name: name,
              content: `not finished — ${verdict.blocking} error(s) still reported. Fix them, then call finish again.\n\n${verdict.report}`,
            });
            onEvent({
              type: "tool",
              label: `finish → ${verdict.blocking} error(s) remain, repair ${repairs}/${MAX_REPAIR_ROUNDS}`,
              ok: false,
              detail: verdict.report,
            });
            continue; // `finished` stays false, so the loop carries on
          }
          finished = true;
          remaining = verdict.blocking;
          messages.push({ role: "tool", tool_name: name, content: "turn finished" });
          if (args?.summary) onEvent({ type: "assistant", content: args.summary });
          continue;
        }

        // Build plan §6's approval gate. Refusing one call doesn't end the
        // turn: the model is told no and gets to decide what to do instead,
        // which is what makes this different from Stop.
        if (opts.approve && GATED_TOOLS.has(name)) {
          const label = summarize(name, args);
          if (!(await opts.approve({ label, detail: preview(name, args) }))) {
            const refusal = "the user refused this — do not retry it; either work another way or explain why you can't";
            messages.push({ role: "tool", tool_name: name, content: refusal });
            onEvent({ type: "tool", label: `refused · ${label}`, ok: false, detail: refusal });
            // Recorded like any other call, so a model that asks three times
            // trips the loop detector instead of asking forever.
            signatures.push(`${name}:${JSON.stringify(args ?? null)}:refused`);
            if (stalled(signatures, MAX_IDENTICAL_CALLS)) {
              onEvent({ type: "done", reason: `stopped: ${label} was refused ${MAX_IDENTICAL_CALLS} times` });
              return messages;
            }
            continue;
          }
        }

        onEvent({ type: "running", label: summarize(name, args) });
        const result = await dispatchTool(root, name, args, maxRead);
        // Draw the line the next get_errors reports against: console messages
        // logged before this write describe the code the agent just replaced.
        if (result.ok && (name === "edit_file" || name === "write_file")) {
          wrote = true;
          wroteSinceRepair = true;
          useRunner.getState().markConsole();
        }
        messages.push({ role: "tool", tool_name: name, content: result.output });
        onEvent({ type: "tool", label: summarize(name, args), ok: result.ok, detail: result.output });

        signatures.push(`${name}:${JSON.stringify(args ?? null)}:${result.output}`);
        if (stalled(signatures, MAX_IDENTICAL_CALLS)) {
          onEvent({
            type: "done",
            reason: `stopped: ${summarize(name, args)} returned the same result ${MAX_IDENTICAL_CALLS} times — nothing is changing`,
          });
          return messages;
        }
      }

      if (finished) {
        // A repair budget that ran out is not the same as a clean finish, and
        // the transcript is the only place that difference can show up.
        onEvent({
          type: "done",
          reason:
            remaining > 0
              ? `finished, but ${remaining} error(s) still reported after ${repairs} repair round(s)`
              : "finished",
        });
        return messages;
      }
    }
    onEvent({ type: "done", reason: `hit the ${MAX_ITERATIONS}-step cap` });
  } catch (err) {
    // Stop aborts the call in flight, which surfaces here as a rejection. It's
    // the user's own decision, not a failure — reporting it in red would train
    // people not to press it.
    if ((err as Error).message === CANCELLED) {
      onEvent({ type: "done", reason: "stopped" });
      return messages;
    }
    onEvent({ type: "error", text: (err as Error).message });
    onEvent({ type: "done", reason: "error" });
  }
  return messages;
}
