# Hearth

A local-first AI coding IDE: editor, terminal, runner, preview and agent, all
running against models on your own machine. See the
[build plan](Hearth%20build%20plan.md) for the what and why, and
[PROGRESS.md](PROGRESS.md) for where the work currently stands.

Two things live here today:

| | what it is | status |
|---|---|---|
| [`hearth-app/`](hearth-app) | the Tauri + React desktop app — file tree, Monaco tabs, terminal, dev server, preview, type checking, and an agent that edits the open project | through P9; P3/P4 partial |
| [`p0-spike/`](p0-spike) | headless harness that scores a local model on a multi-step tool loop | P0 done |

## Prerequisites

- **Node.js 20+** and npm
- **Rust** (stable) — [rustup.rs](https://rustup.rs)
- **Tauri v2 system deps** — on Windows that's the WebView2 runtime (ships
  with Windows 11) and the MSVC build tools; on Linux/macOS see
  [Tauri's prerequisites](https://tauri.app/start/prerequisites/)
- **[Ollama](https://ollama.com)** — running, with at least one tool-capable
  model pulled (`ollama pull llama3.1:8b`). Needed by both the app's agent
  panel and `p0-spike`.

## Run the app

```bash
cd hearth-app && npm install && npm run tauri dev
```

First run compiles the Rust side and takes a few minutes; later runs are
seconds. Hit **Open Folder**, click a file, edit, **Ctrl+S** to save. The open
folder, tabs and unsaved drafts come back on the next launch.

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
tools (base models, most Gemma builds) fail with an Ollama error rather than
misbehave quietly.

The agent checks its own work rather than waiting to be told what broke.
`get_errors` hands it type errors from the TypeScript compiler, the dev
server's build output, and the running page's browser console — so a
misspelled `onclick`, which compiles and logs nothing, is caught alongside a
crash. It can also run the project's own tooling (`npm test`, `npx tsc
--noEmit`) through an allowlist. Every turn that changes a file becomes a
checkpoint you can diff and roll back.

Not there yet: no approval prompt before a write (there are checkpoints
instead), and **Stop** ends the run after the current step rather than
interrupting it.

```bash
cd hearth-app && npm test
```

runs the unit tests — path safety, search/replace, context sizing, log and
diagnostic parsing — plus one that drives a real `tsserver` end to end.
`cargo test --no-default-features` in `src-tauri/` covers the process and
framing layers against real shells, repos and servers.

To produce an installer instead:

```bash
cd hearth-app && npm run tauri build
```

## Run the P0 spike

Needs Ollama running with at least one tool-capable model pulled. It scores
each model on 8 real tasks against a throwaway copy of a toy repo — it applies
the model's edits and then executes the result, so a pass means the code
actually works.

```bash
cd p0-spike && npm install && npm run spike
```

Defaults to `qwen3-coder:30b,llama3.1:8b`. Override with a comma-separated
list:

```bash
npm run spike -- "qwen3-coder:30b"
```

Models must already be pulled (`ollama pull <model>`) — the spike checks
before it starts and tells you what's missing. See
[p0-spike/README.md](p0-spike/README.md) for how to read the results.

**Note:** this repo's dev machine has 16 GB of VRAM (RTX 5080), so anything
much past ~14 GB — `qwen3-coder:30b` included — spills to CPU and drops to
minutes per turn. Check `ollama ps` mid-run: a model at less than 100% GPU is
measuring the fallback, not the model. See the P0 section of
[PROGRESS.md](PROGRESS.md).
