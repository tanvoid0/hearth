import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntries } from "./transcript.ts";

const line = (entry: unknown) => `${JSON.stringify(entry)}
`;

test("a transcript parses back to the entries that were written", () => {
  const written = [{ kind: "user", text: "hello" }, { kind: "tool", label: "read_file", ok: true }]
    .map(line)
    .join("");
  const { entries, omitted } = decodeEntries(written);
  assert.equal(omitted, 0);
  assert.deepEqual(entries, [
    { kind: "user", text: "hello" },
    { kind: "tool", label: "read_file", ok: true },
  ]);
});

test("an entry containing a newline is still one line", () => {
  // The format rests on this: a tool result is routinely a hundred lines of
  // build output, and only JSON escaping keeps it on one row.
  const one = line({ kind: "tool", detail: "line one\nline two" });
  assert.equal(one.split("\n").length, 2);
  assert.deepEqual(decodeEntries(one).entries, [{ kind: "tool", detail: "line one\nline two" }]);
});

test("a half-written last line costs that line and nothing else", () => {
  // Killing the app mid-append is the ordinary way this happens, and losing
  // every conversation in the project to it would be the worst bug here.
  const blob = line({ kind: "user", text: "kept" }) + '{"kind":"user","text":"trunc';
  const { entries } = decodeEntries(blob);
  assert.deepEqual(entries, [{ kind: "user", text: "kept" }]);
});

test("decode keeps the newest entries and says how many it skipped", () => {
  const blob = Array.from({ length: 10 }, (_, i) => line({ n: i })).join("");
  const { entries, omitted } = decodeEntries<{ n: number }>(blob, 4);
  assert.equal(omitted, 6);
  assert.deepEqual(entries.map((e) => e.n), [6, 7, 8, 9]);
});
