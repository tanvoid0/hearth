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

**The finding that matters:** this dev machine has no GPU (`ollama ps` shows
`size_vram: 0`), so gpt-oss runs entirely on CPU — single tasks took 2–9+
minutes (worse when something else was competing for CPU, e.g. a concurrent
`cargo build`). The tool-loop *design* is validated. The *hardware* isn't
fast enough yet for a snappy interactive agent. Per build plan §9 ("be honest
about hardware fit"), this is a real constraint, not a harness bug — see
Decisions Needed below.

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

---

## Remaining work

Following the build plan's phase order (§8). Each phase should land as a
usable increment, not a partial cut.

### Milestone A — finish the local IDE (no AI)

- [ ] **P2 · Terminal** — xterm.js + `portable-pty` (Rust), multiple tabs,
      per-project cwd, shell detection (pwsh/cmd on Windows), scrollback
      search. See plan §4.3 — note the requirement that the *agent's* future
      command execution gets a separate PTY from the user's, so worth
      designing the PTY manager with that split from the start rather than
      retrofitting later.
- [ ] **P3 · Runner** — process supervisor: package-manager detection,
      script running, port allocation, health states
      (`stopped/installing/starting/ready/crashed/port-conflict`), clean
      teardown (Windows orphan-process handling flagged in plan §9 as a
      known pain point), install-on-demand for missing deps.
- [ ] **P4 · Browser** — preview `<iframe>`, URL bar, viewport presets,
      console-capture bridge (`postMessage` from injected script), network
      panel. Element picker explicitly deferred to P12.

*End state: a usable local IDE — edit, run, preview — with no AI involved
yet.*

### Milestone B — local models

- [ ] **P5 · Model manager** — Ollama client wrapper: list/pull-with-progress/
      load/unload, `num_ctx` slider with live VRAM estimate, hardware
      detection. Given the P0 finding (CPU-only, no GPU on this machine),
      the "be honest when a model won't fit" UI requirement from plan §6
      is not hypothetical here — build and test it against this actual
      hardware.
- [ ] **P6 · Chat** — streaming chat against the loaded model, markdown/code
      rendering, conversation persistence (SQLite via `tauri-plugin-sql`).
      No tools yet.

### Milestone C — the agent

- [ ] **P7 · Tool loop** ← the hard one. Tool registry, PLAN/ACT/VERIFY,
      diff application (reuse `p0-spike/src/tools.ts`'s edit_file logic —
      it already implements the exact→whitespace-normalized→fail-loud
      contract from plan §5), approval gates, agent PTY session, iteration
      caps. Before starting this, revisit the CPU-speed question below —
      an 8-15 iteration loop at P0's observed per-call latency is not a
      usable interactive experience.
- [ ] **P8 · Diff review** — Monaco diff per file, accept/reject per hunk,
      editor decorations during agent writes, checkpoint cards.
- [ ] **P9 · LSP + Problems** — `typescript-language-server` sidecar,
      diagnostics into Monaco + Problems panel + agent's `get_errors()`.
      Plan explicitly says don't defer this past P9.
- [ ] **P10 · Error feedback loop** — merge LSP + build + browser console
      into `get_errors()`, capped auto-repair rounds, loop detection.

### Milestone D — polish

- [ ] **P11 · Codebase context** — repo map from LSP/tree-sitter symbols,
      ripgrep search tool.
- [ ] **P12 · Inline edit, FIM, element picker.**
- [ ] **P13 · Source control panel** — staging, hunks, branches, commit UI,
      checkpoint timeline.
- [ ] **P14 · Templates, secrets, export.**

---

## Decisions needed before going further

These are judgment calls, not something to guess at — flagging them here so
they don't get silently decided by momentum.

1. **CPU-only hardware.** P0 showed gpt-oss (20B) taking minutes per turn
   on CPU. Before sinking P7's "2 weeks, the hard one" into a tool loop that
   might feel unusably slow, worth either (a) testing a smaller model
   (`qwen2.5-coder:7b` or similar) to see if turn time becomes tolerable,
   or (b) accepting slow-but-correct as fine for a first agent cut and
   optimizing later. First-session checklist (plan §10) already flags
   pulling `devstral:24b`/`qwen3-coder:30b` — those are *larger* than what
   just struggled on CPU here, so that recommendation may need revisiting
   for this specific machine.
2. **Widen the P0 task set.** Current harness has 8 tasks / 2 models; the
   plan calls for "20 tasks × 3 models." Worth doing once a faster model
   candidate is in the mix — no point widening against a model (qwen:latest)
   that's already disqualified for lacking tool support.
3. **P1 scope-creep candidates.** Command palette (`Cmd+P`/`Cmd+Shift+P`) is
   flagged in the plan as "cheap to build, disproportionate UX payoff" —
   consider pulling it into the P1 done-column before starting P2, since
   it's small and immediately useful for daily-driving the editor.

---

## How to resume

```bash
# P0 — re-run or widen the spike
cd p0-spike && npm run spike -- "gpt-oss:latest,qwen2.5-coder:7b"

# P1 — run the app
cd hearth-app && npm run tauri dev
```
