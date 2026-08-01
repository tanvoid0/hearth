// The conversation store's schema and statements, kept import-free (like
// edit.ts, runlog.ts and transcript.ts) so `npm test` can run every one of them
// against a real SQLite through node:sqlite.
//
// The SQL lives here rather than in a Rust migration list for exactly that
// reason: a migration the tests can't reach is a schema nobody checks until the
// app won't start.
//
// ponytail: `IF NOT EXISTS` is the whole upgrade story. Fine for one version;
// the day a column changes, this needs the plugin's versioned migrations or a
// hand-written ALTER, and pretending otherwise would corrupt somebody's history.

/**
 * One row per transcript entry, one per project's model-facing snapshot.
 *
 * `text` is the searchable part lifted out of the entry — searching the JSON
 * itself would match key names, escapes and a checkpoint's file list, and a
 * search that hits `"kind":"user"` on every row is worse than no search.
 *
 * Deliberately not FTS5: that's a virtual table plus triggers to keep it in
 * step, for a LIKE over a few thousand rows that is instant. Reach for it when
 * a search is slow, not before.
 */
// A list rather than one string with semicolons in it: the plugin's `execute`
// prepares and binds a single statement, so a multi-statement schema would
// create the first table and silently skip the index and the second one.
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS entries (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     root TEXT NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL DEFAULT '',
     json TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS entries_by_root ON entries(root, id)",
  `CREATE TABLE IF NOT EXISTS sessions (
     root TEXT PRIMARY KEY,
     json TEXT NOT NULL
   )`,
];

export const INSERT_ENTRY = "INSERT INTO entries (root, kind, text, json) VALUES (?, ?, ?, ?)";

/** Newest first, so the limit takes the newest — the caller reverses. Ordering
 *  by id rather than by an inserted-at column: rowid is the insertion order,
 *  and two entries in the same millisecond are routine in one turn. */
export const SELECT_ENTRIES = "SELECT json FROM entries WHERE root = ? ORDER BY id DESC LIMIT ?";

export const DELETE_ENTRIES = "DELETE FROM entries WHERE root = ?";

export const SELECT_SESSION = "SELECT json FROM sessions WHERE root = ?";

export const UPSERT_SESSION =
  "INSERT INTO sessions (root, json) VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET json = excluded.json";

/** Across every project — the one thing a database buys over a file per
 *  project, and the reason this isn't still JSONL. `root` comes back so a hit
 *  in another project can say which, and be opened. */
export const SEARCH_ENTRIES =
  "SELECT root, kind, text FROM entries WHERE text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?";

export const SEARCH_ENTRIES_IN_PROJECT =
  "SELECT root, kind, text FROM entries WHERE root = ? AND text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?";

/**
 * A user's query as a LIKE pattern.
 *
 * `%` and `_` are wildcards, and a search for "100%" that silently matches
 * everything is the kind of wrong that looks like it worked. The backslash is
 * escaped first, or escaping the others would re-escape it.
 */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * What of an entry is worth matching on.
 *
 * A tool row's label and detail are the useful part ("$ npm test", and what it
 * printed); a checkpoint is a sha and a file list, which nobody searches for in
 * prose. Anything unrecognised contributes nothing rather than its JSON.
 */
export function searchText(entry: Record<string, unknown>): string {
  if (typeof entry.text === "string") return entry.text;
  if (entry.kind === "tool") return [entry.label, entry.detail].filter((v) => typeof v === "string").join("\n");
  return "";
}
