import { useEffect, useRef, useState } from "react";
import { useHearthStore } from "../lib/store";
import { useRunner } from "../lib/runner";
import { formatEntry } from "../lib/runlog";

export function PreviewPane() {
  const projectRoot = useHearthStore((s) => s.projectRoot);
  const { running, url, log, nonce, consoleLog, start, stop, reload } = useRunner();
  // The log is the whole UI while installing, so it opens itself and only
  // collapses once there's a page to look at instead.
  const [showLog, setShowLog] = useState(false);
  const logOpen = showLog || !url;

  // A log pinned to its first line looks identical to a hung install, which is
  // the one thing this pane exists to disambiguate.
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => logEnd.current?.scrollIntoView({ block: "end" }), [log.length, consoleLog.length]);

  // The preview page forwards its runtime errors here (see CONSOLE_BRIDGE in
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
      if (data.kind === "ready") attachConsole();
      else pushConsole(data.kind, String(data.text ?? ""));
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      useRunner.getState().detachConsole();
    };
  }, []);

  const status = url ?? (running ? (log[log.length - 1] ?? "Starting…") : "Not running");

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-neutral-800">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2">
        {running ? (
          <button
            onClick={() => void stop()}
            className="rounded bg-neutral-800 px-2 py-0.5 text-[12px] text-neutral-200 hover:bg-neutral-700"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => projectRoot && void start(projectRoot)}
            className="rounded bg-neutral-700 px-2 py-0.5 text-[12px] text-neutral-100 hover:bg-neutral-600"
          >
            Run
          </button>
        )}

        {url && (
          <button
            onClick={reload}
            className="rounded px-1.5 py-0.5 text-[12px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            Reload
          </button>
        )}

        <span className={`min-w-0 flex-1 truncate text-[11px] ${url ? "text-neutral-400" : "text-neutral-500"}`}>
          {status}
        </span>

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
          <iframe
            ref={frame}
            key={`${url}#${nonce}`}
            src={url}
            title="Preview"
            className="min-h-0 flex-1 border-0 bg-white"
          />
        )}

        {logOpen && (
          <div
            className={`min-h-0 overflow-y-auto bg-neutral-950 px-2 py-1 font-mono text-[11px] leading-relaxed text-neutral-400 ${
              url ? "h-32 border-t border-neutral-800" : "flex-1"
            }`}
          >
            {log.length === 0 && (
              <p className="p-2 text-neutral-600">
                {running ? "Waiting for output…" : "Run installs dependencies if needed, then starts the dev server."}
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
                  <div key={i} className="whitespace-pre-wrap break-all text-amber-400">
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
