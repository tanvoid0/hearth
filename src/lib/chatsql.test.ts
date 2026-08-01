import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  DELETE_ENTRIES,
  INSERT_ENTRY,
  SCHEMA,
  SEARCH_ENTRIES,
  SEARCH_ENTRIES_IN_PROJECT,
  SELECT_ENTRIES,
  SELECT_SESSION,
  UPSERT_SESSION,
  likePattern,
  searchText,
} from "./chatsql.ts";

// Against a real SQLite, not a mock: these strings are executed verbatim by the
// app, and the failure they'd otherwise hide — a statement that doesn't parse,
// or an upsert that inserts a duplicate instead — only shows up when SQLite
// itself is the thing running them.
function db() {
  const conn = new DatabaseSync(":memory:");
  for (const statement of SCHEMA) conn.exec(statement);
  return conn;
}

const add = (conn: DatabaseSync, root: string, entry: Record<string, unknown>) =>
  conn.prepare(INSERT_ENTRY).run(root, String(entry.kind), searchText(entry), JSON.stringify(entry));

test("the schema applies twice, because it is run on every open", () => {
  const conn = db();
  for (const statement of SCHEMA) conn.exec(statement);
  add(conn, "C:/a", { kind: "user", text: "hello" });
  assert.equal(conn.prepare(SELECT_ENTRIES).all("C:/a", 10).length, 1);
});

test("entries come back newest-first, capped, and scoped to their project", () => {
  const conn = db();
  for (let i = 0; i < 5; i++) add(conn, "C:/a", { kind: "user", text: `a${i}` });
  add(conn, "C:/b", { kind: "user", text: "other project" });

  const rows = conn.prepare(SELECT_ENTRIES).all("C:/a", 3) as Array<{ json: string }>;
  assert.deepEqual(
    rows.map((r) => JSON.parse(r.json).text),
    ["a4", "a3", "a2"],
    "the limit has to take the newest, which is why the order is DESC",
  );
});

test("clearing one project leaves the others alone", () => {
  const conn = db();
  add(conn, "C:/a", { kind: "user", text: "mine" });
  add(conn, "C:/b", { kind: "user", text: "theirs" });
  conn.prepare(DELETE_ENTRIES).run("C:/a");
  assert.equal(conn.prepare(SELECT_ENTRIES).all("C:/a", 10).length, 0);
  assert.equal(conn.prepare(SELECT_ENTRIES).all("C:/b", 10).length, 1);
});

test("a session snapshot is replaced, not duplicated", () => {
  const conn = db();
  conn.prepare(UPSERT_SESSION).run("C:/a", JSON.stringify({ history: [1] }));
  conn.prepare(UPSERT_SESSION).run("C:/a", JSON.stringify({ history: [1, 2] }));
  const rows = conn.prepare(SELECT_SESSION).all("C:/a") as Array<{ json: string }>;
  assert.equal(rows.length, 1, "without ON CONFLICT this is a primary-key error or a second row");
  assert.deepEqual(JSON.parse(rows[0].json).history, [1, 2]);
});

test("search reaches across projects, and can be held to one", () => {
  const conn = db();
  add(conn, "C:/a", { kind: "user", text: "how do I debounce the resize handler" });
  add(conn, "C:/b", { kind: "assistant", text: "use a resize observer instead" });

  const all = conn.prepare(SEARCH_ENTRIES).all(likePattern("resize"), 10) as Array<{ root: string }>;
  assert.deepEqual(all.map((r) => r.root).sort(), ["C:/a", "C:/b"], "the point of a database over a file per project");

  const one = conn.prepare(SEARCH_ENTRIES_IN_PROJECT).all("C:/a", likePattern("resize"), 10);
  assert.equal(one.length, 1);
});

test("a query full of wildcards searches for itself", () => {
  const conn = db();
  add(conn, "C:/a", { kind: "user", text: "the build is 100% broken" });
  add(conn, "C:/a", { kind: "user", text: "unrelated" });
  // Unescaped, `100%` matches every row beginning "100" — and a bare `%`
  // matches every row there is, which reads exactly like a search that worked.
  assert.equal(conn.prepare(SEARCH_ENTRIES).all(likePattern("100%"), 10).length, 1);
  // Escaped, a lone `%` finds the one message that actually contains one.
  assert.equal(conn.prepare(SEARCH_ENTRIES).all(likePattern("%"), 10).length, 1);
  assert.equal(conn.prepare(SEARCH_ENTRIES).all(likePattern("_nrelated"), 10).length, 0, "`_` is a wildcard too");
});

test("searchText lifts the part worth matching out of each kind of entry", () => {
  assert.equal(searchText({ kind: "user", text: "hello" }), "hello");
  assert.equal(searchText({ kind: "tool", label: "$ npm test", detail: "3 failing" }), "$ npm test\n3 failing");
  // A checkpoint is a sha and a file list. Indexing its JSON would put
  // `"kind":"checkpoint"` in the way of every prose search.
  assert.equal(searchText({ kind: "checkpoint", sha: "abc123", files: [] }), "");
});
