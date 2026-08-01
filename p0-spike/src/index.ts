import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.js";
import { runOne, type RunLog } from "./harness.js";
import { listLocalModels, OLLAMA_HOST } from "./ollama.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, "..", "results");

// Tool-capable, locally pulled, and the one the measurements settled on: the
// previous default pair was qwen3-coder:30b and llama3.1:8b, which is the
// slowest model here (it spills to CPU) next to one that doesn't hold the loop
// at all. A no-argument run should score the model you'd actually use.
// Keep this in sync with what's installed — preflight() below fails loudly
// rather than letting a stale name read as "this model scored 0/20".
const DEFAULT_MODELS = ["gemma4:latest"];

function parseModels(): string[] {
  const arg = process.argv[2];
  if (!arg) return DEFAULT_MODELS;
  return arg.split(",").map((s) => s.trim()).filter(Boolean);
}

function pct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return `${((n / d) * 100).toFixed(0)}%`;
}

// A missing model fails identically to a model that can't hold the tool loop:
// every task errors out and the summary reads 0/20. Check up front instead.
async function preflight(models: string[]): Promise<void> {
  let local: string[];
  try {
    local = await listLocalModels();
  } catch (err) {
    throw new Error(
      `can't reach Ollama at ${OLLAMA_HOST} — is it running? (${(err as Error).message})`
    );
  }
  const missing = models.filter((m) => !local.includes(m));
  if (missing.length > 0) {
    throw new Error(
      `model(s) not pulled: ${missing.join(", ")}\n` +
        `  pull with: ${missing.map((m) => `ollama pull ${m}`).join(" && ")}\n` +
        `  locally available: ${local.join(", ") || "(none)"}`
    );
  }
}

async function main() {
  const models = parseModels();
  await preflight(models);
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
  console.error(`\nspike aborted: ${(err as Error).message}`);
  process.exit(1);
});
