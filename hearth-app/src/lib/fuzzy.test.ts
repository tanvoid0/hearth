import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, score } from "./fuzzy.ts";

const best = (query: string, paths: string[]) => rank(query, paths, (p) => p)[0]?.item;

test("letters have to appear in order, but not adjacently", () => {
  assert.ok(score("abc", "a_b_c"));
  assert.ok(score("abc", "xaxbxc"));
  assert.equal(score("cba", "abc"), null);
  assert.equal(score("xyz", "abc"), null);
  assert.equal(score("abcd", "abc"), null, "a query longer than the text can't match");
});

test("an empty query matches everything", () => {
  assert.deepEqual(score("", "anything"), { score: 0, hits: [] });
  assert.equal(rank("", ["a", "b"], (s) => s).length, 2);
});

test("word starts beat letters buried mid-word", () => {
  // The point of the boundary bonus: "st" should mean store.ts, not the s…t
  // that happens to appear inside "assets".
  assert.equal(best("st", ["src/assets/logo.ts", "src/lib/store.ts"]), "src/lib/store.ts");
});

test("the filename outranks the directories above it", () => {
  // Every letter of the decoy sits just after a slash, so it collects the
  // word-start bonus four times over. Without a basename bonus it wins, and
  // quick-open surfaces junk ahead of the file anyone actually meant.
  assert.equal(best("sess", ["s/e/s/s.ts", "src/lib/session.ts"]), "src/lib/session.ts");
  assert.equal(best("store", ["store/x/y.ts", "src/lib/store.ts"]), "src/lib/store.ts");
});

test("a shorter path wins when the match is otherwise equal", () => {
  // Both match at a word start with a full adjacent run; specificity breaks it.
  assert.equal(best("app", ["src/components/ApprovalPanel.tsx", "src/App.tsx"]), "src/App.tsx");
});

test("matching is case-insensitive but hits index the original text", () => {
  const hit = score("app", "src/App.tsx");
  assert.ok(hit);
  assert.deepEqual(hit.hits, [4, 5, 6]);
  assert.equal("src/App.tsx".slice(4, 7), "App");
});

test("rank drops non-matches and honours the limit", () => {
  const paths = ["alpha.ts", "beta.ts", "gamma.ts"];
  assert.deepEqual(rank("zzz", paths, (p) => p), []);
  assert.equal(rank("a", paths, (p) => p, 2).length, 2);
});
