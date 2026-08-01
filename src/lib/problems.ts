// The tsserver protocol's diagnostic shapes, and what the editor, the Problems
// panel and the agent each see of them. Kept import-free (like runlog.ts and
// session.ts) so `npm test` can exercise it on plain node.

export type Severity = "error" | "warning";

export interface Problem {
  /** Absolute path, in tsserver's forward-slash form. */
  file: string;
  /** 1-based, and so is Monaco's — no conversion, unlike LSP's 0-based lines. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  code: number;
  severity: Severity;
  text: string;
}

/**
 * Diagnostics keyed by file *and* kind.
 *
 * The kind is load-bearing, not decoration: one `geterr` produces a separate
 * event per kind, and each is the complete set for that kind. Keyed by file
 * alone, the semantic pass arriving second would wipe the syntax errors that
 * arrived first — leaving a file with a stray brace looking clean.
 */
export type Diags = Record<string, Problem[]>;

/** Which `*Diag` events are worth keeping. `suggestionDiag` is deliberately
 *  absent: it carries things like "this may be converted to an async function",
 *  which is advice, not a problem, and would bury the two kinds that are. */
const KEPT_EVENTS = new Set(["syntaxDiag", "semanticDiag"]);

/** Separates the file from the kind in a key. A NUL rather than a space or a
 *  colon because those occur in real Windows paths, and `forgetFile` matches on
 *  the prefix — with a space, forgetting `a.js` would also forget
 *  `a.js backup.js`. Written as an escape: a literal control character in the
 *  source is invisible in an editor and makes git treat the file as binary. */
const SEP = "\u0000";

export function diagKey(file: string, event: string): string {
  return `${file}${SEP}${event}`;
}

/** Normalise a path for comparison. tsserver answers in forward slashes and
 *  sometimes a different drive-letter case than the picker hands us. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Fold one `syntaxDiag`/`semanticDiag` event into the map. Returns the same
 * object when there's nothing to change, so React state doesn't churn on the
 * empty events that follow every clean re-check.
 */
export function applyDiagEvent(diags: Diags, event: string, body: any): Diags {
  if (!KEPT_EVENTS.has(event) || !body?.file) return diags;
  const key = diagKey(body.file, event);
  const next: Problem[] = (body.diagnostics ?? [])
    .filter((d: any) => d?.start && d?.end && d.category !== "suggestion")
    .map((d: any) => ({
      file: body.file,
      line: d.start.line,
      column: d.start.offset,
      endLine: d.end.line,
      endColumn: d.end.offset,
      code: d.code ?? 0,
      severity: d.category === "warning" ? ("warning" as const) : ("error" as const),
      // Multi-line messages (a mismatched-type explanation is several lines)
      // arrive with newlines already in them.
      text: String(d.text ?? "").trim(),
    }));

  const before = diags[key] ?? [];
  if (before.length === 0 && next.length === 0) return diags;
  if (next.length === 0) {
    const { [key]: _gone, ...rest } = diags;
    return rest;
  }
  return { ...diags, [key]: next };
}

/** Drop everything known about one file — it was deleted, or closed and is no
 *  longer being re-checked. */
export function forgetFile(diags: Diags, file: string): Diags {
  const prefix = normalizePath(file) + SEP;
  const out: Diags = {};
  for (const [key, problems] of Object.entries(diags)) {
    if (!normalizePath(key).startsWith(prefix)) out[key] = problems;
  }
  return out;
}

/** Everything, in the order a Problems panel should list it: errors first,
 *  then by file and position. */
export function allProblems(diags: Diags): Problem[] {
  return Object.values(diags)
    .flat()
    .sort(
      (a, b) =>
        Number(b.severity === "error") - Number(a.severity === "error") ||
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.column - b.column,
    );
}

export function problemsIn(diags: Diags, file: string): Problem[] {
  const want = normalizePath(file);
  return allProblems(diags).filter((p) => normalizePath(p.file) === want);
}

/** Whether type checking is actually happening, which is not the same question
 *  as whether there are errors. */
export type CheckStatus =
  /** tsserver isn't running: no node, no bundled TypeScript, or it crashed. */
  | "unavailable"
  /** Running, but the project has no tsconfig/jsconfig, so tsserver puts files
   *  in an inferred project and reports nothing at all for plain JS. */
  | "unconfigured"
  /** Running and configured, but no file has been opened or edited yet, so
   *  nothing has been checked. Empty for a different reason than clean. */
  | "idle"
  | "ok";

/** Files listed in the agent's view before it's cut short. */
export const TAIL_PROBLEMS = 30;

function shortPath(file: string, root: string): string {
  const rel = normalizePath(file).startsWith(normalizePath(root) + "/") ? file.slice(root.length + 1) : file;
  return rel.replace(/\\/g, "/");
}

/**
 * The type-checking third of `get_errors`.
 *
 * Same honesty rule as `devLogTail` and `consoleTail`: "not checked" and "no
 * errors" are different answers that would otherwise both render as silence,
 * and a model that can't tell them apart reports a broken file as fixed. The
 * `unconfigured` case is the one that actually bites — a JS project without a
 * jsconfig type-checks nothing, and looks identical to a clean one.
 */
export function problemTail(status: CheckStatus, problems: Problem[], root: string, n = TAIL_PROBLEMS): string {
  if (status === "unavailable") {
    return "type checking unavailable — the TypeScript language server isn't running, so this reports nothing about type errors either way";
  }
  if (status === "unconfigured") {
    return "type checking not configured — this project has no tsconfig.json or jsconfig.json, so nothing is type-checked. Add one with \"checkJs\": true to catch undefined names and bad props before the app runs";
  }
  if (status === "idle") {
    return "type checking hasn't run — no file has been opened or edited yet, so this reports nothing about type errors either way";
  }
  if (problems.length === 0) return "type errors: none";

  const shown = problems.slice(0, n);
  const omitted = problems.length - shown.length;
  return [
    `type errors: ${problems.length}`,
    ...shown.map((p) => `${shortPath(p.file, root)}:${p.line}:${p.column} ${p.severity} TS${p.code}: ${p.text}`),
    omitted > 0 ? `… (${omitted} more)` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The span covering an entire document, derived from the content last sent.
 *
 * tsserver tracks an open file as a buffer we mutate, so every edit has to
 * arrive as a range — and the range has to describe what tsserver currently
 * believes, not what the editor now shows. Replacing the whole document each
 * time keeps the two in step without diffing; getting this off by a line
 * desynchronises the buffer permanently, and every position after it —
 * diagnostics, hover, go-to-definition — lands on the wrong token.
 */
export function fullReplaceRange(previous: string): {
  line: number;
  offset: number;
  endLine: number;
  endOffset: number;
} {
  const lines = previous.split("\n");
  return { line: 1, offset: 1, endLine: lines.length, endOffset: lines[lines.length - 1].length + 1 };
}
