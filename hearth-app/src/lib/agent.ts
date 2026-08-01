import { listDir, readTextFile, searchFiles, writeTextFile } from "./fs";
import { exportedSymbols, formatRepoMap, isSourceFile } from "./repomap";
import { applyEdits, changedLines, resolveInProject, samePath, type Edit } from "./edit";
import { CANCELLED, chat, DEFAULT_NUM_CTX, type ChatMessage, type ToolCall } from "./ollama";
import { contextLimits, packHistory, stalled } from "./session";
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
      name: "run_command",
      description:
        "Run one program in the project directory and read its output and exit code — tests, builds, type checks. One program per call: no pipes, redirects, or && chaining. Allowed: npm, pnpm, yarn, npx, node, deno, bun, cargo, tsc, vitest, jest, python, and read-only git (status, diff, log, show, branch, ls-files, describe).",
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
const MAX_LISTED_ENTRIES = 400;
/** Enough to see the shape of a match set, few enough that a common word
 *  doesn't cost the whole context window. */
const MAX_SEARCH_HITS = 60;
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", ".hearth"]);

export interface ToolResult {
  ok: boolean;
  output: string;
}

async function walk(dir: string, root: string, depth: number, out: string[]): Promise<void> {
  if (depth > 3 || out.length >= MAX_LISTED_ENTRIES) return;
  for (const entry of await listDir(dir)) {
    if (out.length >= MAX_LISTED_ENTRIES) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = entry.path.slice(root.length + 1).replace(/\\/g, "/");
    if (entry.is_dir) {
      out.push(rel + "/");
      await walk(entry.path, root, depth + 1, out);
    } else {
      out.push(rel);
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  return readTextFile(path).then(
    () => true,
    () => false
  );
}

async function dispatchTool(root: string, name: string, args: any, maxRead: number): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_files": {
        const target = resolveInProject(root, args?.path ?? ".");
        const out: string[] = [];
        await walk(target, root, 0, out);
        const truncated = out.length >= MAX_LISTED_ENTRIES ? "\n… (truncated)" : "";
        return { ok: true, output: out.sort().join("\n") + truncated };
      }
      case "read_file": {
        const target = resolveInProject(root, args?.path);
        const content = await readTextFile(target);
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

        const before = await readTextFile(target);
        const { content, failures } = applyEdits(before, edits);
        if (failures.length > 0) {
          return { ok: false, output: `edit_file failed, no changes applied:\n${failures.join("\n\n")}` };
        }
        await writeTextFile(target, content);
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
        if (await fileExists(target)) {
          return {
            ok: false,
            output: `error: ${args?.path} already exists — write_file is for new files only, use edit_file to modify it`,
          };
        }
        await writeTextFile(target, args?.content ?? "");
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
        return { ok: true, output: hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n") + capped };
      }
      case "repo_map": {
        const entries: string[] = [];
        await walk(root, root, 0, entries);
        const sources = entries.filter((rel) => !rel.endsWith("/") && isSourceFile(rel));
        const files = await Promise.all(
          sources.map(async (rel) => ({
            path: rel,
            symbols: exportedSymbols(await readTextFile(resolveInProject(root, rel)).catch(() => "")),
          })),
        );
        return { ok: true, output: formatRepoMap(files, entries.length >= MAX_LISTED_ENTRIES) };
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
      case "run_command": {
        const result = await runCommand(root, String(args?.command ?? ""), COMMAND_TIMEOUT_SECS);
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
  | { type: "tool"; label: string; ok: boolean; detail: string }
  | { type: "error"; text: string }
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
const PLAN_PROMPT =
  "Before touching anything, write a short numbered plan for this task: which files you expect to " +
  "read or change, what the change is, and what you will check afterwards. At most five steps. " +
  "Do not call any tools yet and do not write out the code — just the plan.";

const PLAN_ACK = "Now carry that out with the tools, adjusting the plan if what you read contradicts it.";

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
    "a build. Prefer it over asking the user to run something and paste the result back.",
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
  const messages: ChatMessage[] =
    opts.history.length > 0
      ? [...opts.history]
      : [{ role: "system", content: systemPrompt(root, opts.activeFile) }];
  messages.push({ role: "user", content: prompt });

  let repairs = 0;
  /** Whether this turn changed anything on disk — what makes an unfinished
   *  turn worth verifying rather than just ending. */
  let wrote = false;
  /** One entry per tool call: the call and what it returned. See `stalled`. */
  const signatures: string[] = [];

  try {
    if (opts.plan) {
      messages.push({ role: "user", content: PLAN_PROMPT });
      const planned = await chat(
        model,
        packHistory(messages, budget),
        [], // no tools: the point is the thinking, not an early edit
        (text) => {
          if (!shouldStop()) onEvent({ type: "token", text });
        },
        numCtx,
        cancelId
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

      // Send a windowful, keep the whole thing. A conversation outgrows the
      // context long before it outgrows storage, and Ollama's own overflow
      // handling drops from the front — which silently takes the system prompt
      // with it, so the agent stops following its own instructions partway
      // through a session. Re-packed every iteration because tool results
      // (a file read is up to 40k chars) grow the list mid-turn, not just
      // between turns.
      const reply = await chat(
        model,
        packHistory(messages, budget),
        TOOL_DEFS,
        (text) => {
          if (!shouldStop()) onEvent({ type: "token", text });
        },
        numCtx,
        cancelId
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
          if (verdict.blocking > 0 && repairs < MAX_REPAIR_ROUNDS) {
            repairs++;
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

        const result = await dispatchTool(root, name, args, maxRead);
        // Draw the line the next get_errors reports against: console messages
        // logged before this write describe the code the agent just replaced.
        if (result.ok && (name === "edit_file" || name === "write_file")) {
          wrote = true;
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
