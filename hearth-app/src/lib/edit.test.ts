// Run with: npm test   (node's built-in runner + TS type stripping, no deps)
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, changedLines, resolveInProject, samePath } from "./edit.ts";

test("resolveInProject keeps paths inside the root", () => {
  assert.equal(resolveInProject("D:\\proj", "src/a.ts"), "D:\\proj\\src\\a.ts");
  assert.equal(resolveInProject("/home/p", "./src/a.ts"), "/home/p/src/a.ts");
  assert.equal(resolveInProject("D:\\proj", "D:\\proj\\src\\a.ts"), "D:\\proj\\src\\a.ts");
  assert.equal(resolveInProject("D:\\proj", "src/sub/../a.ts"), "D:\\proj\\src\\a.ts");
});

test("resolveInProject refuses escapes", () => {
  assert.throws(() => resolveInProject("D:\\proj", "../secrets.txt"), /escapes project root/);
  assert.throws(() => resolveInProject("D:\\proj", "C:\\Windows\\system32"), /escapes project root/);
  assert.throws(() => resolveInProject("/home/p", "/etc/passwd"), /escapes project root/);
});

test("samePath ignores separator and case", () => {
  assert.ok(samePath("D:\\proj\\a.ts", "d:/proj/A.ts"));
  assert.ok(!samePath("D:\\proj\\a.ts", "D:\\proj\\b.ts"));
});

test("applyEdits takes a bare edit object, not just a list of them", () => {
  // llama3.1:8b sends this shape unprompted. It used to throw out of
  // `.entries()`, and the model saw "edits.entries is not a function".
  assert.equal(applyEdits("const a = 1;\n", { search: "a = 1", replace: "a = 2" }).content, "const a = 2;\n");
  assert.deepEqual(applyEdits("x\n", undefined as any).content, "x\n");
});

test("applyEdits matches exactly, then on normalised whitespace", () => {
  assert.equal(applyEdits("const a = 1;\n", [{ search: "a = 1", replace: "a = 2" }]).content, "const a = 2;\n");

  const indented = applyEdits("function f() {\n    return 1;\n}\n", [
    { search: "  return 1;", replace: "  return 2;" },
  ]);
  assert.deepEqual(indented.failures, []);
  assert.match(indented.content, /return 2;/);
});

test("applyEdits is all-or-nothing on a miss", () => {
  const before = "const a = 1;\n";
  const result = applyEdits(before, [
    { search: "a = 1", replace: "a = 2" },
    { search: "nope", replace: "x" },
  ]);
  assert.equal(result.content, before, "a failed edit must not leave a half-applied file");
  assert.equal(result.failures.length, 1);
});

test("changedLines marks the span the agent rewrote, not the whole file", () => {
  const before = "one\ntwo\nthree\nfour\n";
  const after = "one\nTWO\nthree\nfour\n";
  assert.deepEqual(changedLines(before, after), [2]);

  // An insertion is new lines, at their positions in the new file.
  assert.deepEqual(changedLines("a\nb\n", "a\nnew1\nnew2\nb\n"), [2, 3]);

  // Nothing to mark when nothing moved, and nothing to mark for a deletion —
  // there's no surviving line to decorate.
  assert.deepEqual(changedLines(before, before), []);
  assert.deepEqual(changedLines("a\nb\nc\n", "a\nc\n"), []);
});

test("changedLines handles a rewrite with no common lines at all", () => {
  assert.deepEqual(changedLines("old\n", "new\n"), [1]);
});
