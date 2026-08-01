import { useEffect, useRef, useState } from "react";
import { useHearthStore } from "../lib/store";
import { runAgent, type ApprovalRequest } from "../lib/agent";
import { chatFor, useChatStore, type Entry } from "../lib/chat";
import type { ChatMessage } from "../lib/ollama";
import { pullPercent, type PullState } from "../lib/pull";
import { changedFiles, commitAll, ensureRepo, fileVersions, restore } from "../lib/git";
import { changeLabel, type FileChange } from "../lib/gitdiff";
import { RichText } from "./RichText";
import {
  cancelChat,
  CTX_KEY,
  DEFAULT_NUM_CTX,
  listModels,
  loadedModel,
  MODEL_KEY,
  pullModel,
  totalVramGb,
  unloadModel,
  type LoadedModel,
  type ModelInfo,
} from "../lib/ollama";

const PLAN_KEY = "hearth.plan";
const ASK_KEY = "hearth.ask";
/** Only while a turn is in flight — that's when the split is worth knowing and
 *  the only time it changes on its own. */
const LOAD_POLL_MS = 5000;

/** Discrete steps rather than a slider: the KV cache scales with this, and the
 *  values between powers of two buy nothing worth a drag gesture. No per-model
 *  ceiling is looked up — Ollama clamps to what the model supports, and the
 *  badge reports what it actually got. */
const CTX_CHOICES = [4096, 8192, 16384, 32768];

function LoadBadge({
  load,
  numCtx,
  totalVram,
  onUnload,
}: {
  load: LoadedModel;
  numCtx: number;
  totalVram: number | null;
  /** Absent while a turn is in flight — unloading mid-turn kills it. */
  onUnload?: () => void;
}) {
  const onGpu = load.gpuPercent >= 100;
  // The split belongs to the context the model was loaded with. Change the
  // setting and this number describes the old one until the next turn reloads
  // the model — say which, rather than reporting a reassuring stale number.
  const stale = load.contextLength > 0 && load.contextLength !== numCtx;
  const onCpuGb = (load.sizeGb * (1 - load.gpuPercent / 100)).toFixed(1);
  // Both numbers measured. Nothing here estimates what an *unloaded* model
  // would take: on this machine the disk-size-to-VRAM ratio ranges 0.35×–1.21×
  // across three models, so a predicted footprint would be worse than none.
  const headroom =
    totalVram === null
      ? ""
      : ` Using ${(load.sizeGb * (load.gpuPercent / 100)).toFixed(1)}GB of ${totalVram.toFixed(1)}GB VRAM.`;
  return (
    <button
      onClick={onUnload}
      disabled={!onUnload}
      title={
        [
          onGpu
            ? `Fully in VRAM at num_ctx ${load.contextLength}.`
            : `${onCpuGb}GB of ${load.sizeGb.toFixed(1)}GB is on the CPU at num_ctx ${load.contextLength}. Expect minutes per step — a smaller model or a lower context fits.`,
          stale ? `Set to ${numCtx}; takes effect when the model reloads on the next turn.` : "",
        ]
          .filter(Boolean)
          .join(" ") +
        headroom +
        (onUnload ? " Click to unload it and free that VRAM now." : "")
      }
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] enabled:hover:brightness-125 ${
        stale
          ? "bg-neutral-800 text-neutral-500"
          : onGpu
            ? "bg-emerald-950 text-emerald-400"
            : "bg-amber-950 text-amber-400"
      }`}
    >
      {load.gpuPercent}% GPU{stale ? ` at ${load.contextLength / 1024}k` : ""}
    </button>
  );
}

/** Three frames of a pixel flame — the hearth, working. `o` is the body, `i`
 *  the hot core, `.` nothing. Only the tip differs between frames; a base that
 *  moves too reads as a bouncing icon rather than a fire. */
const FLAME_FRAMES = [
  ["...o...", "..ooo..", "..ooo..", ".ooioo.", ".oiiio.", "ooiiioo", "ooiiioo", ".ooooo.", "..ooo.."],
  ["..o....", "..oo...", ".ooo...", ".ooio..", "ooiiio.", "ooiiioo", "ooiiioo", ".ooooo.", "..ooo.."],
  ["....o..", "...oo..", "...ooo.", "..oioo.", ".oiiioo", "ooiiioo", "ooiiioo", ".ooooo.", "..ooo.."],
];

/**
 * The activity indicator, as a picture rather than a moving word.
 *
 * A turn on a local model runs for minutes, and this is the one thing on screen
 * that separates "working" from "hung" — so it has to read as movement from
 * across the desk, which text dressed up with an animation doesn't. Frames are
 * stacked in one SVG and cycled in CSS (`.hearth-flame`), which is a sprite
 * animation with no image file, no decoder and nothing to load.
 */
function ThinkingFlame() {
  return (
    <svg viewBox="0 0 7 9" className="hearth-flame h-3 w-[9px] shrink-0" aria-hidden="true">
      {FLAME_FRAMES.map((rows, frame) => (
        <g key={frame}>
          {rows.flatMap((row, y) =>
            [...row].map((px, x) =>
              px === "." ? null : (
                <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={px === "i" ? "#fcd34d" : "#f97316"} />
              ),
            ),
          )}
        </g>
      ))}
    </svg>
  );
}

function ToolRow({ entry }: { entry: Extract<Entry, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[12px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left font-mono text-neutral-400 hover:bg-neutral-800"
      >
        <span className={entry.ok ? "text-emerald-500" : "text-red-400"}>{entry.ok ? "✓" : "✗"}</span>
        <span className="truncate">{entry.label}</span>
      </button>
      {open && (
        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-900 p-2 text-[11px] text-neutral-400">
          {entry.detail}
        </pre>
      )}
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  A: "text-emerald-500",
  M: "text-amber-500",
  D: "text-red-400",
};

/** One agent turn's commit, in the timeline where the turn happened. The files
 *  open as diffs; the whole thing rolls back with one button — both are git
 *  calls against `.hearth/git`, not a snapshot store (plan §7). */
function CheckpointCard({ entry, root }: { entry: Extract<Entry, { kind: "checkpoint" }>; root: string }) {
  const [busy, setBusy] = useState(false);
  const short = entry.sha.slice(0, 7);
  const report = (text: string) => useChatStore.getState().addEntry(root, { kind: "error", text });

  async function review(file: FileChange) {
    try {
      const { before, after } = await fileVersions(root, entry.sha, file.path);
      useHearthStore.getState().openDiff({
        path: file.path,
        label: `checkpoint ${short}`,
        original: before,
        modified: after,
        sha: entry.sha,
      });
    } catch (err) {
      report((err as Error).message);
    }
  }

  async function restoreHere() {
    if (!confirm(`Restore the project to checkpoint ${short}?\n\nEverything changed after it is discarded.`)) return;
    setBusy(true);
    try {
      await restore(root, entry.sha);
      useHearthStore.getState().closeDiff();
      await useHearthStore.getState().rehydrateFromDisk();
      // The conversation still describes files that no longer look like that,
      // and nothing tells the model the ground moved under it.
      useChatStore.getState().addEntry(root, {
        kind: "note",
        text: `restored to ${short} — start a new chat if the agent works from the files it remembers`,
      });
    } catch (err) {
      report((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/60 text-[12px]">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1">
        <span className="font-mono text-[11px] text-neutral-500">◈ {short}</span>
        <span className="text-[11px] text-neutral-500">
          {entry.files.length} file{entry.files.length === 1 ? "" : "s"}
        </span>
        <button
          onClick={() => void restoreHere()}
          disabled={busy}
          title="Reset the project to how it looked right after this turn. Untracked files are left alone."
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
        >
          Restore
        </button>
      </div>
      {entry.files.map((f) => (
        <button
          key={f.path}
          onClick={() => void review(f)}
          className="flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-[11px] hover:bg-neutral-800"
        >
          <span className={`w-3 shrink-0 ${STATUS_COLOR[f.status] ?? "text-neutral-500"}`} title={changeLabel(f.status)}>
            {f.status}
          </span>
          <span className="truncate text-neutral-300">{f.path}</span>
        </button>
      ))}
    </div>
  );
}

export function ChatPanel() {
  const projectRoot = useHearthStore((s) => s.projectRoot);
  const activePath = useHearthStore((s) => s.activePath);
  const pendingPrompt = useHearthStore((s) => s.pendingPrompt);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? "");
  const [numCtx, setNumCtx] = useState(() => Number(localStorage.getItem(CTX_KEY)) || DEFAULT_NUM_CTX);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState("");
  // In the store, not local state: the preview's element picker writes into it.
  const input = useHearthStore((s) => s.composer);
  const setInput = useHearthStore((s) => s.setComposer);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [load, setLoad] = useState<LoadedModel | null>(null);
  // Fixed for the life of the process — fetched once, not polled with the split.
  const [totalVram, setTotalVram] = useState<number | null>(null);
  const [pullName, setPullName] = useState<string | null>(null);
  const [pull, setPull] = useState<PullState | null>(null);
  // Default on: plan §6 calls PLAN the biggest quality lever for local models,
  // and it costs one call.
  const [planFirst, setPlanFirst] = useState(() => localStorage.getItem(PLAN_KEY) !== "0");
  // Default off: checkpoints already make every turn reversible, so the gate is
  // for people who want to watch rather than the only thing standing between a
  // bad edit and a lost afternoon.
  const [askFirst, setAskFirst] = useState(() => localStorage.getItem(ASK_KEY) === "1");
  const [pending, setPending] = useState<(ApprovalRequest & { resolve: (ok: boolean) => void }) | null>(null);

  // `interrupted` is a turn this panel never got to finish — the page was
  // reloaded or the app was killed while the model was working. It outlives the
  // process it started in; `running` doesn't.
  const { entries, pending: interrupted } = useChatStore(chatFor(projectRoot));
  const addEntry = useChatStore((s) => s.addEntry);
  const dropPending = useChatStore((s) => s.dropPending);
  const clearChat = useChatStore((s) => s.clearChat);

  const stopRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Names the model call in flight, so Stop can abort it rather than wait it
   *  out. A model on the CPU spends minutes inside one call. */
  const cancelRef = useRef("");

  /** Hold the turn until the user answers. Resolving false refuses that one
   *  call; the turn carries on and the model is told no. */
  function requestApproval(request: ApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => setPending({ ...request, resolve }));
  }

  function answer(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  function stop() {
    stopRef.current = true;
    answer(false); // a gate left open would hold the turn forever
    void cancelChat(cancelRef.current);
  }

  async function loadModels() {
    setModelsError(null);
    try {
      const list = await listModels();
      setModels(list);
      setModel((current) => (current && list.some((m) => m.name === current) ? current : (list[0]?.name ?? "")));
    } catch (err) {
      setModelsError((err as Error).message);
    }
  }

  useEffect(() => {
    void loadModels();
    void totalVramGb().then(setTotalVram);
  }, []);

  useEffect(() => {
    if (model) localStorage.setItem(MODEL_KEY, model);
  }, [model]);

  useEffect(() => {
    localStorage.setItem(CTX_KEY, String(numCtx));
  }, [numCtx]);

  useEffect(() => {
    localStorage.setItem(PLAN_KEY, planFirst ? "1" : "0");
    localStorage.setItem(ASK_KEY, askFirst ? "1" : "0");
  }, [planFirst, askFirst]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries, streaming]);

  async function startPull(name: string) {
    if (!name || pull) return;
    let last: PullState = { layers: {}, status: "starting…", done: false };
    setPull(last);
    try {
      await pullModel(name, (s) => {
        last = s;
        setPull(s);
      });
    } catch (err) {
      setPull({ layers: {}, status: String(err), done: true, error: String(err) });
      return;
    }
    // A failed pull leaves the row up showing why, rather than closing over the
    // reason — Ollama reports a bad model name in the stream, not as a throw.
    if (last.error) return;
    await loadModels();
    setModel(name);
    setPullName(null);
    setPull(null);
  }

  // A model that doesn't fit in VRAM falls back to CPU and takes minutes per
  // turn — a live counter is the difference between "working" and "hung".
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(id);
  }, [running]);

  // Ollama only reports a split for a model that's actually loaded, and loading
  // happens on the first call — so this has to keep looking during a turn, not
  // once before it. Idle models unload themselves, hence the re-check on switch.
  useEffect(() => {
    if (!model) return setLoad(null);
    let alive = true;
    const check = () =>
      loadedModel(model).then(
        (l) => alive && setLoad(l),
        () => alive && setLoad(null)
      );
    void check();
    if (!running) return () => void (alive = false);
    const id = setInterval(check, LOAD_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [model, running]);

  // Conversations are keyed by project root in the store, so switching projects
  // switches transcripts rather than resetting one — only the in-flight token
  // buffer, which belongs to the project being left, has to go.
  useEffect(() => {
    setStreaming("");
  }, [projectRoot]);

  // A reload doesn't stop the model — the request lives in the Rust process,
  // which streams on into a channel the dead page took with it. Kill the orphan
  // as soon as one is spotted: it's holding the GPU that a resume needs, and
  // Ollama would otherwise generate the rest of a reply nobody can read. Safe
  // when the id is already gone (app restart, turn finished): cancel of an
  // unknown id is a no-op.
  useEffect(() => {
    if (interrupted && !running) void cancelChat(interrupted.cancelId);
  }, [interrupted?.cancelId, running]);

  // A project created from a prompt runs that prompt as its first turn. Waits
  // on `model` because the picker is populated by an async /api/tags call.
  useEffect(() => {
    if (!pendingPrompt || !model || running) return;
    const prompt = useHearthStore.getState().takePendingPrompt();
    if (prompt) void send(prompt);
  }, [pendingPrompt, model, running]);

  /** `resume` is an interrupted turn's messages: the same turn carrying on,
   *  rather than the same prompt asked again from nothing. */
  async function send(prompt: string, resume?: ChatMessage[]) {
    if (!prompt || running || !projectRoot || !model) return;
    const root = projectRoot;
    const add = (entry: Entry) => addEntry(root, entry);

    // The prompt is already in the transcript when resuming — this is the turn
    // the user is looking at, not a new one.
    if (!resume) add({ kind: "user", text: prompt });
    setStreaming("");
    setRunning(true);
    setElapsed(0);
    stopRef.current = false;
    cancelRef.current = `${root}#${Date.now()}`;
    // Marks the turn in flight *before* the first await. Everything from here
    // to `endTurn` can be cut short by a reload, and what survives it is what
    // was written to the store.
    useChatStore.getState().beginTurn(root, prompt, cancelRef.current, resume);

    // Baseline the project before the turn, so the checkpoint below is this
    // turn's diff rather than the whole project. First call on a large repo
    // does an `add -A`; it runs under the "thinking…" indicator rather than
    // before it for that reason. A failure here surfaces from the commit.
    try {
      await ensureRepo(root);
    } catch {
      /* reported by the checkpoint attempt after the turn */
    }

    const history = await runAgent({
      model,
      root,
      prompt,
      history: useChatStore.getState().chats[root]?.history ?? [],
      activeFile: activePath,
      numCtx,
      cancelId: cancelRef.current,
      plan: planFirst,
      resume,
      // Every step the turn could be picked up from, written where a reload
      // can find it. A turn cut off after ten minutes of tool calls resumes
      // holding all of them, rather than paying for them twice.
      onStep: (messages) => useChatStore.getState().stepTurn(root, messages),
      approve: askFirst ? requestApproval : undefined,
      shouldStop: () => stopRef.current,
      onEvent: (event) => {
        switch (event.type) {
          case "token":
            setStreaming((s) => s + event.text);
            break;
          case "assistant":
            setStreaming("");
            add({ kind: "assistant", text: event.content });
            break;
          case "plan":
            setStreaming("");
            add({ kind: "plan", text: event.text });
            break;
          case "tool":
            add({ kind: "tool", label: event.label, ok: event.ok, detail: event.detail });
            break;
          case "error":
            add({ kind: "error", text: event.text });
            break;
          case "done":
            setStreaming("");
            if (event.reason !== "finished" && event.reason !== "replied") {
              add({ kind: "note", text: event.reason });
            }
            break;
        }
      },
    });

    // Commits the turn and clears the in-flight marker together: a history that
    // landed without the marker being dropped would offer to run it all again.
    useChatStore.getState().endTurn(root, history);

    // Checkpoint the turn (plan §7). Wrapped, because git can be missing
    // entirely and a failed commit must not cost the user the turn that
    // produced the changes — only the ability to review and roll it back.
    try {
      const sha = await commitAll(root, prompt);
      if (sha) add({ kind: "checkpoint", sha, files: await changedFiles(root, sha) });
    } catch (err) {
      add({ kind: "note", text: `no checkpoint: ${(err as Error).message}` });
    }

    setRunning(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-900">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-800 px-2">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="min-w-0 flex-1 truncate rounded bg-neutral-800 px-1.5 py-1 text-[12px] text-neutral-200 outline-none"
        >
          {models.length === 0 && <option value="">no models</option>}
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} · {m.sizeGb.toFixed(1)}GB
            </option>
          ))}
        </select>
        <select
          value={numCtx}
          onChange={(e) => setNumCtx(Number(e.target.value))}
          title="Context window. Larger lets the agent hold more files at once, but the KV cache comes out of the same VRAM — push it too far and the model spills to CPU."
          className="shrink-0 rounded bg-neutral-800 px-1.5 py-1 text-[12px] text-neutral-400 outline-none"
        >
          {CTX_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n / 1024}k
            </option>
          ))}
        </select>
        {load && (
          <LoadBadge
            load={load}
            numCtx={numCtx}
            totalVram={totalVram}
            onUnload={
              running
                ? undefined
                : () => {
                    void unloadModel(load.name).then(() => setLoad(null));
                  }
            }
          />
        )}
        <button
          onClick={() => setPullName((v) => (v === null ? "" : null))}
          title="Download a model"
          className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-[12px] text-neutral-300 hover:bg-neutral-700"
        >
          +
        </button>
        <button
          onClick={() => {
            if (projectRoot) clearChat(projectRoot);
            setStreaming("");
          }}
          title="New chat"
          className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-[12px] text-neutral-300 hover:bg-neutral-700"
        >
          New
        </button>
      </div>

      {pullName !== null && (
        <div className="shrink-0 border-b border-neutral-800 px-2 py-1.5">
          <div className="flex items-center gap-2">
            <input
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void startPull(pullName.trim())}
              disabled={!!pull}
              autoFocus
              placeholder="model to pull, e.g. devstral:24b"
              className="min-w-0 flex-1 rounded bg-neutral-800 px-1.5 py-1 text-[12px] text-neutral-100 outline-none placeholder:text-neutral-600 disabled:opacity-50"
            />
            <button
              onClick={() => void startPull(pullName.trim())}
              disabled={!pullName.trim() || !!pull}
              className="shrink-0 rounded bg-neutral-700 px-2 py-1 text-[12px] text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
            >
              Pull
            </button>
          </div>
          {pull && (
            <div className={`mt-1 text-[11px] ${pull.error ? "text-red-400" : "text-neutral-500"}`}>
              {/* Multi-GB and minutes long — the status text carries the phases
                  that have no byte count at all (manifest, verify, write). */}
              {pull.status}
              {pullPercent(pull) !== null && ` · ${pullPercent(pull)}%`}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {modelsError && (
          <div className="rounded border border-red-900 bg-red-950/40 p-2 text-[12px] text-red-300">
            {modelsError}
            <button onClick={() => void loadModels()} className="ml-2 underline">
              retry
            </button>
          </div>
        )}
        {entries.map((entry, i) => {
          if (entry.kind === "tool") return <ToolRow key={i} entry={entry} />;
          if (entry.kind === "checkpoint")
            return projectRoot ? <CheckpointCard key={i} entry={entry} root={projectRoot} /> : null;
          if (entry.kind === "user")
            return (
              <div key={i} className="whitespace-pre-wrap rounded bg-neutral-800 px-2 py-1.5 text-[13px] text-neutral-100">
                {entry.text}
              </div>
            );
          if (entry.kind === "error")
            return (
              <div key={i} className="whitespace-pre-wrap rounded border border-red-900 bg-red-950/40 px-2 py-1.5 text-[12px] text-red-300">
                {entry.text}
              </div>
            );
          if (entry.kind === "note")
            return (
              <div key={i} className="px-2 text-[11px] uppercase tracking-wide text-neutral-600">
                {entry.text}
              </div>
            );
          if (entry.kind === "plan")
            return (
              <div key={i} className="rounded border-l-2 border-neutral-700 bg-neutral-950/60 px-2 py-1.5">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-600">plan</div>
                <RichText text={entry.text} />
              </div>
            );
          return <RichText key={i} text={entry.text} />;
        })}

        {streaming && <RichText text={streaming} />}
        {running && (
          <div className="flex items-center gap-1.5 px-2 text-[11px] text-neutral-500">
            <ThinkingFlame />
            <span>
              {streaming ? "writing" : "thinking"}… {elapsed}s
            </span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* A turn that died with the page. Offered rather than restarted on its
          own: the reload is often the user escaping a turn that was going
          nowhere, and a turn that took the app down with it would relaunch
          itself on every start. */}
      {interrupted && !running && (
        <div className="shrink-0 border-t border-amber-900/60 bg-amber-950/20 p-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] text-amber-200" title={interrupted.prompt}>
              Interrupted: {interrupted.prompt}
            </span>
            <button
              onClick={() => void send(interrupted.prompt, interrupted.partial)}
              disabled={!model}
              className="shrink-0 rounded bg-emerald-900/70 px-2 py-0.5 text-[12px] text-emerald-100 hover:bg-emerald-900 disabled:opacity-40"
            >
              {interrupted.partial ? "Resume" : "Retry"}
            </button>
            <button
              onClick={() => projectRoot && dropPending(projectRoot)}
              title="Leave the turn unfinished. The files it already changed stay as they are."
              className="shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-[12px] text-neutral-300 hover:bg-neutral-700"
            >
              Dismiss
            </button>
          </div>
          <div className="mt-1 text-[11px] text-neutral-500">
            {interrupted.partial
              ? "Carries on from its last completed step, keeping what it had already read and changed."
              : "Died before its first step — this starts the turn again from the prompt."}
          </div>
        </div>
      )}

      {/* The gate. Above the composer rather than in the transcript because the
          turn is blocked on it — a prompt that scrolls away is one the user
          waits on without knowing why. */}
      {pending && (
        <div className="shrink-0 border-t border-amber-900/60 bg-amber-950/20 p-2">
          <div className="mb-1 flex items-center gap-2">
            <span className="truncate font-mono text-[12px] text-amber-200">{pending.label}</span>
            <button
              onClick={() => answer(true)}
              className="ml-auto shrink-0 rounded bg-emerald-900/70 px-2 py-0.5 text-[12px] text-emerald-100 hover:bg-emerald-900"
            >
              Allow
            </button>
            <button
              onClick={() => answer(false)}
              className="shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-[12px] text-neutral-300 hover:bg-neutral-700"
            >
              Refuse
            </button>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-950 p-2 text-[11px] text-neutral-400">
            {pending.detail}
          </pre>
        </div>
      )}

      <div className="shrink-0 border-t border-neutral-800 p-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              setInput("");
              void send(input.trim());
            }
          }}
          rows={3}
          placeholder="Ask the model to change this project…"
          className="w-full resize-none rounded bg-neutral-800 p-2 text-[13px] text-neutral-100 outline-none placeholder:text-neutral-600 disabled:opacity-50"
        />
        <div className="mt-1 flex items-center gap-1.5">
          <button
            onClick={() => setPlanFirst((v) => !v)}
            title="Ask the model for a numbered plan before it touches anything. One extra call per turn, and the biggest quality lever there is for a local model."
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              planFirst ? "bg-neutral-700 text-neutral-100" : "bg-neutral-800 text-neutral-500 hover:text-neutral-300"
            }`}
          >
            Plan
          </button>
          <button
            onClick={() => setAskFirst((v) => !v)}
            title="Show every file write and every command before it happens, and wait for you. Off by default: every turn is a checkpoint you can roll back."
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              askFirst ? "bg-neutral-700 text-neutral-100" : "bg-neutral-800 text-neutral-500 hover:text-neutral-300"
            }`}
          >
            Ask first
          </button>
          <span className="ml-auto truncate text-[11px] text-neutral-600">Enter to send</span>
          {running ? (
            <button
              onClick={stop}
              title="Aborts the model call in flight, not just the next step."
              className="rounded bg-red-900/70 px-2 py-1 text-[12px] text-red-200 hover:bg-red-900"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => {
                setInput("");
                void send(input.trim());
              }}
              disabled={!input.trim() || !model}
              className="rounded bg-neutral-700 px-2.5 py-1 text-[12px] text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
