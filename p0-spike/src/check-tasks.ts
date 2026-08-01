import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.js";

/**
 * Every task must fail on an untouched fixture.
 *
 * The failure mode this exists for is silent and expensive: a verify that
 * passes without the model having done anything scores every model as correct,
 * and the table it produces is the whole output of the spike. It breaks by
 * accident — someone fixes a bug in the fixture, or writes a task whose
 * assertion the starting code already satisfies — and nothing else would say
 * so.
 *
 * It can't prove a task is *possible*; that's what running a model against it
 * does. Run this after touching `tasks.ts` or `fixtures/`.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "..", "fixtures", "toy-repo");

const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "hearth-p0-check-"));
await fs.cp(FIXTURE_ROOT, workdir, { recursive: true });

const wrong: string[] = [];
const ids = new Set<string>();

for (const task of TASKS) {
  if (ids.has(task.id)) wrong.push(`${task.id}: duplicate id`);
  ids.add(task.id);
  // A verify that throws (the file it imports doesn't exist yet) is a fail,
  // which is the correct starting state for every create-a-file task.
  const result = await task.verify(workdir).catch(() => ({ pass: false, detail: "threw" }));
  if (result.pass) wrong.push(`${task.id}: passes on an untouched fixture — ${result.detail}`);
}

await fs.rm(workdir, { recursive: true, force: true });

console.log(`${TASKS.length} tasks`);
if (wrong.length > 0) {
  for (const line of wrong) console.error(`  ✗ ${line}`);
  process.exit(1);
}
console.log("all fail on an untouched fixture, as they must");
