// The same 20 tasks as the spike next door, run through the app's loop.
//
//   npm run loop-spike -- gemma4:latest
//
// The spike measures the model without the app around it: P0's five tools, no
// get_errors, no type check, no auto-repair round. gemma4 scores 12/20 there,
// and four of the eight failures wrote syntactically broken TypeScript — which
// is exactly what P9 and P10 were built to catch. This is the measurement that
// says how much they're worth: same fixture, same tasks, same verify, but the
// system prompt, tool set, PLAN step, loop detection and finish verification
// are the app's, imported rather than copied (see app-loop.ts).
//
// The difference from the probe is the world, not the loop. The probe's is
// canned so a run is deterministic; here `get_errors` runs a real type check
// over the real workdir, because a canned error can't catch a mistake the model
// invented.

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { appLoop, type LoopResult, type ToolResult, type World } from "./app-loop.js";
import { TASKS, type Task } from "./tasks.js";
import { listLocalModels, OLLAMA_HOST } from "./ollama.js";
import { applyEdits } from "../../src/lib/edit.ts";
import { consoleTail, devLogTail } from "../../src/lib/runlog.ts";
import { problemTail, type CheckStatus, type Problem } from "../../src/lib/problems.ts";
import { exportedSymbols, formatRepoMap, isSourceFile } from "../../src/lib/repomap.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "..", "fixtures", "toy-repo");
const RESULTS_DIR = path.resolve(__dirname, "..", "results");

/**
 * The compiler API rather than a spawned tsserver.
 *
 * The app talks to tsserver because it also needs hover, go-to-definition and
 * incremental checks on an unsaved buffer; here the only question is which
 * errors a finished project has, which is `getPreEmitDiagnostics` — the same
 * syntactic and semantic passes, out of the same compiler, already structured.
 * Spawning tsserver from node would mean reimplementing the Content-Length
 * framing that lives in Rust, to arrive at the same diagnostics.
 *
 * The fixture has no tsconfig, deliberately: adding one would change what the
 * baseline spike's `list_files` returns and move the 12/20 this is compared
 * against. So the options live here instead. DOM is in `lib` because a model
 * that reaches for `console.log` shouldn't be handed "Cannot find name
 * 'console'" as if it were its own mistake.
 */
const TS_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", ".hearth"]);

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, out);
    else out.push(path.relative(root, full).split(path.sep).join("/"));
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, root, out);
  return out.sort();
}

/** The type-checking third of `get_errors`, on real files. Whole-program, like
 *  the app's `geterrForProject` — a file the model created and never imported
 *  is checked too, and one of the known failures is exactly that. */
function typeCheck(root: string, files: string[]): { status: CheckStatus; problems: Problem[] } {
  const roots = files.filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(root, f));
  if (roots.length === 0) return { status: "idle", problems: [] };

  const program = ts.createProgram(roots, TS_OPTIONS);
  const problems = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && d.start !== undefined)
    .map((d) => {
      const file = d.file!;
      const start = file.getLineAndCharacterOfPosition(d.start!);
      const end = file.getLineAndCharacterOfPosition(d.start! + (d.length ?? 0));
      return {
        file: file.fileName,
        // tsserver's positions are 1-based and so are these, once shifted.
        line: start.line + 1,
        column: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
        code: d.code,
        severity: d.category === ts.DiagnosticCategory.Warning ? ("warning" as const) : ("error" as const),
        text: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      };
    });
  return { status: "ok", problems };
}

function makeWorld(root: string, log: { getErrors: number; commands: string[] }): World {
  const resolve = (rel: string) => path.join(root, String(rel ?? ""));

  /** What the app's get_errors returns, through the app's own formatters. No
   *  dev server and no preview in a spike — which `devLogTail` and
   *  `consoleTail` say, rather than passing off as silence. */
  const report = async () => {
    const { status, problems } = typeCheck(root, await listFiles(root));
    return {
      blocking: status === "ok" ? problems.filter((p) => p.severity === "error").length : 0,
      output: [problemTail(status, problems, root), devLogTail("stopped", null, []), consoleTail(false, [])].join("\n\n"),
    };
  };

  async function run(name: string, args: any): Promise<string> {
    const rel = String(args?.path ?? "");
    switch (name) {
      case "list_files":
        return (await listFiles(root)).join("\n");
      case "read_file":
        return fs.readFile(resolve(rel), "utf8");
      case "edit_file": {
        const before = await fs.readFile(resolve(rel), "utf8").catch(() => null);
        if (before === null) return `error: ${rel} does not exist`;
        const { content, failures } = applyEdits(before, args?.edits ?? []);
        if (failures.length) return `edit_file failed, no changes applied:\n${failures.join("\n\n")}`;
        await fs.writeFile(resolve(rel), content, "utf8");
        return `applied edit(s) to ${rel}`;
      }
      case "write_file": {
        const target = resolve(rel);
        if (await fs.access(target).then(() => true, () => false)) {
          return `error: ${rel} already exists — write_file is for new files only, use edit_file to modify it`;
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, args?.content ?? "", "utf8");
        return `created ${rel}`;
      }
      case "search": {
        const query = String(args?.query ?? "");
        const needle = query.toLowerCase();
        const hits: string[] = [];
        for (const file of await listFiles(root)) {
          const body = await fs.readFile(resolve(file), "utf8").catch(() => "");
          body.split("\n").forEach((line, i) => {
            if (line.toLowerCase().includes(needle)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
          });
        }
        return hits.length > 0 ? hits.join("\n") : `no matches for "${query}"`;
      }
      case "repo_map": {
        const sources = (await listFiles(root)).filter(isSourceFile);
        return formatRepoMap(
          await Promise.all(
            sources.map(async (file) => ({
              path: file,
              symbols: exportedSymbols(await fs.readFile(resolve(file), "utf8").catch(() => "")),
            })),
          ),
        );
      }
      case "get_errors":
        log.getErrors++;
        return (await report()).output;
      case "run_command": {
        // The app puts an allowlist in Rust in front of this. Here the ceiling
        // is the timeout: the fixture is a throwaway temp dir, and porting
        // `check_command` to TypeScript would be a second copy of the rule to
        // keep in step — the drift this harness exists to avoid.
        // ponytail: timeout-only guard; port the allowlist if this ever runs
        // anywhere but a temp fixture.
        const command = String(args?.command ?? "");
        log.commands.push(command);
        const done = spawnSync(command, { cwd: root, encoding: "utf8", shell: true, timeout: 60_000 });
        return `exited ${done.status ?? -1}\n\n${(done.stdout ?? "") + (done.stderr ?? "") || "(no output)"}`;
      }
      default:
        return `error: unknown tool '${name}'`;
    }
  }

  return {
    dispatch: (name, args): Promise<ToolResult> =>
      run(name, args).then(
        (output) => ({ ok: !output.startsWith("error:") && !output.startsWith("edit_file failed"), output }),
        (err: Error) => ({ ok: false, output: `error: ${err.message}` }),
      ),
    verify: async () => {
      const { blocking, output } = await report();
      return { blocking, report: output };
    },
  };
}

export interface LoopLog {
  model: string;
  taskId: string;
  plan: boolean;
  iterations: number;
  trace: string;
  finishedVia: LoopResult["finishedVia"];
  repairRounds: number;
  getErrorsCalls: number;
  commands: string[];
  /** Type errors left when the turn ended; -1 if it ended without a verify. */
  remaining: number;
  /** The task's own runtime check — the score, same as the bare spike's. */
  verifyPass: boolean;
  verifyDetail: string;
  errorDetail?: string;
  wallMs: number;
}

async function runOne(model: string, task: Task, plan: boolean): Promise<LoopLog> {
  const start = Date.now();
  const slug = `${model}-${task.id}`.replace(/[^a-z0-9-]/gi, "_");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hearth-loop-${slug}-`));
  await fs.cp(FIXTURE_ROOT, root, { recursive: true });

  const log = { getErrors: 0, commands: [] as string[] };
  let result: LoopResult | null = null;
  let errorDetail: string | undefined;
  try {
    result = await appLoop({ model, root, task: task.prompt, world: makeWorld(root, log), plan });
  } catch (err) {
    errorDetail = (err as Error).message;
  }

  let verifyPass = false;
  let verifyDetail = errorDetail ?? "not verified";
  if (!errorDetail) {
    try {
      const v = await task.verify(root);
      verifyPass = v.pass;
      verifyDetail = v.detail;
    } catch (err) {
      // A verify that throws is a fail, not a crash: a file the model broke
      // badly enough won't import at all, and that is the result.
      verifyDetail = `verify threw: ${(err as Error).message}`;
    }
  }

  await fs.rm(root, { recursive: true, force: true });

  return {
    model,
    taskId: task.id,
    plan,
    iterations: result?.iterations ?? 0,
    trace: result?.trace.join(" → ") ?? "",
    finishedVia: result?.finishedVia ?? "max_iterations",
    repairRounds: result?.repairRounds ?? 0,
    getErrorsCalls: log.getErrors,
    commands: log.commands,
    remaining: result?.remaining ?? -1,
    verifyPass,
    verifyDetail,
    errorDetail,
    wallMs: Date.now() - start,
  };
}

/**
 * Two ways this harness scores every model as correct while measuring nothing.
 *
 * A model name that isn't pulled fails identically to one that can't hold the
 * loop. And a fixture that doesn't type-check clean makes `get_errors` report
 * errors the model didn't cause — so every task burns its repair rounds
 * chasing them, and the number this exists to produce is noise. Same failure
 * mode `check-tasks` guards for the verifies, and just as silent.
 */
async function preflight(models: string[]): Promise<void> {
  let local: string[];
  try {
    local = await listLocalModels();
  } catch (err) {
    throw new Error(`can't reach Ollama at ${OLLAMA_HOST} — is it running? (${(err as Error).message})`);
  }
  const missing = models.filter((m) => !local.includes(m));
  if (missing.length > 0) {
    throw new Error(
      `model(s) not pulled: ${missing.join(", ")}\n` +
        `  pull with: ${missing.map((m) => `ollama pull ${m}`).join(" && ")}\n` +
        `  locally available: ${local.join(", ") || "(none)"}`,
    );
  }

  const { status, problems } = typeCheck(FIXTURE_ROOT, await listFiles(FIXTURE_ROOT));
  const errors = problems.filter((p) => p.severity === "error");
  if (status !== "ok" || errors.length > 0) {
    throw new Error(
      `the untouched fixture does not type-check clean (status=${status}) — every task would be handed\n` +
        `errors the model didn't cause:\n${problemTail(status, errors, FIXTURE_ROOT)}`,
    );
  }
}

const argv = process.argv.slice(2);
const plan = !argv.includes("--no-plan"); // the app defaults PLAN on
const models = argv.filter((a) => !a.startsWith("--"));

if (models.length === 0) {
  console.error("usage: npm run loop-spike -- [--no-plan] <model> [model...]");
  process.exit(1);
}

await preflight(models);
console.log(
  `Hearth loop spike — the app's loop, PLAN ${plan ? "on" : "off"} — ` +
    `${models.length} model(s) x ${TASKS.length} task(s) = ${models.length * TASKS.length} runs\n`,
);

const logs: LoopLog[] = [];
for (const model of models) {
  for (const task of TASKS) {
    process.stdout.write(`  ${model} :: ${task.id} ... `);
    const log = await runOne(model, task, plan);
    logs.push(log);
    console.log(
      `${log.verifyPass ? "PASS" : "FAIL"} (${log.iterations} iter, ${log.wallMs}ms, via=${log.finishedVia}` +
        `${log.repairRounds ? `, repairs=${log.repairRounds}` : ""}` +
        `${log.remaining > 0 ? `, type_errors=${log.remaining}` : ""})`,
    );
    if (!log.verifyPass) console.log(`      ${log.verifyDetail}`);
  }
}

await fs.mkdir(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(RESULTS_DIR, `loop-${stamp}.json`);
await fs.writeFile(outFile, JSON.stringify(logs, null, 2), "utf8");

console.log("\n=== Summary ===\n");
console.log(
  `${"model".padEnd(20)} ${"pass".padEnd(12)} ${"used_errors".padEnd(12)} ${"repairs".padEnd(9)} ${"no_finish".padEnd(10)} ${"left_broken".padEnd(12)} ${"avg_iter".padEnd(9)} ${"avg_ms"}`,
);
for (const model of models) {
  const runs = logs.filter((l) => l.model === model);
  const n = runs.length || 1;
  const passed = runs.filter((l) => l.verifyPass).length;
  const usedErrors = runs.filter((l) => l.getErrorsCalls > 0).length;
  const repairs = runs.reduce((a, l) => a + l.repairRounds, 0);
  const noFinish = runs.filter((l) => l.finishedVia !== "finish_call").length;
  // The failure P9/P10 exist to prevent: a turn that ends with the project
  // still not parsing. `remaining` alone undercounts it — a turn that ends on
  // loop detection never reaches a verify — so a verify that threw counts too,
  // which is what a file too broken to import looks like from here.
  const leftBroken = runs.filter((l) => l.remaining > 0 || l.verifyDetail.startsWith("verify threw")).length;
  console.log(
    `${model.padEnd(20)} ${`${passed}/${runs.length} (${((passed / n) * 100).toFixed(0)}%)`.padEnd(12)} ` +
      `${String(usedErrors).padEnd(12)} ${String(repairs).padEnd(9)} ${String(noFinish).padEnd(10)} ` +
      `${String(leftBroken).padEnd(12)} ${(runs.reduce((a, l) => a + l.iterations, 0) / n).toFixed(1).padEnd(9)} ` +
      `${Math.round(runs.reduce((a, l) => a + l.wallMs, 0) / n)}`,
  );
}
console.log(`\nFull results: ${outFile}`);
console.log(`Compare against the bare P0 loop: npm run spike -- ${models.join(",")}`);
