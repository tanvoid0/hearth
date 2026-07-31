import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat, type ChatMessage } from "./ollama.js";
import { TOOL_DEFS, dispatchTool } from "./tools.js";
import type { Task } from "./tasks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "..", "fixtures", "toy-repo");
const MAX_ITERATIONS = 15;

const SYSTEM_PROMPT = `You are a coding agent working inside a small TypeScript repository.
You have tools to inspect and edit files. Use them to complete the user's task, then call
the "finish" tool with a short summary. Work in as few steps as needed. Always use tools to
read a file before editing it — do not guess its contents. Prefer edit_file for existing
files and write_file only for brand-new files.`;

export interface RunLog {
  model: string;
  taskId: string;
  iterations: number;
  toolCallCounts: Record<string, number>;
  malformedJsonCount: number;
  wrongToolCount: number;
  failedDiffCount: number;
  finishedVia: "finish_call" | "max_iterations" | "no_tool_call" | "error";
  errorDetail?: string;
  verifyPass: boolean;
  verifyDetail: string;
  wallMs: number;
}

async function makeWorkdir(model: string, taskId: string): Promise<string> {
  const slug = `${model}-${taskId}`.replace(/[^a-z0-9-]/gi, "_");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `hearth-p0-${slug}-`));
  await fs.cp(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

export async function runOne(model: string, task: Task): Promise<RunLog> {
  const start = Date.now();
  const workdir = await makeWorkdir(model, task.id);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task.prompt },
  ];

  const toolCallCounts: Record<string, number> = {};
  let malformedJsonCount = 0;
  let wrongToolCount = 0;
  let failedDiffCount = 0;
  let finishedVia: RunLog["finishedVia"] = "max_iterations";
  let errorDetail: string | undefined;
  let iterations = 0;

  try {
    for (; iterations < MAX_ITERATIONS; iterations++) {
      const result = await chat(model, messages, TOOL_DEFS);

      if (result.malformedToolCall) {
        malformedJsonCount++;
      }

      messages.push(result.message);

      const calls = result.message.tool_calls ?? [];
      if (calls.length === 0) {
        finishedVia = result.malformedToolCall ? "max_iterations" : "no_tool_call";
        break;
      }

      let calledFinish = false;
      for (const call of calls) {
        const name = call.function.name;
        let args = call.function.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            malformedJsonCount++;
            messages.push({ role: "tool", tool_name: name, content: "error: arguments were not valid JSON" });
            continue;
          }
        }

        toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;

        if (name === "finish") {
          calledFinish = true;
          messages.push({ role: "tool", tool_name: name, content: "ok" });
          continue;
        }

        const toolResult = await dispatchTool(workdir, name, args);
        if (!toolResult.ok && toolResult.output.startsWith("error: unknown tool")) {
          wrongToolCount++;
        }
        if (!toolResult.ok && name === "edit_file") {
          failedDiffCount++;
        }
        messages.push({ role: "tool", tool_name: name, content: toolResult.output });
      }

      if (calledFinish) {
        finishedVia = "finish_call";
        break;
      }
    }
  } catch (err) {
    finishedVia = "error";
    errorDetail = (err as Error).message;
  }

  let verifyPass = false;
  let verifyDetail = errorDetail ?? "not verified";
  if (!errorDetail) {
    try {
      const v = await task.verify(workdir);
      verifyPass = v.pass;
      verifyDetail = v.detail;
    } catch (err) {
      verifyDetail = `verify threw: ${(err as Error).message}`;
    }
  }

  await fs.rm(workdir, { recursive: true, force: true });

  return {
    model,
    taskId: task.id,
    iterations: iterations + 1,
    toolCallCounts,
    malformedJsonCount,
    wrongToolCount,
    failedDiffCount,
    finishedVia,
    errorDetail,
    verifyPass,
    verifyDetail,
    wallMs: Date.now() - start,
  };
}
