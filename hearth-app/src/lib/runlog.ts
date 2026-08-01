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

/**
 * Build plan §3's run states. The distinction that earns the machine is
 * `installing` vs `starting`: a cold `npm install` runs for minutes with no
 * output a user can read as progress, and "starting…" over the top of it is
 * what makes a working app look hung.
 */
export type RunStatus = "stopped" | "installing" | "starting" | "ready" | "crashed" | "port-conflict";

/** Vite's own words when `--strictPort` finds the port taken, and node's when
 *  anything else does. Worth its own state rather than a generic crash: it's
 *  the one failure that pressing Run again actually fixes, since the port is
 *  allocated fresh each time. */
const PORT_TAKEN = /port \d+ is already in use|EADDRINUSE/i;

/** Rust's control lines for the phases it knows about — it's the only side that
 *  can tell an install apart from the script that follows it. */
const PHASES: Record<string, RunStatus> = {
  "phase:installing": "installing",
  "phase:starting": "starting",
};

/** True for lines that drive the machine but say nothing a user wants to read. */
export function isPhaseLine(line: string): boolean {
  const mark = exitReason(line);
  return mark !== null && mark in PHASES;
}

/**
 * Advance the run state on one line of output. `port` is 0 for a script that
 * isn't a server, which is what stops a `build` script sitting at "starting"
 * waiting for a URL that will never be printed.
 */
export function reduceStatus(status: RunStatus, line: string, port: number): RunStatus {
  const mark = exitReason(line);
  if (mark !== null) {
    // Everything on the control channel that isn't a phase is the end of the
    // run. A port conflict has already said the useful thing by then — the exit
    // it causes shouldn't overwrite it with a bare "crashed".
    return PHASES[mark] ?? (status === "port-conflict" ? status : "crashed");
  }
  if (PORT_TAKEN.test(line)) return "port-conflict";
  if (port > 0 && readyUrl(line, port)) return "ready";
  return status;
}

/** Whether the run is still live. `crashed` and `port-conflict` are over. */
export function isRunning(status: RunStatus): boolean {
  return status === "installing" || status === "starting" || status === "ready";
}

/** What the pane says when there's no URL to show instead. */
export const STATUS_TEXT: Record<RunStatus, string> = {
  stopped: "Not running",
  installing: "Installing dependencies… (first run takes a few minutes)",
  starting: "Starting…",
  ready: "Ready",
  crashed: "Exited",
  "port-conflict": "Port already in use — press Run to try another",
};

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
 * Runtime errors logged since the agent's last write — the console half of
 * "is this actually done?".
 *
 * Distinct messages, not repeats: one error in a render loop arrives thousands
 * of times and is still one thing to fix. Warnings don't count — React logs
 * them for things that work — so this is deliberately narrower than what
 * `consoleTail` shows the model.
 */
export function countErrorsSince(entries: ConsoleEntry[], mark = 0): number {
  return entries.slice(mark).filter((e) => e.text.startsWith("error:")).length;
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

/** How each run state reads to the model. `crashed` and `port-conflict` used to
 *  both arrive as "not running", which reads as "nobody pressed Run" — so a
 *  server that died on the agent's own edit looked like one that was never
 *  started. */
const DEV_STATUS: Record<RunStatus, string> = {
  stopped: "dev server not running — ask the user to press Run if you need to see build output",
  installing: "dev server starting (installing dependencies)",
  starting: "dev server starting (booting)",
  ready: "dev server running",
  crashed: "dev server exited — the tail below says why",
  "port-conflict": "dev server could not start: the port was already in use (not a problem with the code)",
};

/**
 * What the agent sees of the dev server: status line plus the tail of its
 * output. Deliberately no error classifier — vite prints transform errors
 * straight to stdout, and a regex deciding what counts as an error is one more
 * thing to keep in step with vite's formatting.
 */
export function devLogTail(state: RunStatus, url: string | null, log: string[], n = TAIL_LINES): string {
  const status = state === "ready" && url ? `dev server running at ${url}` : DEV_STATUS[state];
  if (log.length === 0) return `${status}; no output yet`;
  const tail = log.slice(-n);
  const omitted = log.length - tail.length;
  return [status, omitted > 0 ? `… (${omitted} earlier lines omitted)` : "", ...tail].filter(Boolean).join("\n");
}
