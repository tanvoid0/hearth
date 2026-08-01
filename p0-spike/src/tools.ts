import { promises as fs } from "node:fs";
import path from "node:path";
import { applyEdits, type Edit } from "../../hearth-app/src/lib/edit.ts";

export type { Edit };

// Minimal tool set per build-plan §5: list_files, read_file, edit_file,
// write_file, finish. search/run_command/get_errors are out of scope for P0 —
// the toy tasks don't need them.

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolCallLog {
  name: string;
  args: unknown;
  result: ToolResult;
}

function resolveInWorkdir(workdir: string, relPath: string): string {
  const resolved = path.resolve(workdir, relPath);
  const root = path.resolve(workdir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes workdir: ${relPath}`);
  }
  return resolved;
}

async function walk(dir: string, root: string, depth: number, maxDepth: number, out: string[]): Promise<void> {
  if (depth > maxDepth) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      out.push(rel + "/");
      await walk(full, root, depth + 1, maxDepth, out);
    } else {
      out.push(rel);
    }
  }
}

export async function listFiles(workdir: string, relPath = "."): Promise<ToolResult> {
  try {
    const target = resolveInWorkdir(workdir, relPath);
    const out: string[] = [];
    await walk(target, workdir, 0, 4, out);
    return { ok: true, output: out.sort().join("\n") };
  } catch (err) {
    return { ok: false, output: `error: ${(err as Error).message}` };
  }
}

export async function readFile(workdir: string, relPath: string): Promise<ToolResult> {
  try {
    const target = resolveInWorkdir(workdir, relPath);
    const content = await fs.readFile(target, "utf8");
    return { ok: true, output: content };
  } catch (err) {
    return { ok: false, output: `error: ${(err as Error).message}` };
  }
}

// The search/replace contract itself is the app's, imported rather than
// copied. It was a copy until the two were diffed and found identical, which is
// the good outcome of a duplicate and not one to rely on twice: this harness
// exists to score how well a model drives that exact matcher, so a spike
// grading its own private version would eventually be grading the wrong thing.
export async function editFile(workdir: string, relPath: string, edits: Edit[]): Promise<ToolResult> {
  try {
    const target = resolveInWorkdir(workdir, relPath);
    const before = await fs.readFile(target, "utf8");
    const { content, failures } = applyEdits(before, edits);

    if (failures.length > 0) {
      return { ok: false, output: `edit_file failed, no changes applied:\n${failures.join("\n\n")}` };
    }

    await fs.writeFile(target, content, "utf8");
    return { ok: true, output: `applied ${edits.length} edit(s) to ${relPath}` };
  } catch (err) {
    return { ok: false, output: `error: ${(err as Error).message}` };
  }
}

export async function writeFile(workdir: string, relPath: string, content: string): Promise<ToolResult> {
  try {
    const target = resolveInWorkdir(workdir, relPath);
    const exists = await fs
      .access(target)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      return {
        ok: false,
        output: `error: ${relPath} already exists — write_file is for new files only, use edit_file to modify it`,
      };
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return { ok: true, output: `created ${relPath}` };
  } catch (err) {
    return { ok: false, output: `error: ${(err as Error).message}` };
  }
}

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories under a path (depth-limited).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path, defaults to repo root ('.')" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file, relative to the repo root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
        },
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
      name: "finish",
      description: "Call this when the task is complete to end the turn.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Short summary of what was done" },
        },
        required: ["summary"],
      },
    },
  },
] as const;

export async function dispatchTool(
  workdir: string,
  name: string,
  args: any
): Promise<ToolResult> {
  switch (name) {
    case "list_files":
      return listFiles(workdir, args?.path ?? ".");
    case "read_file":
      return readFile(workdir, args?.path);
    case "edit_file":
      return editFile(workdir, args?.path, args?.edits ?? []);
    case "write_file":
      return writeFile(workdir, args?.path, args?.content ?? "");
    case "finish":
      return { ok: true, output: "turn finished" };
    default:
      return { ok: false, output: `error: unknown tool '${name}'` };
  }
}
