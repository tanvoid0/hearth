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
pnpm install
pnpm run spike -- "gemma4:latest,devstral:24b"
```

Defaults to `gemma4:latest` if no argument is given — the model the
measurements settled on. Any comma-separated list of locally-pulled Ollama
model names works — pull more with `ollama pull <model>` first (this is a
multi-GB download, so it's not run automatically). The run aborts up front if
Ollama isn't reachable or a named model isn't pulled, rather than reporting it
as a 0/20 score.

The model needs to support Ollama tool-calling. Base models (anything tagged
`-base`) and embedding models won't work.

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

20 small single- or multi-file tasks in `src/tasks.ts` — the build plan's
"20 tasks x 3 models": bug fix, empty-input guard, new function, local rename,
cross-file rename, and new-file-plus-export.

Run `pnpm run check-tasks` after touching `tasks.ts` or `fixtures/`: every task
must fail on an untouched fixture, or the spike scores every model as correct
and the table is the whole output.

## Reading the results

If a model can't close out most of these 20 tasks within 15 iterations
without tripping the malformed/wrong-tool/failed-diff counters, don't start
P1 — go fix the tool-calling setup (structured outputs, a stricter system
prompt, a different model) first. See build plan §9.

**One run does not give you a number.** Measured on gemma4, 13 of these 20
tasks flipped pass/fail across three runs of the same harness. Repeat a
configuration several times before believing a difference between two of them.

## The same tasks, through the app's loop

```bash
pnpm run loop-spike -- gemma4:latest        # --no-plan to drop the PLAN step
```

The spike above measures the model *without the app around it*: P0's five
tools, no `get_errors`, no type check, no auto-repair round. `src/loop-spike.ts`
runs the identical 20 tasks and the identical verify through the app's loop
instead, to say what P9 and P10 are worth.

The loop is shared with the probe below (`src/app-loop.ts`) and imported from
the app's `src/lib` — system prompt, tool definitions, PLAN step, history packing,
loop detection, finish verification and its repair cap. What this file supplies
is the *world*: real files in a temp dir, and a `get_errors` whose type-checking
third is a real whole-program check via the TypeScript compiler API, so it
catches a mistake the model actually invented rather than a canned one.

It aborts up front if the untouched fixture doesn't type-check clean — every
task would otherwise be handed errors the model didn't cause and burn its
repair rounds chasing them.

## The tool probe — a narrower, faster question

```bash
pnpm run probe -- gemma4:latest llama3.1:8b
```

The spike asks whether a model can hold a tool loop at all. `src/tool-probe.ts`
asks whether it follows the one instruction the error feedback loop depends on:
**after editing a file, does it call `get_errors` to check its own work?**

It runs the app's real tool loop — `src/app-loop.ts`, importing `TOOL_DEFS`,
`systemPrompt`, `applyEdits`, `stalled` and `devLogTail` straight out of
`src/lib`, so it can't drift out of step with what ships — against a
scratch React project, with `get_errors` canned to report a broken build on the
first call and a clean one afterwards. That makes the repair round
deterministic, instead of depending on talking a small model into writing a
syntax error.

The trace is the output worth reading:

```
edit_file → get_errors[1] → read_file → edit_file → get_errors[2] → finish
```

That's a model checking its work, seeing the error, re-reading, fixing, and
re-checking. Against:

```
edit_file
```

which is a model that edited blind, never looked, and stopped — with
`headingApplied: false` confirming the edit never landed. Ground truth is
checked on disk, because plenty of models narrate an edit they never applied.

One run per model, ~20s for something that fits in VRAM. Re-run it after any
change to the system prompt or the tool definitions — both live in
`src/lib/agent.ts`, and this is the only thing that catches a prompt edit
quietly costing you the feedback loop.
