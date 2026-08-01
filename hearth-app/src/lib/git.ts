import { invoke } from "@tauri-apps/api/core";
import { readTextFile, writeTextFile } from "./fs";
import { applyEdits, resolveInProject } from "./edit";
import { parseHunks, parseNameStatus, type FileChange, type Hunk } from "./gitdiff";

// Checkpoints via git, per build plan §7: don't build a versioning system.
// Every agent turn that changes something becomes a commit in a repo living at
// `.hearth/git`, which is what makes "show me the diff" and "put it back" two
// git calls instead of a snapshot store.

export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** These commits are Hearth's, not the user's — so don't inherit their global
 *  identity, and don't fail on a machine that has never set one. */
const IDENTITY = ["-c", "user.name=Hearth", "-c", "user.email=hearth@localhost"];

/** Checkpoints answer "what did the agent change", so directories it never
 *  writes are noise — and `add -A` across node_modules is slow enough to feel.
 *  The project's own .gitignore is honoured on top of this, since it sits in
 *  the work tree. Written to the repo's `info/exclude` rather than a
 *  `.gitignore`: a file in the user's project is a change they didn't ask for. */
const EXCLUDE = ["node_modules/", ".hearth/", "dist/", "build/", ".next/", "target/", ""].join("\n");

export function git(root: string, ...args: string[]): Promise<GitOutput> {
  return invoke("git", { root, args });
}

/**
 * Create the checkpoint repo on first use, with a baseline commit.
 *
 * The baseline is what makes the first turn's card show that turn's changes
 * rather than the entire project. Called before a turn rather than at project
 * creation, so a project the agent never touches never gets a repo — and so
 * folders opened from outside the workspace get one too.
 */
export async function ensureRepo(root: string): Promise<void> {
  if ((await git(root, "rev-parse", "HEAD")).code === 0) return;
  await git(root, "init");
  await writeTextFile(resolveInProject(root, ".hearth/git/info/exclude"), EXCLUDE);
  // Without this, restoring a checkpoint on Windows rewrites every line ending
  // in the project — a diff against the user's own git for files git never
  // touched.
  await git(root, "config", "core.autocrlf", "false");
  await commitAll(root, "baseline");
}

/** Commit everything in the work tree. Returns the sha, or null when the turn
 *  changed nothing on disk — a card with no files in it isn't worth showing. */
export async function commitAll(root: string, message: string): Promise<string | null> {
  await git(root, "add", "-A");
  // Ask before committing: `git commit` with nothing staged exits non-zero,
  // which is the same signal as a real failure.
  if (!(await git(root, "status", "--porcelain")).stdout.trim()) return null;
  const res = await git(root, ...IDENTITY, "commit", "-m", message);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "git commit failed");
  return (await git(root, "rev-parse", "HEAD")).stdout.trim();
}

export interface Checkpoint {
  sha: string;
  /** The prompt that produced the turn — `commitAll` uses it as the message. */
  message: string;
  when: string;
}

/**
 * Every checkpoint, newest first — build plan §13's timeline.
 *
 * The repo has held this all along; until now the only way to reach a
 * checkpoint was the card in the transcript, so clearing the chat hid history
 * git still had. NUL-separated because a commit message is the user's prompt
 * and can contain anything, including the separators a friendlier format would
 * have used.
 */
export async function listCheckpoints(root: string, max: number): Promise<Checkpoint[]> {
  const out = await git(root, "log", `--max-count=${max}`, "--format=%H%x00%s%x00%cr");
  if (out.code !== 0) return []; // no repo yet: the agent has never run here
  return out.stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, "").split("\0"))
    .filter((fields) => fields.length === 3)
    .map(([sha, message, when]) => ({ sha, message, when }));
}

/** `git show` rather than `diff <sha>~ <sha>`: it handles the root commit,
 *  which has no parent to diff against. */
export async function changedFiles(root: string, sha: string): Promise<FileChange[]> {
  return parseNameStatus((await git(root, "show", "--name-status", "--format=", sha)).stdout);
}

/** A file as the last checkpoint left it, for comparing against what's in the
 *  editor now. Empty when the file is newer than any checkpoint, which renders
 *  as a whole-file addition — which is what it is. */
export async function committedVersion(root: string, path: string): Promise<string> {
  const res = await git(root, "show", `HEAD:${path}`);
  return res.code === 0 ? res.stdout : "";
}

/** Both sides of one file at a checkpoint. A missing side — a file added by
 *  this commit, or deleted by it — reads back as empty, which is exactly what
 *  the diff view renders as a whole-file addition or deletion. */
export async function fileVersions(root: string, sha: string, path: string): Promise<{ before: string; after: string }> {
  const [before, after] = await Promise.all([
    git(root, "show", `${sha}~:${path}`),
    git(root, "show", `${sha}:${path}`),
  ]);
  return {
    before: before.code === 0 ? before.stdout : "",
    after: after.code === 0 ? after.stdout : "",
  };
}

/** The hunks of one file's change at a checkpoint. `git show` again rather than
 *  `diff`, for the same reason as `changedFiles`: it handles the root commit. */
export async function fileHunks(root: string, sha: string, path: string): Promise<Hunk[]> {
  return parseHunks((await git(root, "show", "--format=", "-U3", sha, "--", path)).stdout);
}

/**
 * Undo one hunk in the *working* file — build plan §8's reject-per-hunk.
 *
 * Against the file on disk, not the commit: the checkpoint is history and stays
 * as it is. What's being asked is "keep the turn, minus this part", which is a
 * change to the file the user has now.
 *
 * Reuses the agent's own search/replace matcher rather than applying a patch by
 * line number, which means it inherits the tolerance for whitespace drift and,
 * more importantly, the refusal to fuzzy-apply: if the file moved on since the
 * checkpoint, this fails loudly instead of reverting the wrong lines.
 */
export async function revertHunk(root: string, path: string, hunk: Hunk): Promise<void> {
  // No context and nothing added: there's no text to search for, and an empty
  // search matches at position zero.
  if (hunk.after === "") throw new Error("this hunk only removed lines — restore the whole checkpoint instead");

  const target = resolveInProject(root, path);
  const current = await readTextFile(target);
  const { content, failures } = applyEdits(current, [{ search: hunk.after, replace: hunk.before }]);
  if (failures.length > 0) {
    throw new Error("this hunk no longer matches the file — it has changed since the checkpoint");
  }
  await writeTextFile(target, content);
}

/** Put the work tree back to how it looked right after this checkpoint.
 *  Untracked files (node_modules, build output) are left alone. */
export async function restore(root: string, sha: string): Promise<void> {
  const res = await git(root, "reset", "--hard", sha);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "git reset failed");
}
