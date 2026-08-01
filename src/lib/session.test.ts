import test from "node:test";
import assert from "node:assert/strict";
import {
  contextLimits,
  packHistory,
  packTab,
  rebaseTab,
  stalled,
  trimForStorage,
  worthRepairing,
  wroteThisTurn,
  type Tab,
} from "./session.ts";

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

test("a turn interrupted mid-flight comes back resumable, and out of history", () => {
  // What a reload has to survive: the turn's prompt, the tool results it had
  // already collected, and the id of the model call the dead page orphaned.
  const partial = [
    { role: "system", content: "you are working in C:/proj" },
    { role: "user", content: "rename the button" },
    { role: "assistant", content: "reading" },
    { role: "tool", content: "c".repeat(400) },
  ];
  // 500 is small enough to force a trim, as a long turn eventually does.
  const packed = packHistory(partial, 500);

  assert.equal(packed[0].role, "system", "resuming needs the system prompt as much as a new turn does");
  assert.ok(
    packed.every((m, i) => i === 0 || m.role !== "tool" || packed[i - 1]?.role === "assistant"),
    "a trimmed resume must not open on a tool result whose call went with it",
  );
});

test("a resumed turn remembers the writes it made before the reload", () => {
  const earlierTurn = [
    { role: "system", content: "you are working in C:/proj" },
    { role: "user", content: "add a header" },
    { role: "assistant", content: "" },
    { role: "tool", tool_name: "write_file", content: "wrote src/Header.jsx" },
    { role: "assistant", content: "done" },
  ];
  // A new question after all that: this turn has written nothing yet, and
  // counting the last one's write would put a project check in front of a
  // reply that changed no files.
  assert.equal(wroteThisTurn([...earlierTurn, { role: "user", content: "what does it do?" }]), false);

  // The case that matters: cut off after an edit landed. Ending here without
  // verifying reports a half-finished turn as a successful one.
  assert.equal(
    wroteThisTurn([
      ...earlierTurn,
      { role: "user", content: "rename it" },
      { role: "assistant", content: "" },
      { role: "tool", tool_name: "read_file", content: "…" },
      { role: "assistant", content: "" },
      { role: "tool", tool_name: "edit_file", content: "applied" },
    ]),
    true,
  );

  // With PLAN on, the last user message is the plan's acknowledgement rather
  // than the prompt — still inside the turn, still ahead of every tool call.
  assert.equal(
    wroteThisTurn([
      { role: "system", content: "you are working in C:/proj" },
      { role: "user", content: "rename it" },
      { role: "user", content: "write a short numbered plan" },
      { role: "assistant", content: "1. read it 2. rename it" },
      { role: "user", content: "now carry that out" },
      { role: "assistant", content: "" },
      { role: "tool", tool_name: "edit_file", content: "applied" },
    ]),
    true,
  );
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

test("a productive check-edit-check loop is not mistaken for a stuck one", () => {
  // The thing this app wants the agent to do: edit, check, edit, check. The
  // calls repeat; the *results* don't, because each edit changed something.
  const productive = [
    "get_errors:null:2 errors",
    "edit_file:{}:applied",
    "get_errors:null:1 error",
    "edit_file:{}:applied",
    "get_errors:null:none",
  ];
  assert.equal(stalled(productive), false);
});

test("the same call returning the same answer three times is stuck", () => {
  const spinning = ["read_file:a:x", "edit_file:e:failed", "read_file:a:x", "edit_file:e:failed", "read_file:a:x"];
  assert.equal(stalled(spinning), true);
  // Two of a kind isn't yet a loop — a retry after an unrelated step is normal.
  assert.equal(stalled(spinning.slice(0, 3)), false);
  assert.equal(stalled([]), false);
});

test("a repair round is only worth repeating if the model actually changed something", () => {
  // The first bounce is the prod, and it's free of any precondition.
  assert.equal(worthRepairing(0, 3, false), true);
  // It edited after being told, so the verdict can genuinely differ. Bounce on.
  assert.equal(worthRepairing(1, 3, true), true);
  // It re-asserted `finish` with nothing written in between. The verdict is
  // read off the project, so a second check reads the same files and returns
  // the same answer — measured as gemma4's usual response to a bounce.
  assert.equal(worthRepairing(1, 3, false), false);
  // And the cap still binds when it has been editing all along.
  assert.equal(worthRepairing(3, 3, true), false);
});
