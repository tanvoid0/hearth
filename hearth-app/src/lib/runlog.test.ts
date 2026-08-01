import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOG_CAP,
  MAX_CONSOLE_CHARS,
  capLog,
  consoleTail,
  devLogTail,
  exitReason,
  formatEntry,
  pushEntry,
  readyUrl,
  type ConsoleEntry,
} from "./runlog.ts";

test("readyUrl fires on vite's banner", () => {
  assert.equal(readyUrl("  ➜  Local:   http://localhost:5173/", 5173), "http://localhost:5173/");
  assert.equal(readyUrl("  ➜  Network: http://192.168.1.4:5173/", 5173), "http://localhost:5173/");
});

test("readyUrl ignores the port mentioned in prose", () => {
  // --strictPort's failure message names the same number; treating it as ready
  // would point the preview iframe at a server that never came up.
  assert.equal(readyUrl("Port 5173 is already in use", 5173), null);
  assert.equal(readyUrl("error when starting dev server: port 5173", 5173), null);
  // vite says "ready" a beat before it prints the URL — the process is up but
  // nothing is served yet, so this must not flip the preview on
  assert.equal(readyUrl("VITE v7.0.4  ready in 431 ms", 5173), null);
});

test("readyUrl won't match a different port that shares a prefix", () => {
  assert.equal(readyUrl("  ➜  Local:   http://localhost:51730/", 5173), null);
});

test("exitReason splits control lines from log output", () => {
  assert.equal(exitReason("[hearth] npm install failed (exit 1)"), "npm install failed (exit 1)");
  assert.equal(exitReason("added 42 packages in 3s"), null);
});

test("capLog keeps the newest lines and drops the oldest", () => {
  let log: string[] = [];
  for (let i = 0; i < LOG_CAP + 50; i++) log = capLog(log, `line ${i}`);
  assert.equal(log.length, LOG_CAP);
  assert.equal(log[log.length - 1], `line ${LOG_CAP + 49}`);
  assert.equal(log[0], "line 50");
});

test("devLogTail sends the agent the newest lines, not the whole log", () => {
  // The failure that matters is at the bottom: a build error follows thousands
  // of npm install lines, and sending the head would spend the context window
  // on package names.
  const log = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const out = devLogTail(true, "http://localhost:5173/", log, 5);
  assert.match(out, /dev server running at http:\/\/localhost:5173\//);
  assert.match(out, /95 earlier lines omitted/);
  assert.ok(out.includes("line 99"));
  assert.ok(!out.includes("line 94"));
});

test("devLogTail distinguishes not-started from started-but-silent", () => {
  // "no errors" and "nothing is running" look identical if both return empty,
  // and the model would report a broken build as fixed.
  assert.match(devLogTail(false, null, []), /not running/);
  assert.match(devLogTail(true, null, []), /starting/);
  assert.match(devLogTail(true, null, []), /no output yet/);
});

test("pushEntry collapses a repeating error instead of filling the buffer", () => {
  // An infinite render loop emits the same message thousands of times. Without
  // this the tail the agent reads is 40 copies of one line and nothing else.
  let entries: ConsoleEntry[] = [];
  for (let i = 0; i < 5000; i++) entries = pushEntry(entries, "error: Too many re-renders");
  assert.deepEqual(entries, [{ text: "error: Too many re-renders", count: 5000 }]);
  assert.equal(formatEntry(entries[0]), "error: Too many re-renders  (×5000)");

  // Only consecutive ones — an error that recurs after something else is news.
  entries = pushEntry(entries, "warn: unique key");
  entries = pushEntry(entries, "error: Too many re-renders");
  assert.equal(entries.length, 3);
  assert.equal(entries[2].count, 1);
});

test("pushEntry caps a single message and the buffer", () => {
  // The message crosses a postMessage boundary from a page Hearth doesn't
  // control, so the snippet's own truncation isn't the guarantee.
  const [huge] = pushEntry([], "x".repeat(MAX_CONSOLE_CHARS * 3));
  assert.equal(huge.text.length, MAX_CONSOLE_CHARS);

  let entries: ConsoleEntry[] = [];
  for (let i = 0; i < LOG_CAP + 50; i++) entries = pushEntry(entries, `error ${i}`);
  assert.equal(entries.length, LOG_CAP);
  assert.equal(entries[0].text, "error 50");
});

test("consoleTail distinguishes no-bridge from a clean console", () => {
  // The whole point of the tool: a disconnected bridge must not read as "the
  // app runs fine". Both have zero messages.
  assert.match(consoleTail(false, []), /not connected/);
  assert.match(consoleTail(true, []), /no errors or warnings/);
});

test("consoleTail separates messages that predate the agent's last edit", () => {
  const entries = [
    { text: "error: old crash", count: 1 },
    { text: "error: new crash", count: 1 },
  ];
  const out = consoleTail(true, entries, 1);
  assert.match(out, /old crash\n── since your last edit ──\nerror: new crash/);

  // Nothing new after the edit is a verdict, not an absence — say it, or the
  // model reads the surviving old error as its own fix failing.
  assert.match(consoleTail(true, entries, 2), /nothing new since your last edit/);
  // No edit yet, so there's no line to draw.
  assert.doesNotMatch(consoleTail(true, entries, 0), /your last edit/);
});

test("consoleTail tails rather than heads, and counts what it dropped", () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ text: `error ${i}`, count: 1 }));
  const out = consoleTail(true, entries, 0, 5);
  assert.match(out, /95 earlier messages omitted/);
  assert.ok(out.includes("error 99"));
  assert.ok(!out.includes("error 94"));
});
