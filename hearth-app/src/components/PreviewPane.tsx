import { useEffect, useRef, useState } from "react";
import { useHearthStore } from "../lib/store";
import { projectScripts, useRunner } from "../lib/runner";
import { formatEntry, STATUS_TEXT } from "../lib/runlog";

/** Build plan §4.2. Widths only: the height is whatever the pane has, and a
 *  letterboxed device frame would cost vertical space to say nothing. */
const VIEWPORTS: Array<{ label: string; width: number | null }> = [
  { label: "Full", width: null },
  { label: "Mobile", width: 375 },
  { label: "Tablet", width: 768 },
  { label: "Desktop", width: 1280 },
];

export function PreviewPane() {
  const projectRoot = useHearthStore((s) => s.projectRoot);
  const { running, status, script, url, log, nonce, consoleLog, start, stop, reload } = useRunner();
  // The log is the whole UI while installing, so it opens itself and only
  // collapses once there's a page to look at instead.
  const [showLog, setShowLog] = useState(false);
  const logOpen = showLog || !url;

  const [scripts, setScripts] = useState<Array<{ name: string; serve: boolean }>>([]);
  const [width, setWidth] = useState<number | null>(null);
  // The path under the origin. Kept separate from `url` because the origin is
  // the runner's (its port is allocated per run) and only the path is the
  // user's to type.
  const [path, setPath] = useState("/");
  const [draft, setDraft] = useState("/");
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (projectRoot) void projectScripts(projectRoot).then(setScripts);
  }, [projectRoot]);

  // A fresh run is a fresh server; a path typed against the old one may not
  // exist under the new one, and starting anywhere but the root is surprising.
  useEffect(() => {
    setPath("/");
    setDraft("/");
  }, [url]);

  // A log pinned to its first line looks identical to a hung install, which is
  // the one thing this pane exists to disambiguate.
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => logEnd.current?.scrollIntoView({ block: "end" }), [log.length, consoleLog.length]);

  // The preview page forwards its runtime errors here (see BRIDGE_JS in
  // workspace.ts) — the iframe is a different origin, so postMessage is the
  // only channel. Bound to the iframe's lifetime on purpose: no iframe means no
  // page, and `consoleAttached` has to go false rather than leave the agent
  // reading a stale buffer as a clean bill of health.
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow) return;
      const data = e.data;
      if (!data || data.source !== "hearth" || typeof data.kind !== "string") return;
      const { attachConsole, pushConsole } = useRunner.getState();
      if (data.kind === "ready") {
        attachConsole();
        setPicking(false); // a reload is a new document, and it isn't picking
      } else if (data.kind === "picked") {
        // Into the composer rather than straight to the agent: what you clicked
        // is the subject of a request, not the request.
        useHearthStore.getState().appendComposer(`the element \`${String(data.text ?? "")}\``);
        setPicking(false);
      } else {
        pushConsole(data.kind, String(data.text ?? ""));
      }
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      useRunner.getState().detachConsole();
    };
  }, []);

  /** Plan §12's element picker. The page does the picking (it's cross-origin);
   *  this only turns it on and off. */
  function togglePicking() {
    const next = !picking;
    setPicking(next);
    frame.current?.contentWindow?.postMessage({ source: "hearth-parent", picking: next }, "*");
  }

  function navigate() {
    const next = draft.startsWith("/") ? draft : `/${draft}`;
    setDraft(next);
    setPath(next);
    // Same path, new nonce: asking for the page you're already on has to
    // reload it rather than do nothing.
    if (next === path) reload();
  }

  const statusText = url && path === "/" ? url : STATUS_TEXT[status];

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-neutral-800">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2">
        {running ? (
          <button
            onClick={() => void stop()}
            className="shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-[12px] text-neutral-200 hover:bg-neutral-700"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => projectRoot && void start(projectRoot, script)}
            className="shrink-0 rounded bg-neutral-700 px-2 py-0.5 text-[12px] text-neutral-100 hover:bg-neutral-600"
          >
            Run
          </button>
        )}

        {/* Which script. Hidden while running: changing it mid-run would say
            something untrue about what's actually up. */}
        {!running && scripts.length > 0 && (
          <select
            value={script}
            onChange={(e) => useRunner.setState({ script: e.target.value })}
            title="Which package.json script Run starts"
            className="shrink-0 rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-300 outline-none"
          >
            {scripts.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
            {!scripts.some((s) => s.name === script) && <option value={script}>{script}</option>}
          </select>
        )}

        {url ? (
          <>
            <button
              onClick={reload}
              className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              ↻
            </button>
            {/* The origin is the runner's, and it changes every run — so only
                the path is editable. There's no way to read back where the page
                navigated itself to: the iframe is a different origin. */}
            <div className="flex min-w-0 flex-1 items-center rounded bg-neutral-800 px-1.5 text-[11px]">
              <span className="shrink-0 text-neutral-600">{url.replace(/\/$/, "")}</span>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && navigate()}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent py-0.5 text-neutral-200 outline-none"
              />
            </div>
          </>
        ) : (
          <span className={`min-w-0 flex-1 truncate text-[11px] ${status === "crashed" ? "text-red-400" : "text-neutral-500"}`}>
            {log.length > 0 && status !== "port-conflict" ? (log[log.length - 1] ?? statusText) : statusText}
          </span>
        )}

        {url && (
          <button
            onClick={togglePicking}
            title="Click something in the page to name it in the agent prompt. Needs the console bridge, so a project Hearth didn't scaffold has to be running through the generated vite config."
            className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
              picking ? "bg-sky-900 text-sky-100" : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
            }`}
          >
            ⌖
          </button>
        )}

        {url && (
          <select
            value={String(width ?? "")}
            onChange={(e) => setWidth(e.target.value ? Number(e.target.value) : null)}
            title="Viewport width"
            className="shrink-0 rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-400 outline-none"
          >
            {VIEWPORTS.map((v) => (
              <option key={v.label} value={String(v.width ?? "")}>
                {v.label}
                {v.width ? ` ${v.width}` : ""}
              </option>
            ))}
          </select>
        )}

        {/* A runtime error leaves a blank page and an empty dev-server log, so
            with the drawer collapsed there'd be nothing at all to see. */}
        {consoleLog.length > 0 && (
          <button
            onClick={() => setShowLog(true)}
            className="shrink-0 rounded bg-amber-950 px-1.5 py-0.5 text-[11px] text-amber-300 hover:bg-amber-900"
          >
            {consoleLog.length} console
          </button>
        )}

        <button
          onClick={() => setShowLog((v) => !v)}
          className="shrink-0 text-[11px] text-neutral-500 hover:text-neutral-300"
        >
          {logOpen ? "hide log" : "log"}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {url && (
          <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-neutral-950">
            <iframe
              ref={frame}
              key={`${url}#${path}#${nonce}`}
              src={url.replace(/\/$/, "") + path}
              title="Preview"
              style={width ? { width, flex: "none" } : undefined}
              className="min-h-0 w-full flex-1 border-0 bg-white"
            />
          </div>
        )}

        {logOpen && (
          <div
            className={`min-h-0 overflow-y-auto bg-neutral-950 px-2 py-1 font-mono text-[11px] leading-relaxed text-neutral-400 ${
              url ? "h-32 border-t border-neutral-800" : "flex-1"
            }`}
          >
            {log.length === 0 && (
              <p className="p-2 text-neutral-600">
                {running ? STATUS_TEXT[status] : "Run installs dependencies if needed, then starts the selected script."}
              </p>
            )}
            {log.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))}
            {consoleLog.length > 0 && (
              <>
                <div className="mt-2 border-t border-neutral-800 pt-1 text-neutral-600">browser console</div>
                {consoleLog.map((entry, i) => (
                  <div
                    key={i}
                    className={`whitespace-pre-wrap break-all ${
                      entry.text.startsWith("net:") ? "text-sky-400" : "text-amber-400"
                    }`}
                  >
                    {formatEntry(entry)}
                  </div>
                ))}
              </>
            )}
            <div ref={logEnd} />
          </div>
        )}
      </div>
    </div>
  );
}
