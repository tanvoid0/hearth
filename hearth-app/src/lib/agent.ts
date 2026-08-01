import { listDir, readTextFile, writeTextFile } from "./fs";
import { applyEdits, resolveInProject, samePath, type Edit } from "./edit";
import { chat, DEFAULT_NUM_CTX, type ChatMessage, type ToolCall } from "./ollama";
import { contextLimits, packHistory } from "./session";
import { useHearthStore } from "./store";
import { useRunner } from "./runner";
import { consoleTail, devLogTail } from "./runlog";
import { hasChecked, useLsp } from "./lsp";
import { problemTail } from "./problems";
import { runCommand } from "./terminal";

// Tool surface is P0's validated set (build plan §5), plus `get_errors` — now
// all three of plan §10's sources merged: type errors, the dev server's output
// and the preview's browser console. `search` arrives with P11.
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

const MAX_ITERATIONS = 12;
/** A cold `npm install` runs for minutes; anything past this is hung, and a
 *  hung command would otherwise hold the whole turn open. */
const COMMAND_TIMEOUT_SECS = 180;
const MAX_LISTED_ENTRIES = 400;
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
        await useHearthStore.getState().syncFromDisk(target);
        return { ok: true, output: `created ${args?.path}` };
      }
      case "get_errors": {
        // Type errors first: they cover every file rather than only the one
        // being served, and they exist before the app is ever run.
        await useLsp.getState().checkProject();
        const { status, problems } = useLsp.getState();
        const { running, url, log, consoleAttached, consoleLog, consoleMark } = useRunner.getState();
        return {
          ok: true,
          output: [
            problemTail(status === "ok" && !hasChecked() ? "idle" : status, problems, root),
            devLogTail(running, url, log),
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

function summarize(name: string, args: any): string {
  switch (name) {
    case "edit_file":
      return `edit_file ${args?.path} (${args?.edits?.length ?? 0} edit${args?.edits?.length === 1 ? "" : "s"})`;
    case "list_files":
      return `list_files ${args?.path ?? "."}`;
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
  | { type: "tool"; label: string; ok: boolean; detail: string }
  | { type: "error"; text: string }
  | { type: "done"; reason: string };

export interface RunAgentOptions {
  model: string;
  root: string;
  prompt: string;
  history: ChatMessage[];
  activeFile?: string | null;
  /** Context window for every call in this turn. Bigger holds more files, and
   *  costs VRAM the model itself is competing for. */
  numCtx?: number;
  onEvent: (event: AgentEvent) => void;
  /** Polled between model calls — the Stop button flips this. */
  shouldStop: () => boolean;
}

export function systemPrompt(root: string, activeFile?: string | null): string {
  return [
    `You are a coding agent working inside the project at ${root}.`,
    "You have tools to inspect and edit files. Use them to complete the user's task, then call",
    'the "finish" tool with a short summary. Work in as few steps as needed. Always read a file',
    "with read_file before editing it — never guess its contents. Use edit_file for existing files",
    "and write_file only for brand-new files. All paths are relative to the project root.",
    "After you change a file, call get_errors. It reports type errors from the TypeScript compiler,",
    "the dev server's build output, and the running page's browser console — code that compiles can",
    "still crash on load, and a type error is reported whether or not the app is running. Fix",
    "anything it reports and check again before finishing.",
    "Use run_command for anything that needs to actually execute — the test suite, a type check,",
    "a build. Prefer it over asking the user to run something and paste the result back.",
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
  const { model, root, prompt, onEvent, shouldStop, numCtx = DEFAULT_NUM_CTX } = opts;
  const { history: budget, read: maxRead } = contextLimits(numCtx);
  const messages: ChatMessage[] =
    opts.history.length > 0
      ? [...opts.history]
      : [{ role: "system", content: systemPrompt(root, opts.activeFile) }];
  messages.push({ role: "user", content: prompt });

  try {
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
        numCtx
      );
      messages.push(reply);
      if (reply.content.trim()) onEvent({ type: "assistant", content: reply.content });

      const calls: ToolCall[] = reply.tool_calls ?? [];
      if (calls.length === 0) {
        onEvent({ type: "done", reason: "replied" });
        return messages;
      }

      let finished = false;
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
          finished = true;
          messages.push({ role: "tool", tool_name: name, content: "ok" });
          if (args?.summary) onEvent({ type: "assistant", content: args.summary });
          continue;
        }

        const result = await dispatchTool(root, name, args, maxRead);
        // Draw the line the next get_errors reports against: console messages
        // logged before this write describe the code the agent just replaced.
        if (result.ok && (name === "edit_file" || name === "write_file")) useRunner.getState().markConsole();
        messages.push({ role: "tool", tool_name: name, content: result.output });
        onEvent({ type: "tool", label: summarize(name, args), ok: result.ok, detail: result.output });
      }

      if (finished) {
        onEvent({ type: "done", reason: "finished" });
        return messages;
      }
    }
    onEvent({ type: "done", reason: `hit the ${MAX_ITERATIONS}-step cap` });
  } catch (err) {
    onEvent({ type: "error", text: (err as Error).message });
    onEvent({ type: "done", reason: "error" });
  }
  return messages;
}
