// Parsing rules for the dev server's output stream, kept import-free (like
// edit.ts and session.ts) so `npm test` can exercise them on plain node.

/** Rust prefixes its own control lines with this; everything else on the
 *  channel is raw npm/vite output. */
export const MARK = "[hearth]";

/** Log lines kept in memory. `npm install` alone is thousands of lines and
 *  only the tail ever gets read. */
export const LOG_CAP = 300;

export function capLog(log: string[], line: string): string[] {
  const next = [...log, line];
  return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
}

/**
 * Vite announces itself with a `Local: http://localhost:PORT/` line, which is
 * the only signal that the server is actually serving — the process being
 * alive isn't enough, since it spends the first seconds optimising deps.
 *
 * Matching on the URL rather than the bare port matters: a `--strictPort`
 * collision prints the same number in prose ("Port 5173 is already in use").
 */
export function readyUrl(line: string, port: number): string | null {
  return new RegExp(String.raw`https?://[^\s/]+:${port}\b`).test(line) ? `http://localhost:${port}/` : null;
}

/** The terminal event for a run: install failed, or the server exited. */
export function exitReason(line: string): string | null {
  return line.startsWith(MARK) ? line.slice(MARK.length).trim() : null;
}

/** Lines of dev-server output handed to the agent by `get_errors`. */
export const TAIL_LINES = 40;

/**
 * One console message from the preview, with a repeat count. A render loop
 * emits the same error thousands of times; without collapsing, those would be
 * the only 40 lines the agent ever sees.
 */
export interface ConsoleEntry {
  text: string;
  count: number;
}

/** Longest console message kept. The injected snippet already truncates, but
 *  the message arrives over `postMessage` from a page we don't control. */
export const MAX_CONSOLE_CHARS = 2000;

export function pushEntry(entries: ConsoleEntry[], text: string, cap = LOG_CAP): ConsoleEntry[] {
  const clipped = text.slice(0, MAX_CONSOLE_CHARS);
  const last = entries[entries.length - 1];
  if (last?.text === clipped) return [...entries.slice(0, -1), { text: clipped, count: last.count + 1 }];
  const next = [...entries, { text: clipped, count: 1 }];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function formatEntry(e: ConsoleEntry): string {
  return e.count > 1 ? `${e.text}  (×${e.count})` : e.text;
}

/**
 * The browser half of `get_errors`. Same honesty rule as `devLogTail`: a
 * disconnected bridge and a clean console both have nothing to report, and a
 * model that can't tell them apart calls a white screen fixed.
 *
 * `mark` is how many entries existed when the agent last wrote a file, which
 * is what turns a buffer into a verdict — everything above it predates the fix
 * being checked. Marking rather than clearing on purpose: Fast Refresh applies
 * an edit a beat after the tool call returns, so an emptied buffer read
 * immediately after a write reports "clean" for a page that is still broken.
 */
export function consoleTail(attached: boolean, entries: ConsoleEntry[], mark = 0, n = TAIL_LINES): string {
  if (!attached) {
    return "browser console not connected — ask the user to open Preview and press Run (a project created outside Hearth has no console bridge in its index.html)";
  }
  if (entries.length === 0) return "browser console: no errors or warnings";

  // mark 0 means the agent hasn't written anything this turn, so there's no
  // line to draw — every message is equally old.
  const divider = mark > 0 ? mark : -1;
  const start = Math.max(0, entries.length - n);
  const lines = entries
    .slice(start)
    .map((e, i) => (start + i === divider ? `── since your last edit ──\n${formatEntry(e)}` : formatEntry(e)));

  return [
    "browser console:",
    start > 0 ? `… (${start} earlier messages omitted)` : "",
    ...lines,
    mark > 0 && mark >= entries.length ? "── nothing new since your last edit ──" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * What the agent sees of the dev server: status line plus the tail of its
 * output. Deliberately no error classifier — vite prints transform errors
 * straight to stdout, and a regex deciding what counts as an error is one more
 * thing to keep in step with vite's formatting.
 */
export function devLogTail(running: boolean, url: string | null, log: string[], n = TAIL_LINES): string {
  const status = url
    ? `dev server running at ${url}`
    : running
      ? "dev server starting (installing or booting)"
      : "dev server not running — ask the user to press Run if you need to see build output";
  if (log.length === 0) return `${status}; no output yet`;
  const tail = log.slice(-n);
  const omitted = log.length - tail.length;
  return [status, omitted > 0 ? `… (${omitted} earlier lines omitted)` : "", ...tail].filter(Boolean).join("\n");
}
