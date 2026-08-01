// Where a conversation lives once it stops living in localStorage, kept
// import-free (like edit.ts, runlog.ts and session.ts) so `npm test` can
// exercise it on plain node.
//
// One JSON object per line, appended. The append is the point: the old store
// re-serialised every project's whole transcript on every entry, which is why
// it had to be trimmed to a 200k-char budget — a quota number that was silently
// also a history limit. A line at a time has no such ceiling, and a transcript
// nobody trims is one that can still be read next month.

/** In the project, beside the checkpoint repo. `.hearth` is already skipped by
 *  the file tree, the search and the checkpoint repo's exclude list. */
export const TRANSCRIPT_REL = ".hearth/chat.jsonl";

/** The model-facing half — history and any interrupted turn. Overwritten rather
 *  than appended: it's a snapshot of what the next turn starts from, already
 *  bounded by the context budget, and an append-only copy of it would just be a
 *  log of previous guesses. */
export const SESSION_REL = ".hearth/chat-session.json";

/** How many entries are read back into the panel. The file keeps everything;
 *  this bounds what a project switch has to parse and React has to render.
 *  Nothing is lost — unlike the budget this replaces, which deleted. */
export const LOAD_LIMIT = 1000;

export function encodeEntry(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

/**
 * Parse a transcript file, newest `limit` entries only.
 *
 * A line that won't parse is skipped rather than thrown on. The case that
 * makes this necessary is ordinary: killing the app mid-append leaves a
 * half-written last line, and one truncated line must not cost the user every
 * conversation they've had in that project.
 */
export function decodeEntries<T>(blob: string, limit = LOAD_LIMIT): { entries: T[]; omitted: number } {
  const lines = blob.split("\n").filter((line) => line.trim() !== "");
  const start = Math.max(0, lines.length - limit);
  const entries: T[] = [];
  for (const line of lines.slice(start)) {
    try {
      entries.push(JSON.parse(line) as T);
    } catch {
      // Skipped, not counted as omitted: `omitted` is what the user could
      // scroll to if the panel loaded more, and a corrupt line isn't that.
    }
  }
  return { entries, omitted: start };
}
