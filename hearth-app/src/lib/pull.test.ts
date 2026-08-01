import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_PULL, pullPercent, reducePull, type PullChunk } from "./pull.ts";

const feed = (...chunks: PullChunk[]) => chunks.reduce(reducePull, EMPTY_PULL);

test("pullPercent spans every layer, not just the newest", () => {
  // The failure this guards: reading percent off the latest chunk alone, which
  // snaps back to 0% each time ollama starts another layer.
  const state = feed(
    { status: "pulling manifest" },
    { status: "pulling aa", digest: "aa", total: 100, completed: 100 },
    { status: "pulling bb", digest: "bb", total: 100, completed: 0 },
  );
  assert.equal(pullPercent(state), 50);
});

test("pullPercent is null until a layer declares a size", () => {
  assert.equal(pullPercent(EMPTY_PULL), null);
  assert.equal(pullPercent(feed({ status: "pulling manifest" })), null);
});

test("a later chunk replaces its layer rather than adding to it", () => {
  const state = feed(
    { digest: "aa", total: 100, completed: 20 },
    { digest: "aa", total: 100, completed: 90 },
  );
  assert.equal(pullPercent(state), 90);
});

test("reducePull surfaces an error chunk and stops", () => {
  // Ollama answers a bad model name with 200 and an error in the body, so this
  // is the only place it shows up.
  const state = feed({ error: "pull model manifest: file does not exist" });
  assert.equal(state.error, "pull model manifest: file does not exist");
  assert.ok(state.done);
});

test("reducePull marks success", () => {
  assert.ok(feed({ digest: "aa", total: 10, completed: 10 }, { status: "success" }).done);
  assert.ok(!feed({ status: "verifying sha256 digest" }).done);
});
