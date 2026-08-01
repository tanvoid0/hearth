import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFences } from "./markdown.ts";

test("plain prose comes back as one segment", () => {
  assert.deepEqual(splitFences("hello\nthere"), [{ kind: "text", text: "hello\nthere" }]);
});

test("a fenced block is split out with its language", () => {
  assert.deepEqual(splitFences("before\n```ts\nconst a = 1;\n```\nafter"), [
    { kind: "text", text: "before" },
    { kind: "code", lang: "ts", code: "const a = 1;", closed: true },
    { kind: "text", text: "after" },
  ]);
});

test("an unterminated fence still renders as code", () => {
  // This is the streaming case, and it is the common one: tokens arrive one at
  // a time, so the closing fence lands seconds after the code does. Treating an
  // open fence as prose would make a reply flicker between styles as it
  // streams, and hide the code until the very end.
  assert.deepEqual(splitFences("here you go\n```js\nconst a = 1;"), [
    { kind: "text", text: "here you go" },
    { kind: "code", lang: "js", code: "const a = 1;", closed: false },
  ]);
});

test("a bare fence with no language is still a code block", () => {
  const [seg] = splitFences("```\nplain\n```");
  assert.deepEqual(seg, { kind: "code", lang: "", code: "plain", closed: true });
});

test("several blocks in one reply stay separate", () => {
  const kinds = splitFences("a\n```\none\n```\nb\n```\ntwo\n```").map((s) => s.kind);
  assert.deepEqual(kinds, ["text", "code", "text", "code"]);
});

test("blank-only prose between blocks is dropped, blank lines inside code are kept", () => {
  assert.deepEqual(splitFences("```\n\n```\n\n```\n\n```").map((s) => s.kind), ["code", "code"]);
  const [block] = splitFences("```\na\n\nb\n```");
  assert.equal(block.kind === "code" && block.code, "a\n\nb");
});

test("inline backticks are left alone", () => {
  // Only ``` at the start of a line opens a block — a sentence mentioning
  // `useState` must not swallow the rest of the reply.
  assert.deepEqual(splitFences("use `useState` here"), [{ kind: "text", text: "use `useState` here" }]);
});
