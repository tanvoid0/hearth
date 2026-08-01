import test from "node:test";
import assert from "node:assert/strict";
import { contextLimits, packHistory, packTab, rebaseTab, trimForStorage, type Tab } from "./session.ts";

const tab = (content: string, savedContent: string): Tab => ({
  path: "C:/p/a.ts",
  name: "a.ts",
  content,
  savedContent,
});

// The round trip a reload puts a tab through: pack into localStorage, then
// rebase against whatever is on disk when the app comes back.
const roundTrip = (t: Tab, disk: string) => rebaseTab(packTab(t), disk);

test("a clean tab comes back with whatever disk holds now", () => {
  const packed = packTab(tab("old", "old"));
  assert.equal(packed.content, "", "clean content isn't worth persisting");
  const back = roundTrip(tab("old", "old"), "changed on disk");
  assert.deepEqual([back.content, back.savedContent], ["changed on disk", "changed on disk"]);
});

test("an unsaved draft survives the reload and stays dirty", () => {
  const back = roundTrip(tab("draft", "old"), "old");
  assert.equal(back.content, "draft");
  assert.notEqual(back.content, back.savedContent);
});

test("a draft edited down to empty is still a draft, not a clean tab", () => {
  const back = roundTrip(tab("", "old"), "old");
  assert.equal(back.content, "");
  assert.notEqual(back.content, back.savedContent);
});

test("trimForStorage keeps the newest items that fit, and never returns nothing", () => {
  assert.deepEqual(trimForStorage([1, 2, 3, 4], 2), [3, 4]); // each serialises to 1 char
  assert.deepEqual(trimForStorage(["x".repeat(500)], 10), ["x".repeat(500)]);
});

test("packHistory keeps the system prompt and drops orphaned tool results", () => {
  const history = [
    { role: "system", content: "you are working in C:/proj" },
    { role: "user", content: "a".repeat(400) },
    { role: "assistant", content: "calling a tool" },
    { role: "tool", content: "b".repeat(400) },
    { role: "user", content: "next" },
  ];
  const packed = packHistory(history, 500);

  assert.equal(packed[0].role, "system", "the system prompt names the project root — it must survive");
  assert.ok(
    packed.every((m, i) => i === 0 || m.role !== "tool" || packed[i - 1]?.role === "assistant"),
    "a tool result must never lead the restored history",
  );
  assert.deepEqual(packed.at(-1), { role: "user", content: "next" });
});

test("contextLimits keeps one file read to half the window", () => {
  // The guard is against a single read_file being larger than the context it
  // has to fit in — at which point Ollama truncates from the front and the
  // system prompt goes with it.
  for (const numCtx of [4096, 8192, 16384, 32768]) {
    const { history, read } = contextLimits(numCtx);
    assert.ok(read * 2 <= history, `a read must not exceed half the window at num_ctx ${numCtx}`);
  }
  // …and stays capped once the window is big enough that half of it is silly.
  assert.equal(contextLimits(4096).read, 6144);
  assert.equal(contextLimits(131072).read, 40_000);
});

test("a big file read still leaves the system prompt in place", () => {
  const { history: budget, read } = contextLimits(4096);
  const messages = [
    { role: "system", content: "you are working in C:/proj" },
    { role: "user", content: "fix the header" },
    { role: "assistant", content: "reading" },
    { role: "tool", content: "a".repeat(read) },
    { role: "assistant", content: "reading again" },
    { role: "tool", content: "b".repeat(read) },
  ];
  const packed = packHistory(messages, budget);

  assert.equal(packed[0].role, "system");
  assert.notEqual(packed.at(-1)?.role, "system", "the newest turn has to survive too");
  assert.ok(
    packed.every((m, i) => i === 0 || m.role !== "tool" || packed[i - 1]?.role === "assistant"),
    "trimming must not leave a tool result without its call",
  );
});
