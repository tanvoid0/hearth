import { test } from "node:test";
import assert from "node:assert/strict";
import { isSecretFile, mask, parseEnv, redactEnv, setEnvValue } from "./secrets.ts";

test("isSecretFile catches the .env family but not its committed examples", () => {
  for (const yes of [".env", ".env.local", ".env.production", "app/.env", "C:\\p\\.env.local"]) {
    assert.ok(isSecretFile(yes), yes);
  }
  // These are checked into repos on purpose and hold placeholders, so redacting
  // them would hide the one thing they exist to show.
  for (const no of [".env.example", ".env.sample", "env.js", "src/.environment", "README.md"]) {
    assert.ok(!isSecretFile(no), no);
  }
});

test("parseEnv reads assignments and ignores comments", () => {
  const text = `# a comment
API_KEY=abc123

export TOKEN="quoted value"
NOT AN ASSIGNMENT
EMPTY=
`;
  assert.deepEqual(parseEnv(text), [
    { key: "API_KEY", value: "abc123", line: 2 },
    { key: "TOKEN", value: "quoted value", line: 4 },
    { key: "EMPTY", value: "", line: 6 },
  ]);
});

test("parseEnv does not treat a commented-out assignment as one", () => {
  // Otherwise the panel offers to edit a key that isn't set, and writing it
  // back would uncomment it.
  assert.deepEqual(parseEnv("# API_KEY=old\n"), []);
});

test("mask blanks a short value completely rather than half-showing it", () => {
  // Four characters of an eight-character secret is most of a secret.
  assert.equal(mask("shortkey"), "••••••••");
  assert.equal(mask("sk-live-1234567890abcd"), "•••••••• abcd");
  assert.equal(mask(""), "");
});

test("redactEnv keeps the keys and loses the values", () => {
  // The agent legitimately needs to know which variables exist — answering with
  // nothing at all sends it guessing at names.
  const out = redactEnv("# config\nAPI_KEY=sk-live-abc\nEMPTY=\n");
  assert.match(out, /^# config$/m, "comments are not secrets");
  assert.match(out, /^API_KEY=<redacted; 11 chars>$/m);
  assert.doesNotMatch(out, /sk-live-abc/);
  // An unset key has nothing to hide, and "0 chars" reads as if it did.
  assert.match(out, /^EMPTY=$/m);
});

test("setEnvValue changes one line and leaves the rest of the file alone", () => {
  const before = `# keep me
API_KEY=old
OTHER=1
`;
  const after = setEnvValue(before, "API_KEY", "new");
  assert.equal(after, "# keep me\nAPI_KEY=new\nOTHER=1\n");

  // Rebuilding from parsed entries would be shorter and would delete this.
  assert.match(after, /# keep me/);
});

test("setEnvValue appends a key that isn't there yet, once", () => {
  assert.equal(setEnvValue("A=1\n", "B", "2"), "A=1\nB=2\n");
  assert.equal(setEnvValue("", "B", "2"), "B=2\n");
  // And doesn't grow a blank line every time it's called.
  assert.equal(setEnvValue(setEnvValue("A=1\n", "B", "2"), "C", "3"), "A=1\nB=2\nC=3\n");
});

test("setEnvValue quotes a value that would otherwise be read as two things", () => {
  assert.equal(setEnvValue("", "MSG", "hello world"), 'MSG="hello world"\n');
  assert.equal(setEnvValue("", "HASH", "a#b"), 'HASH="a#b"\n');
  assert.equal(setEnvValue("", "PLAIN", "abc123"), "PLAIN=abc123\n");
});

test("setEnvValue keeps an export prefix", () => {
  assert.equal(setEnvValue("export A=1\n", "A", "2"), "export A=2\n");
});
