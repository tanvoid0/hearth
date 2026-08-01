# Hearth — Progress & Remaining Work

Status snapshot against the [build plan](Hearth%20build%20plan.md). Update this
after each phase lands — it's the "where are we" doc; the build plan stays
the "what and why" doc.

---

## Done

### P0 — De-risk spike ([p0-spike/](p0-spike))

Standalone harness, no UI: gives a local Ollama model a toy TS repo and a
task, applies its tool calls, actually runs the resulting code to verify
correctness. See [p0-spike/README.md](p0-spike/README.md) for how to re-run it.

**Result:**

| model | pass rate | notes |
|---|---|---|
| gpt-oss:latest (20.9B) | 7/8 | 0 malformed JSON, 1 wrong-tool call, 1 failed diff — holds a multi-step tool loop reliably |
| qwen:latest | 0/8 | doesn't support Ollama tool-calling at all |

**What's actually validated:** the tool loop. gpt-oss held a multi-step
loop with zero malformed JSON, which is the thing P0 existed to de-risk.

**The latency numbers from that run are void.** Single tasks took 2–9+
minutes, and this doc previously explained that with "the dev machine has no
GPU." That was wrong. The machine is:

| | |
|---|---|
| GPU | RTX 5080, 16 GB VRAM (16303 MiB), driver 610.62 |
| CPU | Ryzen 9 9950X (16C/32T) |
| Ollama | 0.32.5 |

Verified by `nvidia-smi` and by `ollama ps` currently reporting
`gemma4:latest` (9.6 GB) at **100% GPU**. So GPU inference works here today.

The `size_vram: 0` reading behind the old claim was real but misread. A
13-ish GB model on a 16 GB card that merely *didn't fit* would show partial
offload, not zero — a total fallback points at Ollama not driving the GPU at
all during that run (the 5080 is Blackwell/sm_120, which older Ollama builds
couldn't target). Either way it was a software/fit problem, not the ceiling
of this hardware, and every timing conclusion drawn from it needs re-measuring
before it's trusted.

**The constraint that does survive** is the 16 GB VRAM line, and it's a cliff
rather than a slope: models under it run on GPU, models over it fall back to
CPU and get an order of magnitude slower. `qwen3-coder:30b` (18 GB on disk)
sits above the line; `llama3.1:8b` (4.9 GB) and `gemma4` (9.6 GB) sit under
it — and `num_ctx` moves where a model lands, since KV cache comes out of the
same 16 GB. That makes build plan §6's "be honest when a model won't fit" the
opposite of hypothetical: this exact cliff is what produced a wrong finding
and sent the project chasing small models for the wrong reason.

### P1 — Shell + editor ([src/](src) + [src-tauri/](src-tauri)) — Milestone A

Tauri v2 + React + TypeScript + Vite + Tailwind, running locally
(`pnpm run tauri dev` from the repo root):

- Native folder picker (`tauri-plugin-dialog`) → lazy-loaded file tree
  (Rust `list_dir` command, skips `node_modules`/`.git`/`target`/`dist`)
- Monaco editor, self-hosted (no CDN — matters for an offline-first app),
  language workers wired via Vite `?worker` imports
- Multi-tab editing with dirty-state tracking (`●` vs `×` on each tab)
- Ctrl+S save (Rust `read_text_file` / `write_text_file` commands)
- Zustand store (`src/lib/store.ts`) holding project root, tree
  cache, open tabs

**Not yet in P1** (deferred to later Milestone-D phases per the plan, cheap
to add when we get there): command palette, split/diff view, find/replace,
breadcrumbs/symbol outline. The plan explicitly scopes those to P1's "1
week" budget but marks command palette as high-leverage — worth pulling
forward opportunistically rather than treating this as strictly done.

### Agent panel — first cut of P5/P6/P7

Built **out of plan order, on purpose**: the point of the project is coding
with a local model, so the shortest path to daily-driving it beat finishing
Milestone A first. The terminal, runner and browser (P2–P4) are still open.

What's in the app now (`Agent` button, right-hand panel):

- Model picker fed by Ollama `/api/tags`, remembered in `localStorage`
- Streaming chat — tokens render as they arrive, with a live elapsed counter:
  a turn that spills out of VRAM onto the CPU takes minutes, and a frozen
  panel is indistinguishable from a hang
- The P0 tool loop, in the app: `list_files` / `read_file` / `edit_file` /
  `write_file` / `finish`, capped at 12 steps, tool calls shown as expandable
  rows in the transcript
- Edits land on disk and immediately refresh the open tab and file tree
- Multi-turn conversation (history kept until **New**), **Stop** between steps

Design notes worth keeping:

- **Ollama is called from Rust, not the webview.** Ollama 403s the packaged
  app's `http://tauri.localhost` origin; it *would* have worked in
  `tauri dev` (origin `http://localhost:1420`) and broken only in the built
  app. `ollama_chat` streams NDJSON over a `tauri::ipc::Channel`.
- **The search/replace contract is the one P0 validated** — exact match, then
  whitespace-normalised, then fail loudly, all-or-nothing per file. Ported to
  [`src/lib/edit.ts`](src/lib/edit.ts), kept import-free
  so it's unit-tested directly (`pnpm test`).
- **The agent refuses to write a file with unsaved editor changes**, and says
  so to the model, rather than silently overwriting the user's work.

Not in this cut, deliberately: approval gates before writes, explicit
PLAN/ACT/VERIFY phases, model pull/unload and VRAM estimates,
markdown/code-block rendering in the transcript, mid-request cancellation
(Stop takes effect between steps, not inside an in-flight call).

### Prompt-first home — part of P14, pulled forward

Hearth no longer opens on an empty editor waiting for a folder. It opens on a
prompt box: describe what you want, and it creates the project, scaffolds it,
and hands your prompt straight to the agent as the first turn. The folder
picker stays as the escape hatch for existing repos.

- **Workspace directory** — one setting, defaulting to `$HOME/Hearth`,
  persisted with the rest of the session. Changeable from the home screen.
- **Projects are directories with a `.hearth/project.json` marker.** No
  registry file, no SQLite: the filesystem is the project list. The marker
  also stores the prompt that created the project, which is what the home
  screen shows under each name.
- **Grouping is nesting.** A subdirectory of the workspace *with* a marker is
  a project; *without* one it's a group, and its children get scanned instead.
  Two levels, which is the whole hierarchy — deeper than that is a file tree,
  not a switcher. `.hearth` was already in the tree's skip list, so the marker
  never shows up in the explorer.
- **Per-project chat.** Transcripts are keyed by project root in a separate
  store (and separate `localStorage` key) from the editor session, so
  switching projects switches conversations instead of carrying a system
  prompt that names the wrong root. The editor blob is rewritten on every
  keystroke; a transcript measured in hundreds of KB has no business being
  re-serialised that often.
- **Zero Rust changes.** `homeDir()` comes from `@tauri-apps/api/path`, and
  `write_text_file` already does `create_dir_all` on the parent — so writing
  the first scaffold file *is* the mkdir. Path joining reuses
  `resolveInProject` from the agent's own path handling.

**Why a template rather than an empty directory** — not a nicety. A local
model authoring `package.json` + vite config + entry + component into an empty
folder is a dozen-plus tool calls, and any one of them getting the wiring
subtly wrong breaks the project before the user sees anything. Editing a
known-good scaffold is the job P0 showed it doing well. One template for now (Vite + React, JSX not
TSX — no type errors to chase until P9 puts an LSP behind the agent); verified
end-to-end by scaffolding it to a temp dir and running `npm install &&
vite build` against it.

The project name is slugged from the prompt (`"Build me a todo app with dark
mode"` → `todo-app-dark-mode`), deliberately not model-generated: a model call
here would put a load-and-generate wait in front of a directory that doesn't
exist yet, for a name a regex gets right.

Not in this cut: group-creation UI (make a folder in the workspace and move a
project into it by hand), a recents list for folders opened from outside the
workspace, and a template picker while there's only one template.

### Run + Preview — minimal slice of P3/P4

Pulled forward immediately after the prompt-first home, because without it
"describe an app → get a project" stopped one step short of the payoff: you
could watch the agent edit a scaffold but had to leave Hearth to find out
whether it worked. **Preview** button, `Run`, and the page appears in-app.

- `run_dev(root)` in Rust: installs first if `node_modules` is missing, then
  starts the dev server, streaming both pipes to the frontend over a
  `tauri::ipc::Channel` — the same shape `ollama_chat` already uses.
- **Port is allocated by Rust, not parsed out of vite's banner.** Bind
  `127.0.0.1:0`, take what the OS gives, pass it with `--strictPort`. A port
  race then becomes a loud failure in the log instead of vite silently moving
  to another port that the preview would point away from.
- **Readiness is the `Local: http://…:PORT/` line, not process liveness.**
  Vite spends its first seconds optimising deps, and prints `ready in 431 ms`
  before it serves anything. The parsing rules live in
  [`runlog.ts`](src/lib/runlog.ts), import-free and unit-tested —
  including the case that matters most, `--strictPort`'s "Port 5399 is already
  in use", which names the right number while meaning the opposite.
- **Teardown kills the tree.** `npm run dev` on Windows is a cmd → cmd → npm →
  node → node chain; killing the head leaves vite alive holding the port,
  which is exactly the orphan problem plan §9 flags. `taskkill /T /F` on the
  head, plus a `CloseRequested` handler so quitting the window doesn't leak a
  server. Measured on this machine: `taskkill /T /F` on the head terminated
  all 6 processes in the chain and the port went back to unbound.
- Stopping is wired into project switching (`openFolder`, `closeProject`) —
  one server at a time, and it belongs to the project you're looking at.

Not in this cut: package-manager detection (npm only — pnpm/yarn lockfiles are
ignored), arbitrary script running, a URL bar, viewport presets, console and
network capture from the preview, and the full health-state machine (there's
`running` + a URL, not `stopped/installing/starting/ready/crashed`). No
terminal either — P2 is still untouched, and the agent still has no
`run_command` tool.

### The agent can see the runner — cheap third of P10

Run + Preview meant a broken build announced itself to the *user*, in a log
panel the agent couldn't read. The human was the error feedback loop,
copy-pasting vite failures back into chat. `get_errors` closes it: the tool
returns the dev server's status plus the tail of the log it's already
streaming into the runner store, and the system prompt tells the model to call
it after editing and fix what comes back.

- **Same tool name the plan uses at P10**, on purpose. It reads one source
  today (the dev server); LSP diagnostics and browser-console errors fold into
  the same tool at P9/P10 rather than arriving as a third and fourth tool the
  model has to choose between.
- **No error classifier.** Vite prints transform errors straight to stdout, so
  the tail already contains them; a regex deciding what "counts" as an error is
  one more thing to keep in step with vite's formatting.
- **Tail, not head** — a build error lands under thousands of `npm install`
  lines, so `LOG_CAP` (300 in memory) narrows to 40 for the model, with the
  omitted count stated rather than silently dropped.
- **"Not running" reads differently from "no errors."** Both would be an empty
  string, and a model that can't tell them apart reports a broken build as
  fixed — so the status line is always present and names which it is.

Parsing lives in [`runlog.ts`](src/lib/runlog.ts) with the rest of
the log rules, import-free and unit-tested.

Still the human's job: *starting* the server. `get_errors` says "ask the user
to press Run" rather than launching one itself — an agent that can trigger
`npm install` is a bigger blast radius than this slice is worth.

**Measured against real models, and the answer is that the model decides.**
The tool works; whether it gets *used* is a property of the model, not of the
prompt. Same task, same system prompt, tool result canned to report a broken
build on the first call and a clean one after:

| model | ran the loop | trace |
|---|---|---|
| gemma4:latest (9.6 GB) | 2/2 | `edit_file → get_errors → read_file → edit_file → get_errors → finish` |
| llama3.1:8b (4.9 GB) | 0/3 | `edit_file` (then stops, no tool call) |

gemma4 does the whole thing unprompted: edits, checks, sees the error, re-reads,
fixes, re-checks, finishes — and the heading change actually lands, in ~16–20s
at 100% GPU / `num_ctx` 8192 (confirmed with `ollama ps` during the run, so
these are GPU numbers, not a CPU fallback).

llama3.1:8b never calls `get_errors` at all. It also edits *before* reading,
which the same system prompt explicitly forbids, and its blind edit fails —
the file is unchanged at the end of all three runs. That's the more damaging
finding: it isn't that it skips the new tool, it's that it doesn't follow
multi-step tool instructions, which makes the ~2.4s-per-call speed that made
it attractive irrelevant.

The probe lives at [`p0-spike/src/tool-probe.ts`](p0-spike/src/tool-probe.ts)
(`pnpm run probe -- <model>`). It imports the app's real `TOOL_DEFS`,
`systemPrompt`, `applyEdits` and `devLogTail` rather than copies, so it can't
drift out of step with what ships — `systemPrompt` is exported for that reason.
It's narrower than the spike next door: that one asks whether a model can hold
a tool loop at all, this one asks whether it follows the one instruction the
feedback loop depends on. Re-run it after any change to the system prompt.

### VRAM split in the picker — P5's honesty requirement

The probe above made the case: model choice is the dominant variable, and the
picker showed name and disk size, neither of which tells you what a turn will
cost. `/api/ps` knows — it reports how much of a loaded model is resident in
VRAM — so the chat header now carries a badge reading `100% GPU` (green) or
the actual split (amber), with the shortfall in GB and the resolved `num_ctx`
in the tooltip.

- **Post-hoc, not predictive, on purpose.** Answering "will this model fit?"
  before loading needs total-VRAM detection; answering "did it fit?" needs one
  endpoint Ollama already serves. The second is most of the value for none of
  the work — the failure mode being prevented is *not noticing*, and the cliff
  announces itself on first load.
- **It polls only while a turn is in flight.** A model isn't loaded until the
  first call, so checking once before the turn always reports nothing; and
  during the turn is exactly when a spill is worth knowing, because the wait is
  the symptom.
- `ollama_models` and the new `ollama_ps` are now two one-line commands over a
  shared `ollama_get` helper.

Measured on this machine at `num_ctx` 8192, same task as the probe:

| model | disk | GPU split | turn | outcome |
|---|---|---|---|---|
| llama3.1:8b | 4.9 GB | 100% | 1–3s | edits blind, never checks, file unchanged |
| gemma4:latest | 9.6 GB | 100% | 16–20s | full edit→check→fix→re-check→finish |
| qwen3-coder:30b | 19.6 GB | **74%** (5.1 GB on CPU) | **227s** | same loop, and the only one that reads before editing |

So the cliff is real and now has a price on it: the 30B is the most careful of
the three and takes **~12× longer** than the model that does the same job
correctly. `gemma4` is the default this argues for. The badge is what stops the
74% row from looking like "big models are just slow."

### `num_ctx` is a control now, and the history respects it

`num_ctx` was hardcoded to 8192. It's a `<select>` in the chat header (4k / 8k /
16k / 32k, persisted in `localStorage`), because the values between powers of
two don't buy a drag gesture. No per-model ceiling is looked up — Ollama clamps
to what the model supports and the badge reports what it actually got, which is
a shorter path to the truth than `/api/show`.

The badge greys out and reads `74% GPU at 8k` when the setting no longer matches
the loaded model, rather than showing a reassuring number for a context that's
about to change. Ollama reloads the model when options change, so the loop
closes on its own: pick a bigger window, run a turn, watch the split move.

**Which exposed a live bug.** `HISTORY_BUDGET` is 200,000 chars — a
*localStorage quota* number that was also, silently, what got sent to the model.
That's ~50k tokens into an 8k window. Ollama handles overflow by dropping from
the front, and the front is the system prompt: after enough turns the agent
quietly stops being told to read before editing or to call `get_errors` — the
exact behaviour the probe exists to measure, decaying mid-session with nothing
in the UI to show for it.

`packHistory` already had the right contract for this (keeps the system prompt,
never leaves a tool result without its call) and was only being used for
storage. It's now applied to what's sent, at a budget derived from `num_ctx`,
and re-applied every iteration — a turn grows mid-flight, since one file read
can add 40k chars on its own.

That last part was the same bug through a second door: `MAX_READ_CHARS` (40k)
alone overflows a 4k or 8k window, so the new control would have been decorative
at exactly the settings where it matters most. One read is now capped at half
the window. Both numbers come from `contextLimits(numCtx)` in
[`session.ts`](src/lib/session.ts), which is import-free and
unit-tested — the sizing is the part that breaks silently if someone raises a
constant, so it lives where `pnpm test` can reach it.

### Total VRAM, and the fit predictor that shouldn't be built

The plan asks for a warning *before* a model loads, not just after. Building it
needs two inputs: total VRAM, and a model's expected footprint. The first is
easy — `nvidia-smi --query-gpu=memory.total`, shelled out rather than pulling in
an NVML crate for one number that would still only cover one vendor. Returns
`None` on anything else, and the UI just omits the figure.

The second input doesn't exist. Measured here, disk size and resident VRAM
aren't proportional:

| model | on disk | resident in VRAM | ratio |
|---|---|---|---|
| gemma4:latest | 9.61 GB | 3.37 GB | **0.35×** |
| qwen3-coder:30b | 18.56 GB | 19.61 GB | 1.06× |
| llama3.1:8b | 4.92 GB | 5.93 GB | **1.21×** |

A 3.5× spread across three models. Any predictor multiplying a `/api/tags` size
by a constant would tell you gemma4 needs ~10 GB when it needs 3.4 — steering
you off the best model on the machine. So there's no prediction anywhere in the
app: the badge tooltip reports `Using 3.4GB of 17.1GB VRAM`, both numbers
measured, and the pre-load warning stays unbuilt on purpose rather than as an
oversight. (17.1 rather than "16 GB" is the GB/GiB split — 16303 MiB. The app
reports decimal GB throughout, which is what `ollama list` and `/api/ps` use.)

### Unloading

The badge is a button. Clicking it drops the model from VRAM
(`/api/generate` with `keep_alive: 0`) instead of waiting out Ollama's idle
timeout — disabled mid-turn, since unloading during one kills it.

That exists because the badge created the problem it solves: switch models and
the old one stays resident for minutes, which on a full card is enough to push
the new one onto the CPU. The badge now shows that happening, so it needs to
also offer the way out — otherwise it's a dashboard light with no switch under
it.

### Pulling models — P5 complete

`+` in the chat header opens a name field; the pull streams progress and the
new model is selected when it lands. Closes P5.

- **Progress is summed across layers.** Ollama reports `completed`/`total` per
  layer, so a percent read off the newest chunk snaps back to 0% every time a
  layer starts. [`pull.ts`](src/lib/pull.ts) keys totals by digest
  and sums — import-free and unit-tested, like the other parsing modules. It
  can still appear to move backwards early on, because layers are announced as
  they begin rather than up front; that's what `ollama pull` does on the
  command line too, and it beats a bar that resets four times.
- **A bad model name arrives inside a 200 response**, as an `{"error": …}`
  chunk rather than a failed request — verified against the live endpoint, and
  the reason the pull row stays open showing the error instead of closing over
  it. The phases with no byte count at all (`pulling manifest`, `verifying
  sha256 digest`, `writing manifest`) are why the status text is shown next to
  the percentage rather than replaced by it.
- **`ollama_chat` and `ollama_pull` are now one `ollama_stream` helper**, since
  "POST, forward NDJSON to a `Channel`, let the frontend parse" was already the
  shape. Third use of that pattern, counting `run_dev`.

### Code blocks in the transcript — part of P6

The panel rendered every reply as one undifferentiated block of text, which is
the wrong shape for the output a coding model actually produces. Fenced code now
renders as a scrollable monospace block with a copy button, and inline
`` `code` `` gets a background.

- **Not a markdown parser, on purpose.** A coding model emits prose, fenced
  code and inline code; tables and nested lists are rare enough that pulling in
  remark/unified to cover them would cost more than it returns for an
  offline-first app. [`markdown.ts`](src/lib/markdown.ts) is a fence
  splitter — import-free and unit-tested like the other parsing modules. Reach
  for a real parser when something reads worse for its absence.
- **The streaming case is the normal case, not the edge case.** Tokens arrive
  one at a time, so the closing fence lands seconds after the code does — the
  last block is routinely unterminated. An open fence renders as code anyway;
  treating it as prose would make a reply flicker between styles as it streams
  and hide code until the very end. That's what `closed` on a segment is for,
  and it has its own test.
- Only ``` at the start of a line opens a block, so a sentence mentioning
  `` `useState` `` can't swallow the rest of the reply.

### P2 · Terminal

`Terminal` button, real shell in the project root: xterm.js in the webview,
`portable-pty` in Rust. Pipes can't back a prompt — without a TTY on the far
side a shell won't echo, won't line-edit, and won't emit the escape sequences
xterm renders — so this is a PTY, not another `run_dev`-style pipe.

- **The session manager is a map keyed by id, not a single slot.** Plan §4.3
  requires the agent's command execution to get a PTY of its own, separate from
  the user's; that's a second key here rather than a second implementation, and
  retrofitting the split later would be the harder job. The UI opens `"user"`.
- **Shell detection**: pwsh → Windows PowerShell → cmd, chosen by walking
  `PATH`. cmd always exists, so the chain can't come up empty.
- **Teardown kills the tree.** `stop_dev`'s Windows tree-kill is now a shared
  `kill_tree`, because whatever you last ran in a terminal is a child of the
  shell — killing the shell alone can leave a build running with nothing
  attached to it. Closed on project switch and on window close, alongside the
  dev server.
- **Toggling the panel hides it rather than unmounting it.** Unmounting kills
  the shell, so the toggle would silently discard your cwd, your history, and
  anything still running.
- **Resize goes both ways.** xterm reflows its own buffer, but a shell that
  hasn't been told the new width keeps wrapping at the old one, which reads as
  corruption rather than a layout bug.

**The framing problem is worse here than for NDJSON.** PTY output has no
newlines to resync on, so a read boundary lands mid-character routinely.
`take_utf8` drains the longest valid prefix and keeps a truncated tail for the
next read — and drops genuinely invalid bytes with a replacement character,
because waiting for a `0xFF` to become valid would freeze the terminal forever.
Byte-at-a-time test in the Rust suite.

**Found by testing rather than by guessing:** PSReadLine opens by asking the
terminal where the cursor is (`ESC [ 6 n`) and blocks until something answers.
xterm.js answers automatically, so this never shows up in the app — but the
first PTY test hung for 20 seconds on a completely silent shell until the probe
showed those four bytes were the only thing it ever sent. The test now answers
the query itself, and the comment records the failure mode: if the frontend ever
stops answering, pwsh hangs and the pane stays blank with no error anywhere.

**Tabs and scrollback search close P2 out.** The Rust manager was already keyed
by id, so tabs cost the UI and nothing else — `user:0`, `user:1`, … with
`AGENT_PTY` reserved outside that namespace for P7.

- **Ids are never reused.** A new tab taking a just-closed tab's id would
  attach to a PTY still being torn down, and `pty_open` replaces by id — so the
  counter only ever goes up.
- **Switching tabs hides, it doesn't unmount**, for the same reason toggling
  the panel does: unmounting closes the PTY, so tabbing away from a running
  build would kill it.
- **Search is `@xterm/addon-search`** rather than hand-rolled buffer walking.
  Ctrl+F is intercepted via `attachCustomKeyEventHandler`, which xterm would
  otherwise pass to the shell as a control character; Enter/Shift+Enter walk
  forward and back, Esc closes and hands focus back.

Still not in this cut: the agent's `run_command` tool — the PTY split it needs
exists now, but the tool itself is P7.

### `run_command` — P7's execution half

The agent can run the project's tooling now: tests, type checks, builds. Until
this, `get_errors` could tell it whether the dev server was unhappy but nothing
could tell it whether the test suite passed — the human was still the one
running things and pasting results back.

- **Piped, not a PTY, deliberately.** The terminal next door is a PTY because a
  shell needs one; this isn't, because a model reading test output wants plain
  text and a TTY makes tools emit colour and progress-bar escapes that are pure
  noise in a tool result. `NO_COLOR`, `FORCE_COLOR=0` and `CI=1` go further —
  the last one is what stops a watch-mode test runner from never exiting. Plan
  §4.3's "separate PTY for the agent" is about not colliding with the user's
  shell, which a separate process satisfies on its own.
- **An allowlist, not a denylist**, and it lives in Rust so a frontend mistake
  can't widen it. npm/pnpm/yarn/npx/node/deno/bun/cargo/tsc/vitest/jest/python,
  plus git restricted to verbs that only report — `push`, `reset`, `clean` and
  `checkout` destroy work this app can't recover. A local model that
  hallucinates a command runs it on the user's real machine, and
  "everything except the bad ones" needs the list of bad ones to be complete,
  which it never is.
- **Shell metacharacters are rejected outright**, which is what makes the
  allowlist mean anything: `npm test && rm -rf .` passes any check that only
  reads the first word. So does `./npm`, hence bare program names only. Four
  tests cover exactly these bypasses.
- **A timeout with a tree-kill.** 180s, then the process *tree* dies — killing
  `npm test` alone leaves the runner underneath holding the pipes open, so the
  output-draining threads would never finish and the turn would hang anyway.
  Both the happy path and the timeout are tested against real processes.
- **A non-zero exit is output, not an error.** The single most useful thing
  this tool does is report a failing test run; returning that as a thrown error
  would lose the failure text.
- Output is tailed to the same `contextLimits` budget as file reads (a build
  log ends with the error and begins with a banner), and the transcript row
  shows `$ npm test` rather than `run_command` — the user reading the transcript
  is the only check on what gets run.

The probe needed updating for this, not just the app: it imports the real
`TOOL_DEFS`, so once `run_command` existed there, a model calling it would have
got `unknown tool` back and skewed the very measurement the probe exists for.
It now answers with a real `spawnSync`. gemma4 still completes the loop
(18.5s, and it read before editing this time) and doesn't reach for
`run_command` on a task that doesn't need it.

### Command palette — the P1 deferral that was overdue

`Ctrl+P` opens files, `Ctrl+Shift+P` runs commands, `>` switches between them
mid-query. Flagged in the plan as "cheap to build, disproportionate UX payoff"
and in decision 4 below as worth pulling forward before P2 — it landed a phase
late, which is the cost of that decision never being taken.

- **Scoring is ~30 lines in [`fuzzy.ts`](src/lib/fuzzy.ts), not
  fuse.js.** Everything anyone wants from quick-open is "letters in order,
  prefer word starts, prefer the filename over the directories above it" —
  which is small enough to own, and owning it is what made the next point
  fixable.
- **A basename bonus is load-bearing, and a test caught its absence.** Without
  it `s/e/s/s.ts` outranks `src/lib/session.ts` for the query `sess`: every
  letter of the decoy sits just after a slash, so it collects the word-start
  bonus four times over and beats one solid adjacent run. The header comment
  had promised filename-preference from the start; the implementation didn't
  have it until the test failed.
- **Commands are built from the header buttons' own handlers**, not a parallel
  registry — a command that drifts from the button it mirrors is worse than no
  command.
- **The file list is walked on open, not cached.** The agent rewrites files
  continuously, so a stale index is worse than a short "Indexing…". Capped at
  5000 files and skipping the same directories as the tree; past that a repo
  wants a real index rather than a walk.

### Browser console → `get_errors` — P4's capture bridge, second third of P10

`get_errors` could read the build and nothing after it. The dominant failure of
model-generated React isn't a build error — vite compiles it happily and the
page throws on load, leaving a white rectangle that the user can't explain and
the agent can't see. The preview now forwards the running app's console into
the same tool.

- **The script is served, not injected.** The preview iframe is a different
  origin (`localhost:PORT` vs `tauri.localhost`), so Hearth can't reach into
  the document — the bridge has to arrive with the page. It lives in the
  template's `index.html` (`CONSOLE_BRIDGE` in
  [`workspace.ts`](src/lib/workspace.ts)), patching
  `console.error`/`warn` and listening for `error` and `unhandledrejection`.
- **Only scaffolded projects have it.** A folder opened from outside Hearth
  never posts, and `consoleTail` says "not connected" rather than "no errors" —
  the same distinction the dev-log half already made. Covering arbitrary repos
  means a vite plugin and a wrapped config; that's the upgrade path, marked in
  the code, not built.
- **Consecutive duplicates collapse to `(×N)`.** A render loop emits one
  message thousands of times, and without collapsing those *are* the 40 lines
  the agent gets. StrictMode's double-render makes this the common case, not
  the pathological one.
- **Marked, not cleared, on each agent write.** Clearing looks right and is
  wrong: Fast Refresh applies the edit a beat after the tool call returns, so a
  buffer emptied at write time reads back "clean" for a page still showing the
  old crash. Instead `consoleMark` records the buffer length at the write and
  the tail prints `── since your last edit ──`, so a stale error is visible and
  labelled rather than absent.
- The count also surfaces in the preview header as an amber badge — a runtime
  error produces a blank page *and* a silent dev-server log, so with the log
  drawer collapsed there was otherwise nothing at all to notice.

Parsing and the tail format live in [`runlog.ts`](src/lib/runlog.ts)
with the dev-log rules, import-free and unit-tested.

**Verified in a real browser**, not just in unit tests: the template scaffolded
to a temp dir, `App.jsx` broken with an undefined reference, and the page loaded
inside a harness iframe. What came back over `postMessage`:

```
error: Uncaught ReferenceError: missingThing is not defined (…/src/App.jsx:20)
```

plus the React error-boundary warning, the unhandled rejection, and the
StrictMode-duplicated `console.warn` that `pushEntry` collapses. React's own
`console.error` calls arrive with their `%s` placeholders unsubstituted —
cosmetic noise in front of a message that still reads correctly, and not worth a
format-string implementation.

**The system prompt changed**, so the P10 probe result above is stale until
`pnpm run probe` is re-run — it now tells the model `get_errors` covers the
browser too.

**One bug fell out of it.** llama3.1:8b sends `edits` as a bare
`{search, replace}` where the schema asks for a list. `applyEdits` iterated it
with `.entries()`, threw, and the model got back
`error: edits.entries is not a function` — an error it can't act on, burning
steps against the 12-cap. Fixed by coercing in `applyEdits` itself, which is
where every caller routes through, rather than at the `dispatchTool` call site.

### P8 · Diff review — checkpoints via git

The agent writes straight to disk. Until this, the only record of a turn was the
tool rows in the transcript, which name files but not what changed inside them —
and nothing at all put a file back. Every turn that changes something is now a
commit, each one a card in the timeline: click a file to see the diff, click
Restore to roll the project back to it.

Plan §7's answer, taken literally — don't build a versioning system. "Show me
the diff" is `git show`, "put it back" is `git reset --hard`.

- **A separate git dir, not the project's `.git`.**
  `--git-dir=<root>/.hearth/git --work-tree=<root>` on every call, so Hearth's
  checkpoints and the user's own commits never see each other. `.hearth` was
  already in both skip lists, so the repo shows up nowhere in the UI.
- **The baseline commit is what makes the first card readable.** `ensureRepo`
  runs before a turn rather than at project creation: a project the agent never
  touches never gets a repo, folders opened from outside the workspace get one
  too, and without a baseline the first checkpoint's diff would be the whole
  project instead of the turn's changes.
- **`node_modules` is excluded through `info/exclude`, not a `.gitignore`** —
  writing a `.gitignore` into the user's project is a change they didn't ask
  for. The project's own ignore rules apply on top, since they sit in the work
  tree.
- **`git show`, not `git diff <sha>~ <sha>`.** The root commit has no parent,
  and that's the one every new project starts with.
- **A missing side reads back as empty.** A file the commit created has no
  `<sha>~:<path>`, and git says so with an exit code rather than empty output —
  the distinction `fileVersions` leans on, and what makes the diff render as a
  whole-file addition rather than a mystery.
- **Restore leaves untracked files alone.** `reset --hard` doesn't touch them,
  so rolling back doesn't cost an `npm install`. It does discard everything
  committed after the checkpoint, hence the confirm — and a note afterwards,
  because the conversation still describes files that no longer look like that
  and nothing tells the model the ground moved.
- **`core.autocrlf false` at init.** Without it, restoring on Windows rewrites
  every line ending in the project — a diff against the user's *own* git for
  files git never touched.
- **Checkpointing is wrapped and non-fatal.** git can be missing entirely; a
  failed commit costs the review, not the turn that produced the changes.

The Rust `git` command has no allowlist, unlike `run_command`: its args come
from [`git.ts`](src/lib/git.ts) and never from the model, and the
write verbs `check_command` exists to refuse are the entire point. They arrive
as a list, so there's no shell to escape. `stdout` and `stderr` come back
separately — `run_command` merges them, but this one carries file content, and a
merged stream would splice git's warnings into the middle of a file.

**Verified end-to-end against a real repo** in the Rust suite (`cargo test
checkpoints`): init → baseline → a turn's commit → name-status → both sides of
one file → rollback, including that `node_modules` survives the rollback and
that a turn changing nothing produces no card. Rename parsing is tested
separately in [`gitdiff.ts`](src/lib/gitdiff.ts) — `R100→old→new` is
three tab-separated fields, and taking the second gives a path that doesn't
exist at that commit, so every lookup would come back empty and the diff would
read as a whole-file deletion.

Not in this cut: accept/reject per hunk, and editor decorations during agent
writes. Hunk-level reject is `git apply -R` of one hunk out of `git diff` —
cheap to add; what's missing is a reason to prefer it over restoring the
checkpoint, given the edits have already landed by the time the card exists.
Per-file revert is the more likely next step ("it broke App.jsx, the other three
are fine"), and it only reads sensibly on the newest checkpoint.

### P9 · LSP + Problems

Type errors now exist in Hearth — in the editor as squiggles, in a Problems
panel, and in the agent's `get_errors`. Plan §4.5 calls this "the biggest single
quality jump for both the human experience and the agent's error loop" and says
don't defer it past P9; this is that.

**It talks to `tsserver` directly rather than running
`typescript-language-server`,** which plan §2 names. That wrapper wraps exactly
this process, `typescript` was already a dependency here, and Monaco doesn't
speak LSP either — so the wire format has to be translated into Monaco's shapes
whichever end you start from. Going direct removes a dependency and a
translation layer and adds nothing to write. It's also what VS Code's own
TypeScript support does.

- **Rust owns the framing, the frontend owns the protocol** — the same split as
  `ollama_stream`, `run_dev` and the PTY. Fourth use of that shape. The framing
  is asymmetric and nothing in the type system says so: newline-delimited JSON
  going in, `Content-Length`-framed going out. A header with no length is
  dropped rather than waited on, because it can never become valid and waiting
  would stall every message behind it — the trap `take_utf8` already avoids for
  bytes.
- **The project's own TypeScript wins** when it has one: that's the version its
  code was written against. Otherwise Hearth's, found by walking up from the
  working directory.
- **Monaco's built-in TypeScript worker had to be switched off**, not just
  ignored. It runs in the browser with no filesystem, so it reports "Cannot find
  module 'react'" on every import in every file — squiggles that were already
  there before this phase. Two sets where one is always wrong is worse than
  either alone. `setModeConfiguration` turns off the four providers being
  replaced and keeps completions and formatting, which it does fine. Note
  `monaco.typescript`, not `monaco.languages.typescript`: 0.56 moved these to a
  top-level namespace and left the old path as a stub that type-checks as
  `{ deprecated: true }`.
- **Whole-document `change`, not a diff.** tsserver tracks an open file as a
  buffer, so edits arrive as ranges — and the range has to describe what
  tsserver currently believes, not what the editor now shows. Replacing
  everything from the content last sent keeps them in step without diffing.
  Off by one here and the buffer desynchronises permanently, putting every later
  diagnostic, hover and definition on the wrong token, which is why
  `fullReplaceRange` is unit-tested and then tested again against the real
  server.
- **Diagnostics are keyed by file *and* kind.** One `geterr` emits a separate
  event per kind, each complete for that kind. Keyed by file alone the semantic
  pass arrives second and wipes the syntax errors that arrived first — a file
  with a stray brace reads as clean.
- **`geterrForProject`, not just the open files**, for the agent's check: an
  edit in one file breaks another, and that's the whole reason to have a
  compiler rather than a linter. Verified reporting errors in a file that was
  never opened.
- **Type checking happens on the buffer, before a save.** Squiggles appear as
  you type, and the agent's project check reflects unsaved editor state — which
  is consistent with its existing refusal to write over a dirty tab.
- Go-to-definition across files opens the target tab and lands the cursor there.
  Monaco can only navigate to a model it already holds, and this app builds one
  per open tab, so the jump is stashed on the store and applied when that tab's
  editor mounts — the editor that started it has been unmounted by then.
  `navtree` feeds a document-symbol provider, which is Ctrl+Shift+O for free;
  the outline panel and breadcrumbs plan §4.1 also asks for can hang off the
  same provider whenever there's somewhere to put them.

**The scaffold changed, because otherwise none of this fires.** Measured, not
assumed: a JS project with no `tsconfig`/`jsconfig` gets filed under an inferred
project and reports **zero** diagnostics — indistinguishable from a clean one.
The template now ships a `jsconfig.json` with `checkJs`, plus `@types/react`
and `@types/react-dom` — without React's types every JSX file stops at "Cannot
find module 'react'" before reaching a real mistake. On a scaffold broken four
ways, what comes back:

```
13:15 [2322] Property 'onclick' does not exist on type '…ButtonHTMLAttributes…'. Did you mean 'onClick'?
14:11 [2304] Cannot find name 'missingThing'.
15:28 [2554] Expected 0-1 arguments, but got 2.
```

That first one is the case that justifies the whole phase: `onclick` compiles,
runs, logs nothing, and produces a button that silently does nothing. Neither
the build nor the browser console can see it. The second is the *exact* runtime
crash the P4 console bridge was verified against — now caught before the app is
run at all.

**"Not checked" and "no errors" are different answers**, and this is the third
place that rule has had to be enforced (after `devLogTail` and `consoleTail`).
There are four states, because a model that can't tell them apart reports an
unchecked project as a fixed one: no server, no config, nothing checked yet, and
actually clean.

Parsing and the agent's view live in
[`problems.ts`](src/lib/problems.ts), import-free and unit-tested like
the other parsing modules; the client is [`lsp.ts`](src/lib/lsp.ts)
and the editor wiring [`monaco-ts.ts`](src/lib/monaco-ts.ts).

**That split is load-bearing, not tidiness.** Monaco dies on
`window is not defined` under plain node, and the P10 probe imports `agent.ts`
— which now reaches the language server for `get_errors`. Importing Monaco
anywhere in that graph breaks the probe, so `monaco-ts.ts` subscribes to the
store instead of being called by it.

**Verified against the real server at three levels**, because hand-written
diagnostic fixtures are exactly where a parser's assumptions go unchallenged:
the Rust suite spawns tsserver the way `ts_start` does and reads a real
diagnostic back (`cargo test tsserver`); `problems.live.test.ts` drives the full
open → check → change → re-check sequence through the app's own parser and
asserts on the string the agent actually reads, including that a fix in an
unsaved buffer clears it; and the built frontend was loaded in a browser to
confirm the moved `monaco.typescript` namespace resolves at runtime.

**The probe was updated, not just re-run.** Its `get_errors` returned only the
dev log while the app's returns three sources — the drift it exists to prevent.
It now composes the same three formatters. gemma4 with the new prompt:

| model | trace | wall | heading applied |
|---|---|---|---|
| gemma4:latest | `read_file → edit_file → get_errors[1] → edit_file → get_errors[2] → finish` | 13.1s | yes |

Reads before editing, checks, repairs, re-checks — and faster than the 16–20s
recorded before, on a longer tool result.

Not in this cut: an outline panel and breadcrumbs, rename refactor, and
find-references — all three are requests away now that the client exists, and
all three want UI that doesn't exist yet. Nor is there a bundled `tsserver.js`
for a packaged build: it's found by walking up from the working directory, which
works under `tauri dev` and finds nothing in a packaged app. That reports as
"unavailable" rather than as a clean project, and the fix is a Tauri resource at
packaging time — marked in the code.

### P10 · Auto-repair rounds and loop detection

`get_errors` gave the agent eyes; this makes it use them whether it wants to.
Calling `finish` now re-checks the project, and a finish that doesn't hold up is
handed the errors and bounced — up to 3 rounds, which is plan §6's number.

- **The repair hangs off `finish`, because that's the claim being tested.** The
  model saying "done" is the assertion; verifying is checking it. Nothing else
  in the loop is a claim about the end state.
- **Only what can be counted honestly counts as blocking.** Type errors and
  browser-console errors are unambiguous. The dev server's output deliberately
  has no classifier — that decision is recorded in `devLogTail` and it still
  holds — so a build error doesn't trigger a repair round on its own. It's still
  in the report the model is handed, and in practice a build that won't compile
  shows up as a type error too, so this loses less than it looks.
- **Loop detection keys on the call *and* its result**, not the call alone.
  Repetition by itself is the behaviour this app wants: checking errors four
  times across four edits is the loop. What means something is the same call
  returning the same answer, because then nothing changed between them — three
  of those and the turn stops. Without it, a model that can't fix an error
  spends every remaining iteration retrying the edit that already failed.
- `MAX_ITERATIONS` went 12 → 15, plan §6's "max ~15": a repair round spends
  iterations like anything else, and the cap has to leave room for the ones the
  repair budget allows.

**Measured, and it found the hole in its own design.** Same probe, both models:

| model | trace | repair rounds | heading applied |
|---|---|---|---|
| gemma4:latest | `read_file → edit_file → get_errors → edit_file → get_errors → finish` | **0** | yes |
| llama3.1:8b | `edit_file` → *stops* | **0** | no |

gemma4 needs no repair rounds — it verifies before claiming, which is what the
prompt asks for, so the cap never engages. That's the shape a working model has.

llama3.1:8b's zero means the opposite, and it's the finding: **it never calls
`finish` at all.** It makes one blind edit, the edit fails, and it stops
replying — so a brake bolted to `finish` never fires. The auto-repair round
cannot rescue a model that abandons the turn instead of finishing it.

So the no-finish exit verifies too, and *reports* rather than repairs. Bouncing
it would be wrong: a model that stops may be asking the user a question, and
answering a question with a build log is worse than useless. But a turn that
changed files and then trailed off is the most common way a weak model fails,
and the user was otherwise left believing it worked — the transcript now says
`stopped without finishing — N error(s) still reported`. Gated on having
actually written something, so a conversational reply doesn't pay for a
project-wide type check.

The probe mirrors the new `finish` verification rather than only being re-run
against it — otherwise it would be measuring a loop the app no longer runs. Its
canned world grew the two flags that need: whether the model has been *told*
about the error (by `get_errors` or by a bounce, which carry the same
information) and whether it edited afterwards.

Not in this cut: PLAN/GATHER as explicit phases. Plan §6 calls the PLAN step
"the biggest quality lever for local models", and it's the remaining half of
P7 rather than of this phase.

---

### P3 · Runner, finished

npm was hardcoded and so was `dev`. Both are now read from the project.

The package manager comes from the **lockfile**, not from a preference or a
`packageManager` field. That's the file that decides whether the install the
user already did counts: running `npm install` in a pnpm project doesn't just
pick the wrong tool, it writes a second lockfile and a `node_modules` layout
the project's own scripts don't expect. npm is the fallback because every Node
install has one.

Any script in `package.json` can be started, and the port flags only go on when
the script is actually a vite dev server — `--port --strictPort` handed to `npm
run build` is an error, and a build script parked at "starting" waits forever
for a URL nothing will print. The check is the script's command text, which is
also what decides whether the generated bridge config gets passed.

Run state is a machine rather than a boolean:
`stopped/installing/starting/ready/crashed/port-conflict`. The distinction that
earns it is **installing vs starting**: a cold install runs for minutes with no
output a user reads as progress, and "starting…" over the top of it is what
makes a working app look hung. Rust emits `[hearth] phase:*` lines for the two
it can tell apart; everything else the frontend derives from the output it was
already parsing. A port conflict keeps its own state rather than being
overwritten by the exit it causes, because it's the one failure that pressing
Run again fixes — the port is allocated fresh each time.

The agent sees the same states. `crashed` and `stopped` both used to arrive as
"dev server not running", which reads as *nobody pressed Run* — so a server the
agent's own edit had just killed looked like one that was never up.

### P4 · Browser, finished

- **URL bar** over the path only. The origin is the runner's and changes every
  run, so it isn't the user's to type. There's no reading back where the page
  navigated itself to — the iframe is a different origin, and that's the same
  wall every other item here ran into.
- **Viewport presets** as widths (375/768/1280). No device frame: the height is
  whatever the pane has, and a letterboxed phone outline costs vertical space to
  say nothing.
- **Network capture** in the bridge, reported as `net` rather than `error`. A
  404 from an API the user doesn't control is not the agent's bug to fix, and
  counting it as one would spend every auto-repair round on somebody else's
  server. No timing in the text, so a poll collapses into one line with a count
  instead of filling the buffer.
- **The bridge for projects Hearth didn't scaffold**, which was the real gap.
  Hearth writes `.hearth/vite.hearth.mjs` before each run — a config that finds
  the project's own with `loadConfigFromFile` and merges a `transformIndexHtml`
  plugin into it. The alternative was writing the snippet into the user's
  `index.html`, which is a change to their repo they didn't ask for and would
  have to keep deleting. Regenerated every run so it can't go stale against the
  bridge source, and it can't find itself because `.hearth/` isn't a name vite
  searches. Still vite-only: a Next or webpack project runs fine and
  `consoleTail` still says the bridge isn't connected.

### P11 · Search and the repo map

Two ways to find things without reading files one at a time.

`search` walks the tree in Rust — literal, case-insensitive, skipping the same
directories the file tree does. Deliberately not ripgrep: the binary isn't
something an offline-first app can assume is installed, and a regex crate is a
dependency for a feature whose job is finding a name someone already knows how
to spell. Regex is the upgrade path if literal search turns out not to be
enough.

`repo_map` lists exported symbols per file, by regex rather than by asking
tsserver. That's the surprising half, and it's a deliberate trade: the map
covers every source file, and asking the language server would mean opening all
of them — a cold project-wide load taking tens of seconds, holding every file in
memory afterwards, to answer a question that doesn't need types. The map says
what exists and roughly where; the agent reads the file when it needs to be
right.

### P7 · PLAN, approval gates, and cancellation that works

**PLAN** is one tool-free call before the loop. Tool-free is the point: a model
handed tools uses them, and what's wanted here is the thinking that otherwise
happens one tool call at a time and gets re-derived from scratch every time the
context window trims. Plan §6 calls it the biggest quality lever for local
models; it costs one extra call per turn, which is why it's a switch (default
on) rather than a law.

**Approval gates** show the change itself — the search/replace pairs, the file
content, the command — not the tool's name, because a gate that only names the
tool is one you learn to click through. Reads aren't gated: a prompt on every
`read_file` is a prompt nobody reads by the third turn, and reads are what a
model has to do a lot of to be any good. Refusing one call doesn't end the turn;
the model is told no and decides what to do instead, which is what makes it
different from Stop. A refusal counts toward loop detection, so a model that
asks three times gets stopped rather than asking forever. Default off, because
checkpoints already make every turn reversible.

**Stop** now aborts the call in flight. A flag checked between steps was no help
in the case Stop exists for: the longest wait in a turn is the one *before* the
first token, while Ollama loads a model, and on a model that spilled to CPU
that's minutes. The Rust side selects over a cancel channel, so the request
future is dropped and the connection closed — Ollama stops generating rather
than generating into a void.

### P8 · Reject per hunk, and seeing what the agent wrote

Rejecting a hunk goes through `applyEdits` — the agent's own search/replace
matcher — rather than applying a patch by line number. The hunk parser
reassembles both whole sides including context, which turns a revert into
`{ search: after, replace: before }`. It inherits the whitespace tolerance and,
more importantly, the refusal to fuzzy-apply: if the file moved on since the
checkpoint, the revert fails loudly instead of putting the wrong lines back.
There's no second patch-application path to keep correct.

It edits the working file, not the commit. The checkpoint is history and stays
as it is; what's being asked is "keep the turn, minus this part".

Lines the agent wrote are marked in the editor until you type there yourself.
The span is computed by trimming the common prefix and suffix rather than
running a real diff — for a decoration, the honest answer to "which lines" is
the span that changed.

### P9 · Rename and find-references

Both ran into the same wall from opposite sides: **Monaco can only edit, and can
only display, models it holds** — which here means open tabs.

For rename that would mean renaming the symbol in the two files you happen to be
looking at and quietly leaving the rest of the project on the old name, which is
worse than no rename at all. Files that aren't open are rewritten on disk, spans
applied last-first so the earlier ones keep their offsets.

For references it would mean showing the ones in open tabs and omitting every
other one — the wrong half of the answer, since references in a file you haven't
opened are exactly the ones worth finding. So Monaco's reference provider stays
off and Shift+F12 is an editor action that fills a dock panel instead. That
panel doubles as the symbol outline, which closes P1's last deferral: both are a
list of places to jump to and differ only in how the list was chosen.

### P13 · The checkpoint timeline

`.hearth/git` has held every turn since P8; what was missing was any way to
reach one that wasn't the card in the transcript. Clearing the chat hid history
git still had, and a previous session's turns were unreachable entirely. The
History tab reads the log directly — expand a checkpoint for its files, click
one for the diff, Restore to roll the tree back.

Not the staging/branching UI §13 also lists. That surface is the **user's** repo,
not Hearth's checkpoint repo, and putting both behind one "Source control" tab
makes it very easy to reset the wrong one.

### P12 · Inline edit and the element picker

Ctrl+K rewrites the selection, or the current line when there's no selection.
One tool-free call, not an agent turn: the loop exists to find things and check
its own work, and neither applies when the user has already pointed at the code
and is watching the result land. Nothing is written to disk — the replacement
goes into the editor buffer, so Ctrl+Z undoes it and it only reaches the file on
save, which is also why it needs no approval gate. The reply is unfenced before
it's pasted: models fence code whatever the instruction says, and a stray ```` ``` ````
in the middle of a source file is the worst failure available here.

The element picker lives in the console bridge, for the same reason the console
patch does — the iframe is a different origin, so the parent can't attach a
listener to the page. Capture-phase listeners, so a button's own `onClick`
doesn't fire and navigate away from the thing being pointed at. What you click
goes into the composer rather than straight to the agent: the element is the
subject of a request, not the request.

Not built: **FIM completion**. It needs per-model prompt templates and a
mid-typing latency budget a local model doesn't have, and nothing else in the
phase depends on it.

### P14 · Templates, secrets, dependencies

The `.env` work has two halves and the invisible one matters more. `read_file
.env` handed the model every key the project has — and that reply goes into the
transcript, which is written to `localStorage` and sent back as history on every
subsequent turn. Reads and search hits from a `.env` file are now redacted to
keys and value lengths. Keys are kept deliberately: the agent legitimately needs
to know which variables exist, and answering with nothing sends it guessing at
names. Committed `.env.example` files are left alone, since placeholders are the
only thing they exist to show.

The panel is the visible half — values masked until asked for, editable in
place. A write changes one line and leaves comments and ordering alone;
rebuilding the file from parsed entries would be shorter and would silently
delete every comment in it. Short values are blanked entirely rather than
half-shown, because four characters of an eight-character secret is most of a
secret.

The dependency list shares that tab. Both answer the same question from two
sides — what is this project wired up to — and a panel per list is how a bottom
dock ends up with eight tabs nobody can find anything in.

A **vanilla template** alongside the React one: same runner, preview and type
checking, with nothing between the file and the page. Two, not ten — a starter
nobody picks is a starter nobody maintains, and the agent's first job on any of
them is to replace most of it anyway.

### Install-on-demand — the one plan item nobody had decided against

Build plan §4.2 asks the runner to notice a package that isn't installed and
offer to install it; §9 lists it as *the* mitigation for hallucinated imports,
which is the failure local models produce most. It was the only item in the
plan that had neither been built nor argued out of, so it's built: an amber
`+ install lodash` chip in the preview header, one click, page reloads.

- **It goes through `run_command`**, not a new Rust command — so the allowlist,
  the shell-metacharacter refusal, the timeout and the tree-kill that guard the
  agent's commands guard this too. The one new command is `package_manager`,
  which is `detect_pm` behind a `#[tauri::command]`: the lockfile rule stays in
  one place rather than being re-implemented in TypeScript.
- **`add`, not `install`.** It's the only spelling pnpm, yarn and bun share, and
  npm aliases it. One verb instead of a branch per manager.
- **The name is validated against npm's own rule at the point it's parsed**,
  which is what makes it safe to put on a command line — the string arrives from
  a subprocess's stdout, and `--registry=http://evil` reads exactly like a
  package name until something checks.
- **Bare specifiers only.** A relative import that won't resolve is a file the
  model hasn't written yet; installing a package named after it would be worse
  than doing nothing. `node:`/`virtual:` schemes and Windows paths fall out of
  the same name check rather than needing cases of their own.

**Measured against vite 7.3.6 rather than remembered, and two of three guesses
were wrong.** The strings in the tests are copied from a real run:

| when | what it prints |
|---|---|
| dev server startup | `  lodash (imported by C:/…/src/main.js)` under "The following dependencies are imported but could not be resolved" |
| dev server, on request | `Failed to resolve import "lodash" from "src/main.js". Does the file exist?` |
| `vite build` | `[vite]: Rollup failed to resolve import "lodash" from "…"` |

The startup form is the one that fires *first* and it never contains the phrase
the other two share — a single-line regex for "Failed to resolve import" would
have sat silent through exactly the case this exists for. The build form
lowercases the verb, so the match is case-insensitive. Verified end to end in a
scratch project: broken import → chip → `npm add lodash` → `✓ built in 270ms`.

Node's `Cannot find module 'x'` is in there too, for the scripts in the dropdown
that aren't vite.

**Open in the system browser** landed in the same header — the iframe has no
devtools, the system browser does, and `tauri-plugin-opener` was already a
dependency with the permission already granted.

### The search panel — §4.7's, not a second search

`search_files` has existed since P11 and only the agent could reach it. The
Search tab in the dock is that same command with a text field in front of it:
one search implementation, not one for the model and a different one for the
user. Ctrl+Shift+F, or the palette.

- **On Enter, not as you type.** The search walks every file on every call —
  deliberately, since there's no index — and a keystroke-triggered walk of a
  large repo is how a panel becomes the reason an app feels slow.
- **Jumping goes through `resolveInProject`**, the agent's own resolver, rather
  than `root + "/" + rel`. Hits come back with forward slashes and tabs are
  keyed by the exact path string, so concatenating would open a second tab for a
  file the tree already had open under backslashes. `jumpTo` then does the rest,
  since opening a tab unmounts the editor that asked.

**Replace-across-project is deliberately absent** even though §4.7 lists it. A
bulk rewrite the user starts has no undo boundary — checkpoints are per agent
turn — and the agent's own edit path already does project-wide changes with one
behind it. Build it when there's an undo for it, not before.

**The panel has a second mode: `chats`**, which searches every conversation in
every project rather than this project's files. It lives here rather than in the
agent panel because it's the same question asked of a different source, and
because two search boxes in one app is how neither gets found. A hit in another
project switches to it — the transcript panel shows one project at a time, as
the agent does.

### tsserver ships with the app now

Type checking worked under `tauri dev` and reported "unavailable" in a packaged
build: `tsserver.js` was found by walking up from the working directory, and
there's no `node_modules` above an installed executable. Honest, and the
majority of projects, and the entire point of P9.

`node_modules/typescript/lib` is a bundled resource, tried after the project's
own copy and before the walk-up. **Verified by building the installers and
querying the MSI's file table** rather than by reading the config back: 124
files, `tsserver.js` and the `lib.*.d.ts` set among them.

`node` itself is still expected on PATH. Bundling a runtime is a different order
of work, and every project Hearth runs already needs node for the package
manager and the dev server.

### Conversations moved to SQLite — P6's persistence item, closed

The 200k-char budget on chat history was a *localStorage quota* number that was
silently also a history limit — the same shape of bug as `HISTORY_BUDGET` being
sent to the model. It existed because the old store held every project's
conversation in one blob and rewrote all of it on every entry, so the trim
wasn't a policy about how much history is worth keeping. It was the price of the
storage.

It's `tauri-plugin-sql` now, as plan §8's P6 says, one row per entry. Nothing is
trimmed: `LOAD_LIMIT` bounds what the panel reads back and the table keeps the
rest. **One database for everything rather than one per project**, which is the
only reason to prefer a database here at all — the Search panel's *chats* mode
answers "where did I solve this before" across every project you have, and a
file per project cannot.

- **The schema is `CREATE TABLE IF NOT EXISTS` run from the frontend on every
  open, not a Rust migration list.** The point is testability: the statements
  live in [`chatsql.ts`](src/lib/chatsql.ts) and `pnpm test` executes
  *those exact strings* against a real SQLite through Node 24's `node:sqlite`.
  A migration the tests can't reach is a schema nobody checks until the app
  won't start. (Marked `ponytail:` — the day a column changes, this needs real
  versioned migrations, and pretending otherwise would corrupt history.)
- **The schema is a list of statements, not one string with semicolons.** The
  plugin's `execute` prepares and binds a *single* statement, so the readable
  version would have created `entries` and silently skipped the index and
  `sessions`.
- **`sql:default` doesn't include `allow-execute`.** It grants load, select and
  close — so every insert, and the schema itself, would have failed at runtime
  with a permission error. Found by reading the generated ACL manifest rather
  than by running the app, which is the only reason it was found at all.
- **A `text` column, populated at insert time**, rather than searching the JSON:
  a search that matches `"kind":"user"` on every row is worse than no search.
  Deliberately not FTS5 — that's a virtual table plus triggers to keep in step,
  for a LIKE over a few thousand rows that is instant.
- **The query is escaped for LIKE.** `%` and `_` are wildcards, and a search for
  `100%` that quietly matches everything is the kind of wrong that looks like it
  worked.
- **Writes go through a queue.** They're dispatched from a synchronous store
  action, so two entries landing in the same tick would race. Failures are
  swallowed: losing the stored copy of a turn is bad, losing the turn itself
  because a write failed is worse.
- **Hydration hangs off `rehydrateFromDisk` as well as `openFolder`**, which is
  the one that's easy to miss — reopening the app restores a project without
  going through `openFolder`, and the language server needed the same treatment
  for the same reason.
- **Both older stores are imported once**, per project, on first open: the
  `localStorage` blob, and the `.hearth/chat.jsonl` files that were the previous
  answer to this. Their session snapshot comes with them, or the first turn
  after an upgrade would be sent a conversation the model has never seen. The
  JSONL files are left on disk rather than deleted — removing someone's only
  copy of a conversation to tidy up isn't a trade worth making — so
  [`transcript.ts`](src/lib/transcript.ts) survives as the importer's
  parser, minus the writer.

### The split editor — P1's last deferral

`Ctrl+\` pins the file you're looking at into a second pane, so moving around in
the main one leaves it in view. The palette has it too.

- **One extra path in the store, not a second tab bar.** The parked reason for
  not doing this was "two active paths and a tab bar per pane"; the tab bar is
  what makes it expensive and it isn't what a split is for. A pane with its own
  tabs is a second editor to keep in step, rather than a second view.
- **The two panes share Monaco's model registry**, which is keyed by path — so
  splitting a file against itself is two views of one buffer rather than two
  buffers racing to save the same file.
- **The split pane sits out anything global.** A diff takes over the main pane
  only, and a go-to-definition jump moves the main pane only: both fire on a
  store change, and two panes handling them would race with the second winning.
  Closing a tab closes a split pinned to it.

### A turn survives the reload that killed it

Conversations moved to SQLite, and the thing that still didn't survive a reload
was the turn that was *running* during it. On a local model that's minutes of
work: the plan, the searches, every file read, every edit. Reload while gemma4
is thinking and all of it went, leaving a transcript whose last row was a tool
call with no outcome and no way to tell whether the edit landed.

The turn is now written down as it goes, and the panel offers it back.

- **`pending` sits beside `history`, not in it.** `history` is the record of
  *completed* turns — what the next turn is sent as context. An abandoned turn
  must not leak into that (the model would be handed half a conversation as
  though it had happened), and a resumed one has to pick up the tool results it
  already paid for rather than start the same work again. Two fields, because
  those are two different questions.
- **Checkpointed at the top of the loop, not after every push.** That's the one
  place the message list is a history a model can actually be handed: it ends on
  the user's prompt or on a *complete* set of tool results, never on a tool call
  whose result is still missing. Persisting mid-batch would save a conversation
  that can't be resumed at all. The cost is the split second between the
  checkpoint and the reply — one question re-asked.
- **The orphan is killed on sight.** A reload doesn't stop the model: the request
  lives in the Rust process, which streams on into a channel the dead page took
  with it. So Ollama holds the GPU generating a reply nobody can read, and a
  resume competes with it for the card. The cancel-id registry outlives the page
  for exactly this reason, and cancelling an id that's already gone (app restart,
  turn finished) is a no-op — so spotting a `pending` is enough to justify the
  call.
- **Offered, never auto-resumed.** The reload is often the user escaping a turn
  that was going nowhere, and a turn that took the app down with it would
  relaunch itself on every start. The button reads **Resume** when there's a
  partial to carry on from and **Retry** when the turn died before completing a
  single step — different actions, and a user about to pay minutes for one
  deserves to know which.
- **`wrote` is recovered from the messages.** It's the flag deciding whether an
  unfinished turn gets verified or just ends, and the writes it describes
  happened in a process that no longer exists. Counted from the last user message
  on, so an earlier turn's edits don't put a project-wide type check in front of
  a conversational reply. It lives in [`session.ts`](src/lib/session.ts)
  as `wroteThisTurn`, import-free and unit-tested, including the PLAN case where
  the last user message is the plan's acknowledgement rather than the prompt.
- A resume is itself resumable: the messages it starts from are written back as
  the new turn's `partial` before its first call.

**Two bugs found on the way there, both in the "it failed quietly" family.**
`db()` cached its connection with `??=`, which also caches a *rejected* promise —
one bad open at startup meant every later read and write failing, forever, on a
store whose writes swallow their errors by design. And `openFolder` /
`rehydrateFromDisk` awaited the chat hydrate and the language-server start in
sequence with nothing between them, so a tsserver that wouldn't spawn took the
transcript down with it and the throw went somewhere nobody would see. Chat first
now, and neither allowed to take the other down.

**Verified against the real app**, not just the suite: `tauri dev` driven over
CDP, gemma4 at 100% GPU, the page reloaded mid-turn. It landed in the middle of
a repair round — `read_file → edit_file → get_errors → finish bounced with 4
errors, repair 1/3` — and what came back:

| | |
|---|---|
| banner | **Resume**, not Retry — so a `partial` was on disk |
| the four completed steps | still there |
| resuming | appended `read_file src/main.jsx → get_errors → summary` |
| the prompt | **not** re-added to the transcript |
| checkpoint | `042d892`, one file modified, `Hello Hearth` on disk |
| GPU, 4s after the reload | **84% → 2%** |

That fourth row is the one that would have been easy to get wrong and hard to
notice: a resumed turn re-adding its own prompt reads as the user having asked
twice. And the last row is the orphan — a generation that carried on into a dead
channel would have held the card for the rest of the reply.

**Repeating this needs one trick.** WebView2 runs one browser process per
user-data folder and only the process that *starts* it honours
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` — so a second `tauri dev` next to a
running one silently gets no debug port, with no error to say why. Give it its
own `WEBVIEW2_USER_DATA_FOLDER` and the flag takes.

**The thinking indicator is a flame.** It was the word "thinking…" with a live
second count, which is the one thing on screen separating a working turn from a
hung one — and a static word is the same picture at 3 seconds and at 300. Three
sprite frames stacked in one SVG, cycled in CSS: a sprite flicker rather than a
transform, because the tip moves between frames and the base doesn't, which is
what makes it read as a fire rather than a wobbling icon. No image file, nothing
to decode, nothing to load. `prefers-reduced-motion` gets one lit frame, and the
seconds keep counting either way.

### The 20 tasks, through the app's loop — and what the number was worth

The spike scores a model with P0's five tools: no `get_errors`, no type check,
no auto-repair round. gemma4's 12/20 there is recorded above with the note that
four of the eight failures wrote syntactically broken TypeScript — "exactly what
P9 and P10 were built to catch", and that running the same tasks through the
app's loop was "the obvious next measurement". It's built
([`loop-spike.ts`](p0-spike/src/loop-spike.ts)) and it was run, and the first
thing it establishes is that **the 12/20 was one sample of a very wide
distribution**, so most of what was written above it doesn't hold.

Five bare runs and five app-loop runs, same fixture, same 20 tasks, same
verify, same machine, same afternoon:

| loop | runs | pass/20 each | mean | iterations | wall/task |
|---|---|---|---|---|---|
| bare (P0's five tools) | 5 | 12, 13, 14, **8**, 12 | 11.8 | 3.8 | 9.3s |
| app (PLAN on) | 4 | 10, 8, 10, 9 | 9.3 | 6.3 | 20.2s |
| app (PLAN off) | 1 | 12 | 12.0 | 6.0 | 15.7s |

**The bare loop's own range is 8–14.** That's 40%–70% from one configuration,
and it swallows every difference between configurations. Across all ten runs
only two of the twenty tasks came out the same way every time. The honest
reading is not
"the app's loop scores 9.3 against 11.8" — it's that a 20-task run of this
harness cannot resolve a two-or-three-task difference, and the recorded 60%
should never have been quoted as a property of the model.

What *is* outside the noise, at 100 task-runs per side:

- **The net doesn't reduce broken output. 24 of 100 app-loop runs ended with a
  file too broken to parse, against 22 of 100 bare.** This is the headline, and
  it's the opposite of what the phase predicted. The failure is nearly always
  the model emitting `\n` as a backslash and an `n`, or dropping a brace.
- **It isn't blindness — the model looks, and can't act.** 87 of 100 runs called
  `get_errors`, and it reported the damage plainly: 22 type errors on one run,
  46 on another. gemma4 reads that and mostly re-asserts that it has finished.
- **The extra rounds are where the damage comes from.** In the app's loop a
  passing run averages 4.9 iterations and a failing one 7.5; in the bare loop
  the two are 3.8 and 3.9. Length doesn't predict failure without the net, and
  does with it. A bounced `finish` buys another edit, and another edit on a file
  a small model is already mangling is another chance to mangle it.

So P9 and P10 are worth what they are worth *to a human* — the squiggle, the
Problems panel, the report a person can read — and, on this model, close to
nothing as an autonomous repair loop. That isn't an argument for removing them;
the same three sources are what the human error loop reads, and a stronger model
is the variable this measures, not the tooling. It is an argument against the
sentence above that assumed 60% was the model held back by a missing safety net.

**One thing was straightforwardly broken, and is fixed.** 25 of the 38 repair
rounds spent across those runs got no edit at all before the next `finish` — the
model answers a bounce by claiming again that it's done. Each of those cost a
full model call for an answer that could not have changed: the verdict is read
back off the project, so with no write in between the second check reads the
same files and returns the same result. That's `stalled`'s rule with a different
tool name, and it's now `worthRepairing` in
[`session.ts`](src/lib/session.ts) — the first bounce is free, later
ones need a write since the last. Import-free and unit-tested, and applied in
the harness as well as the app so the two loops can't drift.

That sharing is the other half of the work. There were two copies of the app's
loop outside the app (the probe's and this one's would have been the third and
fourth), and the probe had already been caught twice measuring a loop the app no
longer ran. The loop now lives once, in
[`app-loop.ts`](p0-spike/src/app-loop.ts), importing the system prompt, tool
definitions, PLAN step, history packing, loop detection and finish verification
from the app's `src/lib`. What a caller supplies is the world: the probe's is
canned so
its runs stay deterministic, and the loop spike's is real files with a real
whole-program type check through the TypeScript compiler API. It aborts if the
untouched fixture doesn't type-check clean — otherwise every task is handed
errors the model didn't cause and burns its repair rounds chasing them, and
nothing would say so.

### §5's stable prompt prefix — the plan item nothing here had noticed

Build plan §5 is titled "read this twice" and §9 lists a stable prefix as the
*first* thing to reach for when turns are slow. Nothing above mentions it, and
it was half-honoured.

The half that was right: the system prompt is built once, on the turn that
starts a conversation, and reused verbatim after that. It names the project root
and the file the user has open — and that second one changes as the user clicks
around, so rebuilding it per turn would have moved byte one of every prompt. It
doesn't, because `systemPrompt` is only called when the history is empty.

The half that was wrong: everything after it. `packHistory` answers a *storage*
question — keep the newest that fit — so it is anchored at the newest message
and every append moves where it starts. It was also what got sent, re-applied
every iteration. Ollama reuses its KV cache only for a byte-identical prefix, so
a window that slides by a message per iteration is a full prompt recompute on
every call of a turn, and a turn is where the iterations are.

**Not an edge case, which is what made it worth fixing.** At `num_ctx` 8192 the
history budget is 24,576 chars and one file read is capped at half that. Two
reads exhaust it, and gemma4's own recorded traces get there.

`sendWindow` is `packHistory` with hysteresis: `start` moves forward only, and
only when the window stops fitting — then it cuts back to `REFILL` of the budget
so the next several appends land inside a window that hasn't moved. Simulated
over a 48-append turn at the real budget:

| | prefix changes in 48 appends |
|---|---|
| sliding (what shipped) | **48** |
| refill 0.5 | 4 |
| refill 0.6 – 0.9 | **7** |

The band is flat, which is the useful part: the floor isn't set by the knob but
by `contextLimits` capping one read at half the window, so two reads can't share
a window at any refill. 0.5 buys its three extra cuts by holding back half the
context, so 0.7 sits on the plateau and keeps more. The constant carries that
table rather than a guess.

Both invariants `packHistory` guards are kept — the system prompt survives every
cut, and the window never opens on a tool result whose call was cut away, which
is an answer to a question the model can't see. It lives in
[`session.ts`](src/lib/session.ts), import-free and unit-tested; `packHistory`
stays for storage, which is a genuinely different job and was conflated with
this one once before.

**Unmeasured: what it's worth in seconds against a live model.** The 48 → 7 is a
simulation of the windowing rule, not a timing. Confirming §5's claim needs a
controlled A/B on a long conversation, which is a bigger measurement than the
fix. What was checked is that the loop still works through the new send path —
`pnpm run probe -- gemma4:latest`, both scenarios, `finish` called, edit applied,
checked and re-checked, 0 repair rounds.

Applied in `app-loop.ts` as well as the app, so the two loops can't drift.

---

## Remaining work

Following the build plan's phase order (§8).

Every phase P0–P14 has now landed at least once. What follows is what each one
deliberately doesn't have, and why — the list is short, and the entries are
decisions rather than backlog.

### Milestone A — finish the local IDE (no AI)

- [x] **P2 · Terminal** — PTY-backed shell, tabs, per-project cwd, shell
      detection, scrollback search, tree-kill teardown, and a session manager
      keyed by id so the agent's separate PTY is a second key rather than a
      rewrite.
- [x] **P3 · Runner** — done (above).
- [x] **P3 · Install-on-demand** — the runner detects an unresolved package and
      offers a one-click install (above). §9's mitigation for the failure local
      models produce most.
- [x] **P4 · Browser** — done (above), except that the injected bridge is
      vite-only. A Next or webpack project runs and previews fine; it just has
      no console capture, which `consoleTail` reports rather than passing off as
      silence. Wire those up when a non-vite project is the thing someone is
      actually working on.

*End state: a usable local IDE — edit, run, preview — with no AI involved.*

### Milestone B — local models

- [x] **P5 · Model manager** — list, pull-with-progress, unload, `num_ctx`
      control, GPU-split badge and total-VRAM readout (above). "Be honest when a
      model won't fit" is served by measurement rather than prediction; the
      pre-load warning the plan asks for is **deliberately not built**, because
      the footprint input it needs doesn't exist (see the 0.35×–1.21× table).
      Explicit load is the one omission — selecting a model and sending loads
      it, and a button to do the same thing 20 seconds earlier isn't worth its
      own control.
- [x] **P6 · Chat** — streaming chat, code-block and inline-code rendering, and
      transcripts that survive a restart, kept per project. The turn that was
      *running* during the restart survives too, offered back as Resume or
      Retry rather than replayed on its own (above).
- [x] **P6 · conversation persistence via `tauri-plugin-sql`** — one row per
      entry, nothing trimmed, and one database across every project so the
      conversations are searchable from the Search panel (above). That last part
      is what made SQLite the right answer rather than a heavier file.
- [~] ~~**P6 · conversation persistence via `tauri-plugin-sql`**~~ — kept for
      what it got wrong. This was parked as "not a felt problem yet: transcripts
      already survive in `localStorage`, trimmed to a 200k-char budget. Do it
      when the trim starts cutting something someone wanted." The trim was never
      the reason. Cross-project search was, and that isn't a thing waiting to be
      noticed — a feature nobody can have yet produces no complaints.

### Milestone C — the agent

- [x] **P7 · Agent loop** — tools, `run_command`, PLAN/ACT/VERIFY, approval
      gates, and mid-request cancellation (above). GATHER never became a phase
      of its own: `search` and `repo_map` are what it would have done, and
      they're more useful as tools the model reaches for than as a step every
      turn pays for.
- [x] **P8 · Diff review** — checkpoint cards, Monaco diff per file,
      whole-checkpoint restore, reject-per-hunk, and editor decorations for the
      agent's writes.
- [x] **P9 · LSP + Problems** — a `tsserver` sidecar rather than
      `typescript-language-server` (it wraps the same process, and `typescript`
      was already a dependency here), diagnostics into Monaco and a Problems
      panel, hover, go-to-definition, document symbols, rename, and
      find-references. The scaffold gained a `jsconfig.json` and React types,
      without which a JS project reports no diagnostics at all.
- [x] **P10 · Error feedback loop** — all three sources merged into
      `get_errors()`, `finish` verified and bounced for up to 3 auto-repair
      rounds, loop detection on repeated (call, result) pairs, and a turn that
      writes files and then stops without finishing is verified and reported
      rather than passed off as success.

### Milestone D — polish

- [x] **P11 · Codebase context** — `search` and `repo_map` (above).
- [x] **P12 · Inline edit and element picker** — done (above). **FIM is not
      built**: it needs per-model prompt templates and a mid-typing latency
      budget a local model doesn't have, and nothing else depends on it.
- [x] **P13 · Checkpoint timeline** — done (above). **Staging, branches and a
      commit UI are not built**, and that's a scope decision rather than a
      deferral: those act on the *user's* repo, while everything else here acts
      on `.hearth/git`. One panel driving both is how someone resets the wrong
      one. If they get built, they belong somewhere that never shares a button
      with a checkpoint.
- [x] **P14 · Templates and secrets** — two templates, `.env` redaction on both
      sides, and a dependency list (above). **GitHub push and the deploy hook
      are not built**: both are outward-facing actions needing credentials
      Hearth has nowhere to keep, in an app whose selling point is that nothing
      leaves the machine. The terminal is next door, and `git push` works there
      with the user's own credentials and the user's own decision.

### Not a phase, but still open

- **~~Split editor.~~** Done (above). The parked reason was "two active paths
  and a tab bar per pane" — the tab bar is the expensive half and isn't what a
  split is for, so the pane is pinned to one path and has none.
- **Find/replace** was on the same deferred list and turns out to need nothing:
  Monaco's own Ctrl+F and Ctrl+H work, and the widget is better than anything
  worth writing here.
- **There is no Settings surface.** §4.7 asks for one panel holding model
  config, `num_ctx`, approval policies, allowlisted commands and theme. Four of
  those exist scattered where they're used — `num_ctx` in the chat header, **Ask
  first** under the composer — which is where a control is most useful and is
  not obviously worth centralising. Two don't exist: there's no theme control at
  all, and the command allowlist is deliberately hardcoded in Rust so a frontend
  mistake can't widen it. That last one is a real disagreement with the plan
  rather than a deferral: user-editable and un-widenable-from-the-frontend are
  not the same allowlist, and the safe one was chosen.
- **The console bridge is still vite-only**, and the non-vite case is now the
  only Milestone-A gap left. A Next or webpack project runs and previews; it
  just has no console capture, which `consoleTail` reports rather than passing
  off as silence.
- **~~The spike measures the model without the app around it.~~** Measured —
  `pnpm run loop-spike` runs the same 20 tasks through the app's loop, and the
  answer is that the type check and auto-repair round *don't* catch the
  broken-syntax failures (24 of 100 against the bare loop's 22). See above. What
  the measurement mostly established is that this harness needs several runs per
  configuration before a number from it means anything: the bare loop alone
  scores anywhere from 8/20 to 14/20.

---

## Decisions needed before going further

These are judgment calls, not something to guess at — flagging them here so
they don't get silently decided by momentum.

1. **Model size — reopened, because the reason for "go small" was wrong.**
   The old answer ("the machine has no GPU, so 8B-class or nothing") rested
   on a mismeasurement; see the P0 section. What's still true is the measured
   `llama3.1:8b` tool call at **~2.4s**, which is a fine agent step. What's
   no longer true is that everything larger is hopeless — a 16 GB RTX 5080
   runs anything that fits in VRAM, so the plan's §10 suggestion of
   `devstral:24b` is worth an actual test at Q4 rather than a dismissal,
   while `qwen3-coder:30b` (18 GB) really is over the line at any useful
   context. The open question is the quality/VRAM trade at 8B vs ~14B vs
   24B-Q4, and it needs numbers, not a re-derivation. Re-run the P0 spike
   with `ollama ps` checked *during* each run, so a silent CPU fallback shows
   up as a fallback instead of as a model being slow. (The P0 table scores
   `gpt-oss`/`qwen`, neither of which is still pulled here.)

   **Answered, for the three models that are pulled** — see the table above.
   llama3.1:8b doesn't hold a multi-step tool loop at all, so its ~2.4s call
   is speed at something that never finishes. `qwen3-coder:30b` does hold the
   loop and is the most careful of the three, but at 74% GPU it costs 227s
   against gemma4's 16–20s for the same result. **Default: gemma4.**

   What that left: the 14B–24B-Q4 band, which is where a model might beat
   gemma4's quality while staying under the line.

   **Closed. `devstral:24b` is pulled and measured, and it doesn't hold the
   loop.** Three probe runs per scenario, `ollama ps` checked during them:

   | model | resident | GPU split | heading: edit applied | called `finish` | unfamiliar: applied |
   |---|---|---|---|---|---|
   | gemma4:latest | 3.4 GB | 100% | 2/2 | 2/2 | 2/2 |
   | devstral:24b | 15 GB | **90%** (10% CPU) | 3/3 | **0/3** | **0/3** |
   | llama3.1:8b | 5.9 GB | 100% | 0/1 | 0/1 | 0/1 |

   devstral is not slow and not confused — on the unfamiliar project it
   reaches for `search` and reads the right file, in 5–7s. Then it stops
   replying. Every run ends `no_tool_call`, which is llama3.1:8b's failure
   at three times the size: the turn is abandoned rather than finished, so
   P10's brake — which hangs off `finish` — never fires. On the harder
   scenario it abandons before editing at all, so nothing lands.

   The 15 GB also doesn't fit: 90/10 at `num_ctx` 8192, and the KV cache
   grows from the same 16 GB, so a bigger window makes it worse.

   That closes the band the plan pointed at. **Default stays gemma4**, now on
   two scenarios rather than one. What isn't measured is whether devstral
   holds a loop in the scaffold it was trained for — this scores it in
   Hearth's, which is the question Hearth has.
2. **~~Widen the P0 task set.~~** Done: 20 tasks, and `pnpm run check-tasks`
   asserts every one of them fails on an untouched fixture — a verify that
   passes without the model having done anything scores every model as
   correct, and the table is the whole output of the spike.

   **gemma4 scored 12/20 (60%)** on the run this was written from, 0 malformed
   JSON, 0 wrong-tool calls, 2 failed diffs, 3.6 iterations and 7.9s per task.

   **That 60% is one sample, and the spread is 8/20 to 14/20** — five runs of
   this exact configuration, measured later the same day. Everything below is
   still a fair description of *that run's* failures; none of it is a rate. See
   "The 20 tasks, through the app's loop" above.

   The interesting half is the 8 failures, which split evenly:

   - **4 wrote syntactically broken TypeScript** — a stray `}`, a `return` at
     top level, a mangled newline. Not a diff that failed to apply: the edit
     landed and the file no longer parses.
   - **4 are wrong answers** — the empty-array guard that still returns `NaN`,
     an off-by-one "fixed" to the same value, two new files never re-exported.

   The first group is the one to read carefully, because **the spike has no
   safety net**: its tool set is P0's five, so there's no `get_errors`, no type
   check and no auto-repair round. Those four looked like exactly what P9 and
   P10 were built to catch.

   **They aren't.** `pnpm run loop-spike` runs these same tasks through the app's
   loop, and broken-parse endings come out at 24 of 100 against 22 of 100 —
   unchanged. The model calls `get_errors`, is told about the damage, and
   re-asserts that it has finished. Written up above.

   The app's own `applyEdits` was checked directly against this, since a
   corrupting edit path would look identical from here: handed a real
   multi-line insertion from gemma4, it produced exactly the intended file.
   `tools.ts` now imports it rather than keeping the copy that was diffed
   against it.
3. **~~The agent can't see the runner it now sits next to.~~** Decided: took
   the shortcut. `get_errors` reads the dev-server log now, ahead of the LSP,
   and gemma4 runs the full edit→check→fix→re-check loop with it (see above).
   Closed — but it moved the open question into item 1 rather than removing
   it, since llama3.1:8b ignores the tool entirely.
4. **~~P1 scope-creep candidates.~~** Closed. The command palette landed a
   phase later than this item suggested; the symbol outline got the dock tab it
   was waiting for; find/replace turned out to need nothing, since Monaco's own
   Ctrl+F and Ctrl+H are better than anything worth writing. Only the split
   editor is left, and it's parked for a reason rather than forgotten — see
   "Not a phase, but still open" above.

5. **~~What the agent does with the tools it just grew.~~** Answered by the
   probe's second scenario: nine files across directories, and a task that
   names none of them.

   **gemma4 searches rather than reads.** Both runs open with `search`, then
   read one or two files — not the nine it would have to walk otherwise — and
   the whole turn costs 11–15s against 9–14s for the trivial one. So the P11
   tools are close to free and are being used the way they were meant to be.

   `repo_map` was never called by any model on either scenario. That isn't a
   verdict on it — a nine-file project is one `search` away from an answer, and
   the map earns its keep on repos too big to search blindly — but nothing here
   has measured it doing so.

   Two harness bugs fell out of running it, both of which would have skewed
   what it reported. The probe had no loop detection, so a model re-applying an
   edit that no longer matched got the same failure until the iteration cap; it
   uses the app's own `stalled` now. And `finish` was bounced whenever the
   canned build hadn't been "repaired" — which a model that got it right on its
   *first* edit can never satisfy, since it has nothing left to change. It
   burned all three repair rounds being told to fix an already-correct file.
   The finish check now asks the scenario whether the task is actually done,
   which is what the app checks too.

---

## How to resume

```bash
# Score a model on the two loops that matter: does it check its own work after
# editing (heading), and does it find a file nobody named (unfamiliar). Both
# scenarios per model unless --scenario narrows it. ~30s for a model that fits.
cd p0-spike && pnpm run probe -- gemma4:latest devstral:24b
```

```bash
# The wider P0 spike — 20 tasks, pass/fail on actually running the result.
# Scores correctness, not instruction-following, and without get_errors or a
# type check in front of it. ~3 minutes for gemma4.
#
# One run is not a score: this configuration ranges 8/20 to 14/20 on gemma4.
# Run it several times before comparing anything to anything.
cd p0-spike && pnpm run spike -- gemma4:latest
```

```bash
# The same 20 tasks through the app's loop — real get_errors with a real
# whole-program type check, PLAN, auto-repair rounds, loop detection. What the
# safety net is worth, against the line above. ~6 minutes for gemma4.
cd p0-spike && pnpm run loop-spike -- gemma4:latest        # --no-plan drops PLAN
```

```bash
# Run after touching tasks.ts or the fixture: every task must fail on an
# untouched fixture, or the spike scores every model as correct.
cd p0-spike && pnpm run check-tasks
```

```bash
# The app shows the GPU split during a turn, but this is the check outside it.
# Anything under 100% GPU means the timing you're about to write down includes
# a CPU fallback.
ollama ps
```

```bash
# Run the app
pnpm run tauri dev
```

```bash
# Unit tests (116): path safety, search/replace, session packing, prompt-prefix
# stability, context
# sizing, repair-round budgeting, interrupted-turn recovery, run-state machine,
# dev-log and
# missing-package parsing, pull progress, fenced-code splitting, checkpoint
# name-status, hunk parsing, repo-map extraction, .env redaction, diagnostic
# folding, transcript framing — plus the chat store's SQL against a real
# SQLite, and one that drives a real tsserver
pnpm test
```

```bash
# Rust tests (19): NDJSON, PTY and Content-Length framing, package-manager
# detection, project search, the command allowlist, a real shell in a real PTY,
# a real tsserver reporting a real type error, and the whole checkpoint sequence
# against a real git repo
cd src-tauri && cargo test --no-default-features
```

```bash
# Package it. Worth running after touching bundle.resources — type checking in
# an installed build depends on tsserver.js actually landing in there, which
# only this says.
pnpm run tauri build
```
