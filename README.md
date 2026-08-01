# Hearth

A local-first AI coding IDE: editor, terminal, runner, preview and agent, all
running against models on your own machine. See the
[build plan](Hearth%20build%20plan.md) for the what and why, and
[PROGRESS.md](PROGRESS.md) for where the work currently stands.

The app lives at the repo root — a Tauri + React desktop app with a file tree,
Monaco tabs, terminal, dev server, preview, type checking, and an agent that
edits the open project ([`src/`](src) is the frontend, [`src-tauri/`](src-tauri)
the Rust side). P0–P14 have landed.

Alongside it, [`p0-spike/`](p0-spike) is a headless harness that scores a local
model on a multi-step tool loop, importing the app's own agent code from
`src/lib` so it can't drift out of step. P0 done.

## Prerequisites

- **Node.js 20+** and [pnpm](https://pnpm.io) (`corepack enable pnpm`)
- **Rust** (stable) — [rustup.rs](https://rustup.rs)
- **Tauri v2 system deps** — on Windows that's the WebView2 runtime (ships
  with Windows 11) and the MSVC build tools; on Linux/macOS see
  [Tauri's prerequisites](https://tauri.app/start/prerequisites/)
- **[Ollama](https://ollama.com)** — running, with at least one tool-capable
  model pulled (`ollama pull gemma4`). Needed by both the app's agent
  panel and `p0-spike`.

## Run the app

```bash
pnpm install && pnpm run tauri dev
```

First run compiles the Rust side and takes a few minutes; later runs are
seconds. Hit **Open Folder**, click a file, edit, **Ctrl+S** to save. The open
folder, tabs and unsaved drafts come back on the next launch.

**Run** starts any script in the project's `package.json` — the package manager
comes from the lockfile — and the preview pane shows the result with a URL bar,
viewport presets and the dev server's log. The bottom dock holds Problems,
Outline (or find-references, after Shift+F12), History, Project (`.env` and
dependencies) and the Terminal. **Ctrl+K** in the editor rewrites the selection
from an instruction, and **Ctrl+Shift+P** opens the command palette.

## Code with the model

**Open Folder** first — the agent works on the open project and refuses paths
outside it. Then hit **Agent**, pick a model, and ask for a change:

> add a `clamp(n, min, max)` helper to src/math.ts and use it in format.ts

It reads, edits and creates files itself, showing each tool call as a row you
can expand. Edits land on disk and the open tab updates in place; a file with
*unsaved* editor changes is refused rather than overwritten, so save or revert
before asking the agent to touch it.

Model choice is the whole experience, and it's mostly a VRAM question: a model
that fits runs on the GPU and answers in seconds, while one that doesn't falls
back to CPU and takes minutes per step — and a 12-step task pays that twelve
times. `ollama ps` reports the split (`100% GPU` vs a CPU share), which is
worth checking before blaming a model for being slow. Models that can't call
tools (anything tagged `-base`, embedding models) fail with an Ollama error
rather than misbehave quietly. Fitting is necessary and not sufficient: of the
models measured here, `gemma4` holds a multi-step tool loop and `llama3.1:8b`
and `devstral:24b` abandon the turn instead of finishing it — the tables in
[PROGRESS.md](PROGRESS.md) are the record.

The agent checks its own work rather than waiting to be told what broke.
`get_errors` hands it type errors from the TypeScript compiler, the dev
server's build output, and the running page's browser console — so a
misspelled `onclick`, which compiles and logs nothing, is caught alongside a
crash. It can also run the project's own tooling (`npm test`, `npx tsc
--noEmit`) through an allowlist, and find its way around with `search` and
`repo_map` rather than reading files one at a time. Every turn that changes a
file becomes a checkpoint you can diff, reject a hunk of, or roll back — from
the transcript or from the History tab, which outlives the chat.

Two switches under the composer. **Plan** (on by default) buys one extra call
per turn for a numbered plan before anything is touched, which is the biggest
single quality difference for a local model. **Ask first** (off by default)
shows every file write and every command — the change itself, not the tool's
name — and waits. It's off because checkpoints already make every turn
reversible. **Stop** aborts the call in flight, not just the next step.

`.env` files are redacted before the agent ever sees them: it gets the keys and
the value lengths, never the values. That's less about trusting the model than
about where a reply ends up — the transcript is stored and replayed as history
on every later turn.

```bash
pnpm test
```

runs the unit tests — path safety, search/replace, context sizing, log and
diagnostic parsing — plus one that drives a real `tsserver` end to end.
`cargo test --no-default-features` in `src-tauri/` covers the process and
framing layers against real shells, repos and servers.

To produce an installer instead:

```bash
pnpm run tauri build
```

## Run the P0 spike

Needs Ollama running with at least one tool-capable model pulled. It scores
each model on 20 real tasks against a throwaway copy of a toy repo — it applies
the model's edits and then executes the result, so a pass means the code
actually works.

```bash
cd p0-spike && pnpm install && pnpm run spike
```

Defaults to `gemma4:latest`. Override with a comma-separated list:

```bash
pnpm run spike -- "gemma4:latest,devstral:24b"
```

One run is not a score — this configuration ranges 8/20 to 14/20 on the same
model. Run it several times before comparing anything to anything.

`pnpm run loop-spike` runs the same 20 tasks through the *app's* loop instead —
real `get_errors`, a whole-program type check, PLAN and auto-repair rounds —
which is what says whether the safety net is worth anything. `pnpm run probe`
is the narrow, ~30s version that only asks whether a model checks its own work.

Models must already be pulled (`ollama pull <model>`) — the spike checks
before it starts and tells you what's missing. See
[p0-spike/README.md](p0-spike/README.md) for how to read the results.

**Note:** this repo's dev machine has 16 GB of VRAM (RTX 5080), so anything
much past ~14 GB — `qwen3-coder:30b` included — spills to CPU and drops to
minutes per turn. Check `ollama ps` mid-run: a model at less than 100% GPU is
measuring the fallback, not the model. See the P0 section of
[PROGRESS.md](PROGRESS.md).
