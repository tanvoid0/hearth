// Does a model actually use `get_errors` after it edits a file?
//
// Narrower than the spike next door: that one asks whether a model can hold a
// tool loop at all, this one asks whether it follows the one instruction the
// error feedback loop depends on. Run it when picking a default model, or
// after changing the system prompt.
//
//   npm run probe -- gemma4:latest llama3.1:8b
//
// It imports the app's real TOOL_DEFS / systemPrompt / applyEdits / devLogTail
// rather than copies, so it can't drift out of step with what ships. The file
// tools are reimplemented on node fs because the app's own dispatchTool goes
// through Tauri invoke, which has no meaning outside the app — and the file
// layer isn't what's under test here.

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chat, type ChatMessage } from "./ollama.js";
import { TOOL_DEFS, systemPrompt } from "../../hearth-app/src/lib/agent.ts";
import { applyEdits } from "../../hearth-app/src/lib/edit.ts";
import { consoleTail, devLogTail } from "../../hearth-app/src/lib/runlog.ts";
import { problemTail } from "../../hearth-app/src/lib/problems.ts";
import { exportedSymbols, formatRepoMap, isSourceFile } from "../../hearth-app/src/lib/repomap.ts";

const MAX_ITERATIONS = 15;
// Same cap the app applies to auto-repair rounds (build plan §6).
const MAX_REPAIR_ROUNDS = 3;

// A real vite transform error, as it appears on the dev server's stdout. Canned
// rather than provoked: the point is a deterministic broken build to react to,
// not to talk a small model into writing one.
const BROKEN_LOG = [
  "  VITE v7.3.6  ready in 224 ms",
  "  ➜  Local:   http://localhost:5173/",
  '7:31:02 PM [vite] Internal server error: Unexpected token, expected "," (7:12)',
  "  Plugin: vite:react-babel",
  "  File: src/App.jsx:7:12",
];
const CLEAN_LOG = [
  "  VITE v7.3.6  ready in 224 ms",
  "  ➜  Local:   http://localhost:5173/",
  "7:31:44 PM [vite] hmr update /src/App.jsx",
];

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "probe", type: "module" }, null, 2),
  "src/main.jsx": `import { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
  "src/App.jsx": `export default function App() {\n  return (\n    <div className="app">\n      <h1>Hello</h1>\n      <p>Edit src/App.jsx and save to reload.</p>\n    </div>\n  );\n}\n`,
};

const TASK = "Change the heading in src/App.jsx from 'Hello' to 'Hearth'.";

export interface ProbeResult {
  model: string;
  wallSec: number;
  trace: string;
  finishedVia: "finish_call" | "no_tool_call" | "max_iterations";
  /** The thing being measured: did it check its own work at all? */
  checkedAfterEdit: boolean;
  /** And did it check again after repairing, or declare victory blind? */
  rechecked: boolean;
  /** How many times `finish` was bounced back because the build was still
   *  broken — the P10 auto-repair rounds. 0 means it verified before saying so. */
  repairRounds: number;
  /** Ground truth — plenty of models narrate an edit they never landed. */
  headingApplied: boolean;
  /** Whatever it chose to shell out for, verbatim. */
  commands: string[];
}

async function scaffold(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hearth-probe-"));
  for (const [rel, content] of Object.entries(FILES)) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return dir;
}

export async function probe(model: string): Promise<ProbeResult> {
  const root = await scaffold();
  // A small canned world, so the run is deterministic: the build is broken, and
  // an edit fixes it only once the model has actually been shown the error.
  // `told` is set by get_errors *and* by a bounced finish — being handed the
  // error by the repair round is the same information.
  let told = false;
  let repaired = false;
  let errorCalls = 0;
  let repairRounds = 0;
  const commandCalls: string[] = [];
  const trace: string[] = [];

  /** What the app's get_errors returns, through the app's own formatters. */
  const errorReport = () =>
    [
      problemTail("ok", [], root),
      devLogTail("ready", "http://localhost:5173/", repaired ? CLEAN_LOG : BROKEN_LOG),
      consoleTail(false, []),
    ].join("\n\n");

  async function run(name: string, args: any): Promise<string> {
    const rel = String(args?.path ?? "");
    const target = path.join(root, rel);
    switch (name) {
      case "list_files":
        return Object.keys(FILES).join("\n");
      case "read_file":
        return fs.readFile(target, "utf8");
      case "edit_file": {
        const before = await fs.readFile(target, "utf8").catch(() => null);
        if (before === null) return `error: ${rel} does not exist`;
        const { content, failures } = applyEdits(before, args?.edits ?? []);
        if (failures.length) return `edit_file failed, no changes applied:\n${failures.join("\n\n")}`;
        await fs.writeFile(target, content, "utf8");
        if (told) repaired = true;
        return `applied edit(s) to ${rel}`;
      }
      case "write_file":
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, args?.content ?? "", "utf8");
        return `created ${rel}`;
      // The two P11 tools. Answerable rather than faithful: a model that calls
      // one and gets "unknown tool" back would skew the measurement this probe
      // exists for, and the canned world is three files deep.
      case "search": {
        const needle = String(args?.query ?? "").toLowerCase();
        const hits = Object.entries(FILES).flatMap(([file, body]) =>
          body
            .split("\n")
            .map((line, i) => ({ file, i, line }))
            .filter(({ line }) => line.toLowerCase().includes(needle))
            .map(({ file, i, line }) => `${file}:${i + 1}: ${line.trim()}`),
        );
        return hits.length > 0 ? hits.join("\n") : `no matches for "${args?.query ?? ""}"`;
      }
      case "repo_map":
        return formatRepoMap(
          Object.entries(FILES)
            .filter(([file]) => isSourceFile(file))
            .map(([file, body]) => ({ path: file, symbols: exportedSymbols(body) })),
        );
      case "get_errors":
        // All three of the app's sources, through the app's own formatters —
        // the model has to see the shape it will really be handed, or the
        // instruction-following this measures is being measured against a
        // different tool. Type checking reports clean because the task's edit
        // introduces no type error; the dev log is the canned thing to react to,
        // and no preview is attached in a probe, which `consoleTail` says
        // rather than passing off as silence.
        errorCalls++;
        told = true;
        return errorReport();
      case "run_command": {
        // The app runs this through Rust, behind an allowlist. Here it only has
        // to be answerable — a model that calls it and gets "unknown tool" back
        // would skew the measurement this probe exists for.
        commandCalls.push(String(args?.command ?? ""));
        const [program, ...rest] = String(args?.command ?? "").split(/\s+/);
        const done = spawnSync(program, rest, { cwd: root, encoding: "utf8", shell: true, timeout: 60_000 });
        return `exited ${done.status ?? -1}\n\n${(done.stdout ?? "") + (done.stderr ?? "") || "(no output)"}`;
      }
      default:
        return `error: unknown tool '${name}'`;
    }
  }

  // Mirrors dispatchTool's outer try/catch: a throwing tool is an error message
  // the model gets a chance to recover from, not a dead run.
  const dispatch = (name: string, args: any) =>
    run(name, args).catch((err: Error) => `error: ${err.message}`);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(root, "src/App.jsx") },
    { role: "user", content: TASK },
  ];

  const start = Date.now();
  let finishedVia: ProbeResult["finishedVia"] = "max_iterations";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const { message } = await chat(model, messages, TOOL_DEFS);
    messages.push(message);
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      finishedVia = "no_tool_call";
      break;
    }

    let done = false;
    for (const call of calls) {
      const name = call.function.name;
      let args: any = call.function.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          trace.push(`${name}(bad JSON)`);
          messages.push({ role: "tool", tool_name: name, content: "error: arguments were not valid JSON" });
          continue;
        }
      }
      trace.push(name === "get_errors" ? `get_errors[${errorCalls + 1}]` : name);
      if (name === "finish") {
        // Mirrors runAgent's VERIFY step: a finish that doesn't hold up gets
        // handed the errors and bounced, up to the same cap. Without this the
        // probe would be measuring a loop the app no longer runs.
        if (!repaired && repairRounds < MAX_REPAIR_ROUNDS) {
          repairRounds++;
          told = true;
          trace.push(`repair[${repairRounds}]`);
          messages.push({
            role: "tool",
            tool_name: name,
            content: `not finished — 1 error(s) still reported. Fix them, then call finish again.\n\n${errorReport()}`,
          });
          continue;
        }
        done = true;
        messages.push({ role: "tool", tool_name: name, content: "turn finished" });
        continue;
      }
      messages.push({ role: "tool", tool_name: name, content: await dispatch(name, args) });
    }
    if (done) {
      finishedVia = "finish_call";
      break;
    }
  }

  const final = await fs.readFile(path.join(root, "src/App.jsx"), "utf8").catch(() => "");
  await fs.rm(root, { recursive: true, force: true });

  const firstEdit = trace.findIndex((t) => t === "edit_file" || t === "write_file");

  return {
    model,
    wallSec: +((Date.now() - start) / 1000).toFixed(1),
    trace: trace.join(" → "),
    finishedVia,
    checkedAfterEdit: firstEdit >= 0 && trace.slice(firstEdit + 1).some((t) => t.startsWith("get_errors")),
    rechecked: errorCalls >= 2,
    repairRounds,
    headingApplied: final.includes("<h1>Hearth</h1>"),
    commands: commandCalls,
  };
}

const models = process.argv.slice(2);
if (models.length === 0) {
  console.error("usage: npm run probe -- <model> [model...]");
  process.exit(1);
}
for (const model of models) {
  console.log(`\n=== ${model} ===`);
  try {
    console.log(JSON.stringify(await probe(model), null, 2));
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message}`);
  }
}
