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

### P1 — Shell + editor ([hearth-app/](hearth-app)) — Milestone A

Tauri v2 + React + TypeScript + Vite + Tailwind, running locally
(`npm run tauri dev` from `hearth-app/`):

- Native folder picker (`tauri-plugin-dialog`) → lazy-loaded file tree
  (Rust `list_dir` command, skips `node_modules`/`.git`/`target`/`dist`)
- Monaco editor, self-hosted (no CDN — matters for an offline-first app),
  language workers wired via Vite `?worker` imports
- Multi-tab editing with dirty-state tracking (`●` vs `×` on each tab)
- Ctrl+S save (Rust `read_text_file` / `write_text_file` commands)
- Zustand store (`hearth-app/src/lib/store.ts`) holding project root, tree
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
  [`hearth-app/src/lib/edit.ts`](hearth-app/src/lib/edit.ts), kept import-free
  so it's unit-tested directly (`cd hearth-app && npm test`).
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
  [`runlog.ts`](hearth-app/src/lib/runlog.ts), import-free and unit-tested —
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

Parsing lives in [`runlog.ts`](hearth-app/src/lib/runlog.ts) with the rest of
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
(`npm run probe -- <model>`). It imports the app's real `TOOL_DEFS`,
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
[`session.ts`](hearth-app/src/lib/session.ts), which is import-free and
unit-tested — the sizing is the part that breaks silently if someone raises a
constant, so it lives where `npm test` can reach it.

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
  layer starts. [`pull.ts`](hearth-app/src/lib/pull.ts) keys totals by digest
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
  offline-first app. [`markdown.ts`](hearth-app/src/lib/markdown.ts) is a fence
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

- **Scoring is ~30 lines in [`fuzzy.ts`](hearth-app/src/lib/fuzzy.ts), not
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
  [`workspace.ts`](hearth-app/src/lib/workspace.ts)), patching
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

Parsing and the tail format live in [`runlog.ts`](hearth-app/src/lib/runlog.ts)
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
`npm run probe` is re-run — it now tells the model `get_errors` covers the
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
from [`git.ts`](hearth-app/src/lib/git.ts) and never from the model, and the
write verbs `check_command` exists to refuse are the entire point. They arrive
as a list, so there's no shell to escape. `stdout` and `stderr` come back
separately — `run_command` merges them, but this one carries file content, and a
merged stream would splice git's warnings into the middle of a file.

**Verified end-to-end against a real repo** in the Rust suite (`cargo test
checkpoints`): init → baseline → a turn's commit → name-status → both sides of
one file → rollback, including that `node_modules` survives the rollback and
that a turn changing nothing produces no card. Rename parsing is tested
separately in [`gitdiff.ts`](hearth-app/src/lib/gitdiff.ts) — `R100→old→new` is
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
[`problems.ts`](hearth-app/src/lib/problems.ts), import-free and unit-tested like
the other parsing modules; the client is [`lsp.ts`](hearth-app/src/lib/lsp.ts)
and the editor wiring [`monaco-ts.ts`](hearth-app/src/lib/monaco-ts.ts).

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

## Remaining work

Following the build plan's phase order (§8). Each phase should land as a
usable increment, not a partial cut.

### Milestone A — finish the local IDE (no AI)

- [x] **P2 · Terminal** — done (above): PTY-backed shell, tabs, per-project
      cwd, shell detection, scrollback search, tree-kill teardown, and a
      session manager keyed by id so the agent's separate PTY is a second key
      rather than a rewrite.
- [~] **P3 · Runner** — port allocation, install-on-demand and clean Windows
      teardown landed with the Run + Preview slice above. Still open:
      package-manager detection (npm is hardcoded), running arbitrary scripts
      rather than just `dev`, and the full health-state machine
      (`stopped/installing/starting/ready/crashed/port-conflict`).
- [~] **P4 · Browser** — the preview `<iframe>` landed with that same slice,
      and the console-capture bridge with the `get_errors` work above. Still
      open: URL bar, viewport presets, network panel, and the bridge for
      projects Hearth didn't scaffold. Element picker explicitly deferred to
      P12.

*End state: a usable local IDE — edit, run, preview — with no AI involved
yet.*

### Milestone B — local models

- [x] **P5 · Model manager** — done; see the P5 sections above and the "finish
      what the agent panel started" list below.
- [~] **P6 · Chat** — streaming chat against the loaded model landed with the
      agent panel. Still open: markdown/code rendering and conversation
      persistence — see **P6 rest** below.

### Milestone B/C — finish what the agent panel started

- [x] **P5 · Model manager** — list, pull-with-progress, unload, `num_ctx`
      control, GPU-split badge and total-VRAM readout all landed (above).
      "Be honest when a model won't fit" is served by measurement rather than
      prediction; the pre-load warning the plan asks for is **deliberately not
      built**, because the footprint input it needs doesn't exist (see the
      0.35×–1.21× table). Explicit load is the one omission — selecting a model
      and sending loads it, and a button to do the same thing 20 seconds
      earlier isn't worth its own control.
- [~] **P6 rest** — code-block and inline-code rendering landed (above). Still
      open: conversation persistence via `tauri-plugin-sql`. Worth questioning
      rather than just doing — transcripts already survive restarts in
      `localStorage`, keyed per project and trimmed to a 200k-char budget, so
      SQLite buys unbounded history and queryability across projects. Neither
      is a felt problem yet; do it when the trim starts cutting something
      someone wanted.
- [~] **P7 rest** — `run_command` landed (above), so the agent can execute as
      well as read, and P10 added the VERIFY half of PLAN/ACT/VERIFY. Still
      open: approval gates before writes and commands, the explicit **PLAN**
      and GATHER phases — plan §6 calls PLAN "the biggest quality lever for
      local models", and it's the one structural piece of the pipeline still
      missing — and mid-request cancellation; today's Stop only takes effect
      between steps, and cancelling an in-flight call needs a cancellation
      token threaded into the Rust `ollama_chat` command. The allowlist is what
      stands in for the approval gate for now, and it's a narrower answer than
      a gate: it can't say yes to a one-off.
- [~] **P8 · Diff review** — checkpoint cards and Monaco diff per file landed
      (above), backed by a git repo at `.hearth/git` rather than a snapshot
      store, with whole-checkpoint restore. Still open: accept/reject per hunk
      and editor decorations during agent writes.
- [x] **P9 · LSP + Problems** — done (above): a `tsserver` sidecar rather than
      `typescript-language-server` (it wraps the same process, and `typescript`
      was already a dependency), diagnostics into Monaco and a Problems panel,
      hover, go-to-definition, and document symbols behind Ctrl+Shift+O. The
      scaffold gained a `jsconfig.json` and React types, without which a JS
      project reports no diagnostics at all. Still open from plan §4.5: rename
      refactor and find-references, both a request away now the client exists.
- [x] **P10 · Error feedback loop** — done (above): all three sources merged
      into `get_errors()`, `finish` verified and bounced for up to 3 auto-repair
      rounds, loop detection on repeated (call, result) pairs, and a turn that
      writes files and then stops without finishing is verified and reported
      rather than passed off as success.

### Milestone D — polish

- [ ] **P11 · Codebase context** — repo map from LSP/tree-sitter symbols,
      ripgrep search tool.
- [ ] **P12 · Inline edit, FIM, element picker.**
- [ ] **P13 · Source control panel** — staging, hunks, branches, commit UI,
      checkpoint timeline. The checkpoint repo P8 built is what the timeline
      reads from; today the cards live only in the transcript, so clearing the
      chat hides history that git still has.
- [ ] **P14 · Templates, secrets, export** — the starter-scaffold half landed
      early with the prompt-first home (one Vite React template). Still open:
      more templates, `.env` manager with redaction, dependency panel, GitHub
      push, deploy hook.

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

   What that leaves: the 14B–24B-Q4 band, which is where a model might beat
   gemma4's quality while staying under the line — nothing in it is pulled.
   The plan's §10 suggestion, `devstral:24b`, is the obvious first pull, and
   the probe now scores this exact question in about a minute per model.
2. **Widen the P0 task set.** Current harness has 8 tasks / 2 models; the
   plan calls for "20 tasks × 3 models." Worth doing once a faster model
   candidate is in the mix — no point widening against a model (qwen:latest)
   that's already disqualified for lacking tool support.
3. **~~The agent can't see the runner it now sits next to.~~** Decided: took
   the shortcut. `get_errors` reads the dev-server log now, ahead of the LSP,
   and gemma4 runs the full edit→check→fix→re-check loop with it (see above).
   Closed — but it moved the open question into item 1 rather than removing
   it, since llama3.1:8b ignores the tool entirely.
4. **~~P1 scope-creep candidates.~~** Command palette is done (see above), a
   phase later than this item suggested. Still open from P1's deferred list:
   split/diff view, and find/replace in the editor. Breadcrumbs and symbol
   outline were being held for P9's LSP, which now exists — the document-symbol
   provider behind Ctrl+Shift+O is already fed by `navtree`, so what's left is
   somewhere to render it rather than anything to compute. The bottom dock is
   the obvious place, and it grew a tab strip with the Problems panel.

---

## How to resume

```bash
# Score a model on the loop that matters: does it check its own work after
# editing? ~20s for a model that fits, minutes for one that doesn't.
cd p0-spike && npm run probe -- gemma4:latest llama3.1:8b
```

```bash
# The wider P0 spike — 8 tasks, pass/fail on actually running the result.
# Scores correctness, not instruction-following; slower, and the table it
# produces still names models that are no longer pulled here.
cd p0-spike && npm run spike -- gemma4:latest
```

```bash
# The app shows the GPU split during a turn, but this is the check outside it.
# Anything under 100% GPU means the timing you're about to write down includes
# a CPU fallback.
ollama ps
```

```bash
# Run the app
cd hearth-app && npm run tauri dev
```

```bash
# Unit tests: path safety, search/replace, session packing, context sizing,
# dev-log parsing, pull progress, fenced-code splitting, checkpoint name-status,
# diagnostic folding — plus one that drives a real tsserver end to end
cd hearth-app && npm test
```

```bash
# Rust tests: NDJSON, PTY and Content-Length framing, a real shell in a real
# PTY, a real tsserver reporting a real type error, and the whole checkpoint
# sequence against a real git repo
cd hearth-app/src-tauri && cargo test --no-default-features
```
