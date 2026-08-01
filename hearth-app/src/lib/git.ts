import { invoke } from "@tauri-apps/api/core";
import { writeTextFile } from "./fs";
import { resolveInProject } from "./edit";
import { parseNameStatus, type FileChange } from "./gitdiff";

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

/** `git show` rather than `diff <sha>~ <sha>`: it handles the root commit,
 *  which has no parent to diff against. */
export async function changedFiles(root: string, sha: string): Promise<FileChange[]> {
  return parseNameStatus((await git(root, "show", "--name-status", "--format=", sha)).stdout);
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

/** Put the work tree back to how it looked right after this checkpoint.
 *  Untracked files (node_modules, build output) are left alone. */
export async function restore(root: string, sha: string): Promise<void> {
  const res = await git(root, "reset", "--hard", sha);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "git reset failed");
}
