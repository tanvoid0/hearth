# Hearth — Build Plan

A local-first AI app builder. Lovable's prompt-to-app loop, Claude's agentic chat, Cursor's editor, LM Studio's model management — all running against Ollama on your own hardware.

---

## On the name

**Hearth.** The differentiator against Lovable, Bolt, v0 and Replit isn't features — it's that the fire is in *your* house. A hearth is the domestic version of a forge: same heat, but it's yours, it's warm, and nothing leaves the building. It keeps the smithing metaphor without the collision problem.

"Forge" is unusable in practice — SourceForge, Autodesk Forge, Laravel Forge, and a pile of npm packages. Same story for Foundry (Ethereum toolkit, Foundry VTT), Anvil (anvil.works is already a web app builder), Crucible (Atlassian), and Smithy (AWS).

Alternates if Hearth doesn't land:

- **Bellows** — the thing that makes a local fire hot enough to actually work with. Slightly obscure, very available.
- **Lathe** — precision shaping, workshop feel, uncrowded in dev tooling.
- **Quench** — the forge step where you harden the steel. Short, uncrowded, slightly cryptic.

I haven't verified npm scope, GitHub org, or domain availability — check those before you get attached.

---

## 1. What each parent contributes

| Source | What you're taking | What you're leaving |
|---|---|---|
| **Lovable** | Prompt → running app, live preview, click-to-edit, version history | Cloud hosting, Supabase lock-in, no code access |
| **Claude** | Plan-before-acting, tool use, explains reasoning, asks before destructive ops | — |
| **Cursor** | Real editor, Cmd+K inline edit, tab completion, codebase context, diff review | Cloud indexing |
| **LM Studio** | Model browser, VRAM fit estimates, load/unload, per-model context config | Its own inference engine — Ollama does that |

---

## 2. Stack decisions

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri v2** | ~10MB vs Electron's ~100MB, Rust core for filesystem/process work, good sidecar story |
| Frontend | React + TypeScript + Vite + Tailwind | Monaco and the ecosystem assume it |
| Editor | **Monaco** | VS Code's editor. Diff view and LSP wiring come free |
| Terminal | **xterm.js** + `portable-pty` (Rust) | Real PTY, not piped stdout — see §4 |
| State | Zustand | Agent state is messy and cross-cutting; Redux is overkill |
| Inference | **Ollama HTTP** (`localhost:11434`) | Model pull, tool calling, OpenAI-compat endpoint |
| Language intel | **typescript-language-server** sidecar | Real diagnostics for both you and the agent |
| Persistence | SQLite via `tauri-plugin-sql` | Chats, project metadata, settings |
| Vectors | `sqlite-vec` + `nomic-embed-text` | Late phase. Don't reach for a vector DB |
| App runtime | Node sidecar, one process tree per project | See §4 |
| Versioning | **Git plumbing** | See §7 |

This is a TypeScript + Rust project. Your Spring background transfers conceptually — the agent orchestrator is a state machine over a tool registry, and the process supervisor is a lifecycle manager — but not syntactically. Keep the Rust surface to filesystem, PTY, process spawning, and IPC.

---

## 3. Layout

```
┌──────────┬──────────────────────────┬──────────────┐
│ Explorer │  Monaco editor / diff    │  Agent chat  │
│ Models   │  [tabs]                  │              │
│ Search   │                          │  [plan]      │
│ Source   ├──────────────────────────┤  [tool call] │
│ Problems │ Browser  │ Terminal      │  [diff card] │
│          │          │ Problems      │  [checkpoint]│
└──────────┴──────────┴───────────────┴──────────────┘
```

Left rail: Explorer / Models / Search / Source Control / Problems.
Bottom dock: Browser / Terminal / Problems / Output — tabbed, resizable, detachable.

---

## 4. The tooling layer

This is the part that turns a chat wrapper into an IDE. Each of these is a real subsystem, not a checkbox.

### 4.1 Editor

Monaco, but wired up properly:

- Multi-tab with dirty-state tracking and a real save/revert model
- Split view (side-by-side and diff mode)
- Command palette (`Cmd+P` file jump, `Cmd+Shift+P` commands) — cheap to build, disproportionate UX payoff
- Find/replace in file, plus project-wide search backed by ripgrep
- Breadcrumbs and symbol outline (fed by LSP, §4.5)
- Editor decorations for agent activity: highlight lines the agent is currently touching, gutter markers for pending diffs

The agent and the user edit the same buffers. Reconciling that is genuinely fiddly — lock files during agent writes and reload open buffers from disk after, rather than trying to merge.

### 4.2 Runner (process supervisor)

The most under-appreciated subsystem. It owns every process Hearth spawns.

Responsibilities:
- Detect package manager from lockfile (`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`)
- Parse `package.json` scripts, expose them as runnable entries
- Allocate a free port, inject it into the dev server invocation, track the mapping
- Spawn, monitor, restart on crash, kill cleanly on project close (including orphaned children — this bites on Windows especially)
- Stream stdout/stderr to the terminal, the Output panel, *and* the agent's error buffer
- **Install-on-demand**: when generated code imports a package that isn't in `package.json`, detect the resolution failure and offer to install it. Local models hallucinate imports constantly; this converts a hard failure into a one-click fix.

Health states the UI must show: `stopped / installing / starting / ready / crashed / port-conflict`.

### 4.3 Terminal

xterm.js + `portable-pty`. A real PTY, not captured stdout — otherwise interactive prompts (npm's questions, Vite's keypress shortcuts, anything with a spinner) break.

- Multiple tabs, per-project cwd
- Shell detection (pwsh/cmd on Windows, `$SHELL` elsewhere)
- Search in scrollback, configurable buffer limit
- **Separate agent session.** When the agent runs a command it gets its own PTY with captured output — it must never type into the terminal the user is using. Show agent commands in a distinct read-only tab so they're auditable.

### 4.4 Browser

Start as an `<iframe>` in Phase 4, upgrade to a child webview when you need real devtools access.

- URL bar, back/forward/reload, open-in-system-browser
- Viewport presets (mobile / tablet / desktop) plus freeform resize
- **Console capture** — inject a script into the served HTML that forwards `console.*`, `window.onerror`, and unhandled rejections back over `postMessage`. This is the raw material for the error feedback loop.
- Network panel (requests, status, timing) — helps enormously when the model writes a broken fetch
- **Element picker** — user clicks a button in the preview, Hearth resolves it to a CSS selector plus surrounding DOM and source file, and drops that into the chat as context. This is Lovable's click-to-edit, it's moderate effort, and it's the single feature people will demo to their friends.
- Screenshot capture, for pasting visual state into chat. Feeding screenshots to a local vision model is possible but current local vision-coding models are weak — treat it as optional and don't build the loop around it.

### 4.5 Language intelligence (LSP)

Run `typescript-language-server` as a sidecar and speak LSP to it from Monaco.

Gives you, for free:
- Real type errors in the Problems panel — and critically, in the agent's `get_errors()` tool. Type errors are far higher-signal than runtime console noise, and they surface *before* the app is even run.
- Hover, go-to-definition, find-references
- Document symbols, which feed the repo map in Phase 11
- Rename refactor

This is the biggest single quality jump for both the human experience and the agent's error loop. Don't defer it past Phase 9.

### 4.6 Source control panel

Beyond the checkpointing in §7: staged/unstaged view, per-hunk staging, branch switcher, commit UI, and a timeline of agent checkpoints with one-click revert.

### 4.7 Supporting tools

- **Problems panel** — aggregates LSP diagnostics, build errors, and browser console errors into one filterable list. Also the agent's primary error source.
- **Search panel** — ripgrep-backed project-wide find and replace with preview.
- **Secrets / .env manager** — edit environment variables in a proper form, mask values, never send them to the model. Add an explicit redaction pass on any file content the agent reads.
- **Dependency panel** — installed packages, versions, outdated check, add/remove.
- **Settings** — model config, `num_ctx`, approval policies, allowlisted commands, theme.

---

## 5. The agent loop

### Tools

Keep the set tight. Local models degrade fast past roughly eight tools.

```ts
list_files(path)            → tree, depth-limited
read_file(path, range?)     → contents, secrets redacted
edit_file(path, edits[])    → search/replace blocks
write_file(path, content)   → whole-file, new files only
search(pattern, glob?)      → ripgrep
run_command(cmd)            → agent PTY, requires approval
get_errors()                → LSP + build + browser console, merged
finish(summary)             → ends the turn
```

### Why search/replace, not line diffs

Local models cannot count lines reliably. Use Aider's format:

```
<<<<<<< SEARCH
const [count, setCount] = useState(0)
=======
const [count, setCount] = useState(initialCount)
>>>>>>> REPLACE
```

Apply with exact string match, fall back to whitespace-normalised match, then fail loudly and re-prompt with the real file content. Never fuzzy-apply silently — you'll corrupt files and the model won't notice.

### Turn structure

```
User prompt
  ↓
PLAN     — structured JSON: {files_to_read[], steps[], risks[]}
  ↓        rendered as an editable checklist
GATHER   — auto-execute read_file / search (cheap, safe)
  ↓
ACT      — one tool call per iteration, max ~15, streamed
  ↓
VERIFY   — LSP diagnostics + dev server rebuild + console errors
  ↓        errors → back into ACT, max 3 auto-repair rounds
COMMIT   — git commit, checkpoint card in chat
```

The explicit PLAN step is the biggest quality lever for local models. It converts one hard task into several easy ones and gives the user somewhere to intervene before anything is written.

### Prompt caching — read this twice

Ollama reuses the KV cache only when the prompt **prefix** is byte-identical:

```
[ system prompt ][ tool defs ][ repo map ]  ← frozen, never reorder
[ conversation history ]                     ← append-only
[ current turn ]
```

No timestamps, no re-sorted file lists, no reordered tools. This is the difference between 4-second and 40-second turns on identical hardware.

---

## 6. Models

Two loaded at once, LM Studio style:

- **Agent model** — Qwen3-Coder 30B-A3B (~19GB Q4) or Devstral 24B (~14GB, benchmarked agentic)
- **Completion model** — small and FIM-capable for tab complete: Qwen2.5-Coder 1.5B/7B. Qwen3-Coder does *not* support FIM, which is exactly why you need two.

Models tab shows per model: disk size, estimated VRAM at current `num_ctx`, fit against detected hardware, tool-calling support, FIM support.

**Set `num_ctx` explicitly.** Ollama defaults to 2048 and silently truncates. Agentic work wants 32k+. Expose it as a slider with a live VRAM estimate — that alone beats most Ollama wrappers.

| VRAM/RAM | Agent model | Realistic scope |
|---|---|---|
| 8GB | Qwen3 8B | Single components. Not multi-file. |
| 16GB | Devstral 24B (Q4) / gpt-oss 20B | Small apps with tight repo maps |
| 24–32GB | Qwen3-Coder 30B-A3B | The target. Real iteration. |
| 64GB+ Mac | Larger dense models | Comfortable |

Be honest in the UI when a model won't fit. Silent CPU offload just feels like the app is broken.

---

## 7. Checkpoints via git

Don't build a versioning system. `git init` on project creation, every completed agent turn becomes a commit with the prompt as the message.

- "Revert to before X" → `git reset --hard <sha>`
- Diff review → `git diff`
- Branching experiments → real branches
- Export → the folder already is a repo

Use a separate git dir (`--git-dir=.hearth/git`) so you don't collide with the user's own version control.

---

## 8. Phases

Grouped into four milestones. Each milestone ships something you'd actually use.

### Milestone A — A working local IDE (no AI yet)

**P0 · De-risk spike — 2–3 days**
Standalone script, no UI. Give a local model a toy repo and a task, have it emit tool calls, apply them, measure. 3 models × 20 tasks. Record malformed-JSON rate, wrong-tool rate, failed-diff rate.
*If your model can't hold a 10-step tool loop, everything after this is a UI around a broken engine.*

**P1 · Shell + editor — 1 week**
Tauri + React + Monaco. File tree, tabs, dirty state, save, command palette, find/replace.

**P2 · Terminal — 4–5 days**
xterm.js + portable-pty. Multiple tabs, shell detection, scrollback search.

**P3 · Runner — 1 week**
Process supervisor per §4.2: package manager detection, script running, port allocation, health states, clean teardown, output streaming.

**P4 · Browser — 1 week**
Preview pane, URL bar, viewport presets, console capture bridge, network panel. Element picker deferred to P12.

*End of Milestone A: a lightweight local IDE that edits, runs, and previews web projects. Useful on its own.*

### Milestone B — Local models

**P5 · Model manager — 3–4 days**
Ollama client: list, pull with progress, load/unload, `num_ctx` config, hardware detection, VRAM estimates. Ships as a usable LM Studio alternative by itself.

**P6 · Chat — 1 week**
Streaming chat against the loaded model. Markdown and code rendering, conversation persistence. No tools yet — the model suggests, you paste.

### Milestone C — The agent

**P7 · Tool loop — 2 weeks** ← the hard one
Tool registry, PLAN/ACT/VERIFY, diff application, approval gates, agent PTY session, iteration caps. Project lives or dies here.

**P8 · Diff review — 1 week**
Monaco diff per file, accept/reject per hunk, editor decorations during agent activity, checkpoint cards in the chat timeline.

**P9 · LSP + Problems — 1 week**
typescript-language-server sidecar, diagnostics into Monaco and the Problems panel, hover and go-to-def, symbol outline.

**P10 · Error feedback loop — 4–5 days**
Merge LSP diagnostics + build errors + browser console into `get_errors()`. Auto-repair rounds with a hard cap and loop detection. This is what makes it feel like Lovable instead of a chat window.

*End of Milestone C: prompt-to-app that self-corrects.*

### Milestone D — Cursor-grade polish

**P11 · Codebase context — 1–2 weeks**
Repo map from LSP/tree-sitter symbols rather than raw file dumps. Ripgrep search tool. Embeddings only if the repo map proves insufficient — try the cheap version first, it usually wins.

**P12 · Inline edit, FIM, element picker — 1.5 weeks**
Cmd+K on a selection. FIM autocomplete with the small model (aggressive debounce and cancellation). Browser element picker → chat context.

**P13 · Source control panel — 4–5 days**
Staging, hunks, branches, commit UI, checkpoint timeline with revert.

**P14 · Templates, secrets, export — 1 week**
Starter scaffolds (Vite React, Next, static), .env manager with redaction, dependency panel, GitHub push, deploy hook.

Rough total: 4–5 months of evenings. **MVP is P0–P8.** Milestone A alone is about six weeks and gives you something you'd open daily.

---

## 9. Where it will hurt

| Problem | Mitigation |
|---|---|
| Malformed tool JSON | Ollama structured outputs / JSON schema. On failure re-prompt with the parse error, don't retry blind. |
| Diffs fail to apply | Exact → whitespace-normalised → fail loudly with file re-sent. Never fuzzy-apply. |
| Context overflows on real projects | Repo map of symbols, not files. Read on demand via tools. |
| Slow turns | Stable prompt prefix (§5). Then smaller model. Then shorter context. |
| Model loops on a broken fix | Cap repair rounds, detect repeated identical tool calls, hand back to user. |
| Orphaned dev server processes | Process groups, kill-tree on close. Test hard on Windows. |
| Agent and user edit the same file | Lock during agent writes, reload open buffers from disk after. Don't merge. |
| `run_command` is a shell on their machine | Always require approval. Allowlist by default. Show the exact command. |
| Secrets leaking into prompts | Redaction pass on every file read. Never send `.env` content to the model. |
| Hallucinated imports | Install-on-demand in the runner (§4.2). |

---

## 10. First session checklist

- [ ] Check `hearth` on npm, GitHub, and domains before committing to the name
- [ ] `ollama pull devstral:24b` and `qwen3-coder:30b`
- [ ] Write the P0 harness — 20 tasks, 3 models, log failure modes
- [ ] Pick the default model from your own numbers, not published benchmarks
- [ ] `npm create tauri-app@latest` only after P0 passes

---

## Reference implementations worth reading

- **Dyad** (`dyad-sh/dyad`) — closest to this design. Local-first, real codebases on disk. Read its agent loop.
- **bolt.diy** (`stackblitz-labs/bolt.diy`) — WebContainer approach. Good prompt engineering in `app/lib/.server/llm/prompts.ts`.
- **Aider** — steal the search/replace diff format and the repo map wholesale.
- **Cline** — clean tool-use loop, handles approval gates well.
- **Zed** — for how to do PTY, LSP, and process management in Rust properly.