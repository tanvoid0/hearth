# P0 — de-risk spike

Standalone harness, no UI. Feeds a local Ollama model a toy TypeScript repo
and a task, lets it call tools (`list_files`, `read_file`, `edit_file`,
`write_file`, `finish`), applies its edits to a throwaway copy of the repo,
then actually imports and runs the resulting code to check correctness.

This is the first gate in the [build plan](../Hearth%20build%20plan.md#8-phases):
if a local model can't reliably hold this loop, everything downstream (P1+)
is a UI wrapped around a broken engine.

## Run it

```bash
npm install
npm run spike -- "gpt-oss:latest,qwen:latest"
```

Defaults to `gpt-oss:latest,qwen:latest` if no argument is given. Any
comma-separated list of locally-pulled Ollama model names works — pull more
with `ollama pull <model>` first (this is a multi-GB download, so it's not
run automatically).

Each run gets a fresh temp-dir copy of `fixtures/toy-repo`, is capped at 15
tool-call iterations, and is torn down after verification. Results are
written to `results/run-<timestamp>.json` (gitignored) and a summary table
prints to stdout.

## What it measures

Per the build plan's own metrics (§8, P0):

- **Malformed JSON rate** — model emits tool-call-shaped text instead of a
  real tool call, or arguments that don't parse.
- **Wrong-tool rate** — model calls a tool name that doesn't exist.
- **Failed-diff rate** — `edit_file`'s SEARCH block doesn't match (exact or
  whitespace-normalised) so no edit is applied.
- **Task success** — after the loop ends, the edited file(s) are dynamically
  imported and exercised against real inputs/outputs. Not a text diff check —
  the code actually has to work.

## Tasks

8 small single- or multi-file tasks in `src/tasks.ts`: bug fix, empty-input
guard, new function, local rename, cross-file rename, and new-file-plus-export.
The build plan's checklist calls for "20 tasks x 3 models" — this is a
smaller first pass to validate the harness itself; widening `TASKS` and
`DEFAULT_MODELS` is cheap once the shape is proven out.

## Reading the results

If a model can't close out most of these 8 tasks within 15 iterations
without tripping the malformed/wrong-tool/failed-diff counters, don't start
P1 — go fix the tool-calling setup (structured outputs, a stricter system
prompt, a different model) first. See build plan §9.
