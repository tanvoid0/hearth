import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHunks, parseNameStatus } from "./gitdiff.ts";

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

test("parseHunks reassembles both sides so a revert can search for one", () => {
  // Real `git show` output, preamble and all — the parser has to skip past it
  // rather than treat `---`/`+++` as removed and added lines.
  const unified = `diff --git a/src/App.jsx b/src/App.jsx
index 1a2b3c4..5d6e7f8 100644
--- a/src/App.jsx
+++ b/src/App.jsx
@@ -1,5 +1,6 @@
 export default function App() {
   return (
-    <h1>Hello</h1>
+    <h1>Hearth</h1>
+    <p>new</p>
   );
 }
@@ -20,3 +21,3 @@ function other() {
-  return 1;
+  return 2;
 }
`;
  const hunks = parseHunks(unified);
  assert.equal(hunks.length, 2);

  // Context is in both sides: it's what gives the revert an anchor to match,
  // and without it a one-line hunk would match anywhere in the file.
  assert.equal(
    hunks[0].before,
    "export default function App() {\n  return (\n    <h1>Hello</h1>\n  );\n}",
  );
  assert.equal(
    hunks[0].after,
    "export default function App() {\n  return (\n    <h1>Hearth</h1>\n    <p>new</p>\n  );\n}",
  );
  assert.equal(hunks[0].line, 1);
  assert.equal(hunks[1].line, 21, "the jump target is the new file's line, not the old one's");
});

test("parseHunks ignores the no-newline marker", () => {
  // `\ No newline at end of file` starts with a backslash and belongs to
  // neither side; counting it as context would put it in the file.
  const hunks = parseHunks("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n");
  assert.equal(hunks[0].before, "a");
  assert.equal(hunks[0].after, "b");
});

test("parseHunks returns nothing for a diff with no hunks", () => {
  assert.deepEqual(parseHunks("diff --git a/x b/x\nsimilarity index 100%\n"), []);
});
