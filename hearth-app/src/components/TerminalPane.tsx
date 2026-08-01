import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { ptyClose, ptyOpen, ptyResize, ptyWrite } from "../lib/terminal";

export function TerminalPane({ id, root, visible }: { id: string; root: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const seq = useRef(0);
  const sessionRef = useRef("");
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // The prop id names the tab, which outlives any one mount of it. The PTY is
    // keyed per mount instead: two mounts sharing a key means the first one's
    // close — deferred, so it lands late — kills the shell the second just
    // opened, which is exactly what StrictMode's double mount produces.
    const session = `${id}#${seq.current++}`;
    sessionRef.current = session;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: { background: "#0a0a0a", foreground: "#d4d4d4", cursor: "#d4d4d4" },
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(host);
    fit.fit();
    fitRef.current = fit;
    searchRef.current = search;
    termRef.current = term;

    // xterm would otherwise send Ctrl+F to the shell as a control character.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        setFinding(true);
        return false;
      }
      return true;
    });

    // The open and the close still have to be sequenced, not just fired: a
    // close that overtakes its own open finds nothing to close, and the shell
    // that lands afterwards is left running with no pane attached to it.
    let nothingToClose = false;
    const booted = ptyOpen(session, root, term.cols, term.rows, (chunk) => term.write(chunk)).catch((err: unknown) => {
      term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
      nothingToClose = true;
    });

    const typing = term.onData((data) => void ptyWrite(session, data));

    // Both directions matter: xterm reflows its own buffer on its own, but a
    // shell that hasn't been told the new width keeps wrapping at the old one.
    const observer = new ResizeObserver(() => {
      if (!host.clientWidth) return; // hidden — measuring now would give nonsense
      fit.fit();
      void ptyResize(session, term.cols, term.rows);
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      typing.dispose();
      void booted.then(() => {
        if (!nothingToClose) void ptyClose(session);
        term.dispose();
      });
    };
  }, [id, root]);

  // A pane fitted while hidden measures zero, so it has to re-fit on the way
  // back into view — the observer won't fire for a display change alone.
  useEffect(() => {
    if (!visible || !fitRef.current) return;
    fitRef.current.fit();
    const { cols, rows } = fitRef.current.proposeDimensions() ?? {};
    if (cols && rows) void ptyResize(sessionRef.current, cols, rows);
  }, [visible, id]);

  function closeSearch() {
    setFinding(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  }

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full overflow-hidden bg-neutral-950 px-1" />
      {finding && (
        <div className="absolute right-2 top-1 flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 shadow">
          <input
            value={query}
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              searchRef.current?.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") return closeSearch();
              if (e.key !== "Enter") return;
              // Shift+Enter walks backwards, the convention every editor uses.
              if (e.shiftKey) searchRef.current?.findPrevious(query);
              else searchRef.current?.findNext(query);
            }}
            placeholder="find in scrollback"
            className="w-44 bg-transparent text-[11px] text-neutral-100 outline-none placeholder:text-neutral-600"
          />
          <button onClick={closeSearch} className="text-[11px] text-neutral-500 hover:text-neutral-300">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
