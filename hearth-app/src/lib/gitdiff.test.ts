import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNameStatus } from "./gitdiff.ts";

test("parses the statuses git show emits", () => {
  const changes = parseNameStatus("M\tsrc/App.jsx\nA\tsrc/Todo.jsx\nD\tsrc/old.js\n");
  assert.deepEqual(changes, [
    { status: "M", path: "src/App.jsx" },
    { status: "A", path: "src/Todo.jsx" },
    { status: "D", path: "src/old.js" },
  ]);
});

test("a rename resolves to the new path, not the old one", () => {
  // The whole reason the last field is taken rather than the second: `old.js`
  // doesn't exist at this commit, so a diff keyed on it would read as empty.
  const changes = parseNameStatus("R100\tsrc/old.js\tsrc/new.js\n");
  assert.deepEqual(changes, [{ status: "R", path: "src/new.js" }]);
});

test("ignores blank lines and CRLF, and the format= header line", () => {
  assert.deepEqual(parseNameStatus("\r\n\nM\tsrc/a.ts\r\n\n"), [{ status: "M", path: "src/a.ts" }]);
});

test("a commit that changed nothing parses to nothing", () => {
  assert.deepEqual(parseNameStatus(""), []);
});
