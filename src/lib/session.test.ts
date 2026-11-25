import test from "node:test";
import assert from "node:assert/strict";
import {
  addCall,
  contextLimits,
  isServerScript,
  packHistory,
  sendWindow,
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

test("the sent window holds its prefix still while a turn grows", () => {
  // Build plan §5: Ollama reuses its KV cache only for a byte-identical
  // prefix, so what matters is that appending doesn't shift where the window
  // starts. A turn is a dozen appends, and `packHistory` moves on every one.
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: "you are working in C:/proj" },
    { role: "user", content: "rename the button" },
  ];
  const budget = 2000;

  let start = 0;
  const starts: number[] = [];
  const prefixes: string[] = [];
  // Each pair is an assistant turn plus a file read, which is what actually
  // fills the window — 12 of them takes it well past the budget.
  for (let i = 0; i < 12; i++) {
    messages.push({ role: "assistant", content: `step ${i}` });
    messages.push({ role: "tool", content: "x".repeat(300) });
    const w = sendWindow(messages, budget, start);
    start = w.start;
    starts.push(start);
    prefixes.push(JSON.stringify(w.messages.slice(0, 2)));

    assert.equal(w.messages[0].role, "system", "the system prompt must survive every cut");
    assert.ok(
      w.messages.every((m, j) => j === 0 || m.role !== "tool" || w.messages[j - 1]?.role === "assistant"),
      "the window must never open on a tool result whose call was cut away",
    );
    assert.ok(
      JSON.stringify(w.messages.slice(1)).length <= budget,
      "a window that never fits is not a window",
    );
  }

  assert.ok(
    starts.every((s, i) => i === 0 || s >= starts[i - 1]),
    "the window may only ever move forward — going back re-expands the prefix",
  );
  // The point of the whole thing: a sliding window would produce a new prefix
  // on every append, and pay for a full prompt recompute each time.
  const moves = starts.filter((s, i) => i > 0 && s !== starts[i - 1]).length;
  assert.ok(moves > 0, "12 file reads at this budget must force at least one cut, or the test proves nothing");
  assert.ok(moves < starts.length / 2, `the window moved ${moves} times in ${starts.length} appends`);
  assert.ok(
    new Set(prefixes).size === moves + 1,
    "the prefix must change only when the window moves, and not otherwise",
  );
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

test("the scripts that never exit are the ones bounced to start_app", () => {
  for (const command of ["npm run dev", "pnpm dev", "yarn start", "bun run serve", "  npm run dev  "]) {
    assert.equal(isServerScript(command), true, command);
  }
  // Everything else waits, including the scripts whose names merely start the
  // same way — `npm run build` is exactly what run_command is for.
  for (const command of ["npm test", "npm run build", "npx tsc --noEmit", "npm run develop", "git status"]) {
    assert.equal(isServerScript(command), false, command);
  }
});

test("a turn's rate is total tokens over total seconds, not the mean of its calls", () => {
  // One quick call, then a long slow one — the shape of a turn whose later
  // steps carry a big context. Averaging the two rates would report 55 tok/s;
  // the turn actually produced 910 tokens in 91 seconds.
  const quick = { outTokens: 10, genSecs: 0.1, doneReason: "stop" };
  const slow = { outTokens: 900, genSecs: 90.9, doneReason: "stop" };
  const after = addCall(addCall(null, quick), slow);
  assert.equal(after.calls, 2);
  assert.equal(after.outTokens, 910);
  assert.equal(Math.round(after.tokensPerSec), 10);
});

test("only an unclean stop is reported, and only for the call it happened on", () => {
  assert.equal(addCall(null, { outTokens: 5, genSecs: 1, doneReason: "stop" }).doneReason, undefined);

  // The model filled the window part-way through an answer. Say so.
  const cut = addCall(null, { outTokens: 5, genSecs: 1, doneReason: "length" });
  assert.equal(cut.doneReason, "length");

  // The next call ended cleanly, so the warning goes with the call it described
  // — left standing it would read as though this call had been cut off too.
  assert.equal(addCall(cut, { outTokens: 5, genSecs: 1, doneReason: "stop" }).doneReason, undefined);
});

test("a call whose stream carried no counts is still a call", () => {
  const one = addCall(null, { outTokens: 40, genSecs: 2, doneReason: "length" });
  const two = addCall(one, null);
  // Counted, because it happened and it cost time.
  assert.equal(two.calls, 2);
  // But it contributes nothing to the totals it said nothing about, and it
  // doesn't inherit the previous call's cut-off warning.
  assert.equal(two.outTokens, 40);
  assert.equal(two.tokensPerSec, 20);
  assert.equal(two.doneReason, undefined);
});
