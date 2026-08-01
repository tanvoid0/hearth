import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allProblems,
  applyDiagEvent,
  forgetFile,
  fullReplaceRange,
  problemTail,
  problemsIn,
  type Diags,
} from "./problems.ts";

const FILE = "d:/proj/src/App.jsx";

function diag(text: string, line = 1, category = "error", code = 2304) {
  return { start: { line, offset: 5 }, end: { line, offset: 9 }, text, code, category };
}

test("a semantic pass does not wipe the syntax errors that arrived first", () => {
  // One `geterr` emits syntaxDiag then semanticDiag, each complete for its own
  // kind. Keyed by file alone, the second would clobber the first and a file
  // with a stray brace would read as clean.
  let diags: Diags = {};
  diags = applyDiagEvent(diags, "syntaxDiag", { file: FILE, diagnostics: [diag("'}' expected.", 3)] });
  diags = applyDiagEvent(diags, "semanticDiag", { file: FILE, diagnostics: [diag("Cannot find name 'x'.", 7)] });

  const problems = problemsIn(diags, FILE);
  assert.equal(problems.length, 2);
  assert.deepEqual(
    problems.map((p) => p.line),
    [3, 7],
  );
});

test("an empty re-check clears that kind and returns the same object when nothing changed", () => {
  let diags: Diags = {};
  const empty = applyDiagEvent(diags, "semanticDiag", { file: FILE, diagnostics: [] });
  assert.equal(empty, diags, "no problems before or after should not produce a new object");

  diags = applyDiagEvent(diags, "semanticDiag", { file: FILE, diagnostics: [diag("Cannot find name 'x'.")] });
  assert.equal(problemsIn(diags, FILE).length, 1);
  diags = applyDiagEvent(diags, "semanticDiag", { file: FILE, diagnostics: [] });
  assert.equal(problemsIn(diags, FILE).length, 0, "a fixed file has to clear, not linger");
});

test("suggestions are dropped, warnings are kept, and errors sort first", () => {
  let diags: Diags = {};
  diags = applyDiagEvent(diags, "semanticDiag", {
    file: FILE,
    diagnostics: [diag("advice", 2, "suggestion"), diag("a warning", 9, "warning"), diag("an error", 40)],
  });
  // suggestionDiag is not a kept event at all, and a suggestion smuggled into a
  // semantic batch is dropped too.
  diags = applyDiagEvent(diags, "suggestionDiag", { file: FILE, diagnostics: [diag("more advice", 1, "suggestion")] });

  const problems = allProblems(diags);
  assert.deepEqual(
    problems.map((p) => p.text),
    ["an error", "a warning"],
  );
});

test("forgetFile drops every kind for that file and nothing else", () => {
  let diags: Diags = {};
  diags = applyDiagEvent(diags, "syntaxDiag", { file: FILE, diagnostics: [diag("a")] });
  diags = applyDiagEvent(diags, "semanticDiag", { file: FILE, diagnostics: [diag("b")] });
  diags = applyDiagEvent(diags, "semanticDiag", { file: "d:/proj/src/Other.jsx", diagnostics: [diag("c")] });

  const left = allProblems(forgetFile(diags, FILE));
  assert.deepEqual(
    left.map((p) => p.text),
    ["c"],
  );
});

test("the agent can tell 'not checked' from 'no errors'", () => {
  // Both would otherwise be silence, and a model that can't tell them apart
  // calls an unchecked project a clean one.
  assert.match(problemTail("ok", [], "d:/proj"), /none/);
  assert.match(problemTail("unavailable", [], "d:/proj"), /unavailable/);
  assert.match(problemTail("unconfigured", [], "d:/proj"), /not configured/);
  assert.notEqual(problemTail("ok", [], "d:/proj"), problemTail("unconfigured", [], "d:/proj"));
});

test("the agent's list is project-relative, counted, and capped", () => {
  let diags: Diags = {};
  diags = applyDiagEvent(diags, "semanticDiag", {
    file: FILE,
    diagnostics: Array.from({ length: 5 }, (_, i) => diag(`error ${i}`, i + 1)),
  });
  const out = problemTail("ok", allProblems(diags), "d:/proj", 2);
  assert.match(out, /type errors: 5/);
  assert.match(out, /src\/App\.jsx:1:5 error TS2304: error 0/);
  assert.match(out, /\(3 more\)/);
  assert.doesNotMatch(out, /d:\/proj\/src/, "paths inside the project should be relative");
});

test("a full-document replace range covers the last character of the last line", () => {
  // Off by one here and tsserver's buffer desynchronises permanently: every
  // later diagnostic, hover and go-to-definition lands on the wrong token.
  assert.deepEqual(fullReplaceRange("abc"), { line: 1, offset: 1, endLine: 1, endOffset: 4 });
  assert.deepEqual(fullReplaceRange("ab\ncdef"), { line: 1, offset: 1, endLine: 2, endOffset: 5 });
  // A trailing newline makes a real, empty final line — the common case, since
  // every file in the scaffold ends with one.
  assert.deepEqual(fullReplaceRange("ab\n"), { line: 1, offset: 1, endLine: 2, endOffset: 1 });
  assert.deepEqual(fullReplaceRange(""), { line: 1, offset: 1, endLine: 1, endOffset: 1 });
});
