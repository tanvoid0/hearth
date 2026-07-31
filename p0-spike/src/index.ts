import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.js";
import { runOne, type RunLog } from "./harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, "..", "results");

const DEFAULT_MODELS = ["gpt-oss:latest", "qwen:latest"];

function parseModels(): string[] {
  const arg = process.argv[2];
  if (!arg) return DEFAULT_MODELS;
  return arg.split(",").map((s) => s.trim()).filter(Boolean);
}

function pct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return `${((n / d) * 100).toFixed(0)}%`;
}

async function main() {
  const models = parseModels();
  console.log(`Hearth P0 spike — ${models.length} model(s) x ${TASKS.length} task(s) = ${models.length * TASKS.length} runs\n`);

  const logs: RunLog[] = [];

  for (const model of models) {
    for (const task of TASKS) {
      process.stdout.write(`  ${model} :: ${task.id} ... `);
      try {
        const log = await runOne(model, task);
        logs.push(log);
        console.log(
          `${log.verifyPass ? "PASS" : "FAIL"} (${log.iterations} iter, ${log.wallMs}ms, via=${log.finishedVia}${
            log.malformedJsonCount ? `, malformed=${log.malformedJsonCount}` : ""
          }${log.failedDiffCount ? `, failed_diff=${log.failedDiffCount}` : ""})`
        );
        if (!log.verifyPass) console.log(`      ${log.verifyDetail}`);
      } catch (err) {
        console.log(`ERROR: ${(err as Error).message}`);
      }
    }
  }

  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(RESULTS_DIR, `run-${stamp}.json`);
  await fs.writeFile(outFile, JSON.stringify(logs, null, 2), "utf8");

  console.log("\n=== Summary ===\n");
  console.log(
    `${"model".padEnd(20)} ${"pass".padEnd(10)} ${"malformed".padEnd(11)} ${"wrong_tool".padEnd(11)} ${"failed_diff".padEnd(12)} ${"avg_iter".padEnd(9)} ${"avg_ms"}`
  );
  for (const model of models) {
    const runs = logs.filter((l) => l.model === model);
    const passed = runs.filter((l) => l.verifyPass).length;
    const malformed = runs.reduce((a, l) => a + l.malformedJsonCount, 0);
    const wrongTool = runs.reduce((a, l) => a + l.wrongToolCount, 0);
    const failedDiff = runs.reduce((a, l) => a + l.failedDiffCount, 0);
    const avgIter = runs.length ? (runs.reduce((a, l) => a + l.iterations, 0) / runs.length).toFixed(1) : "n/a";
    const avgMs = runs.length ? Math.round(runs.reduce((a, l) => a + l.wallMs, 0) / runs.length) : "n/a";
    console.log(
      `${model.padEnd(20)} ${`${passed}/${runs.length} (${pct(passed, runs.length)})`.padEnd(10)} ${String(malformed).padEnd(11)} ${String(wrongTool).padEnd(11)} ${String(failedDiff).padEnd(12)} ${String(avgIter).padEnd(9)} ${avgMs}`
    );
  }

  console.log(`\nFull results: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
