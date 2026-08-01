// Parsing for the checkpoint cards. Import-free like the other parsing modules
// (runlog, pull, edit) so `npm test` runs gitdiff.test.ts against it directly.

export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T";

export interface FileChange {
  status: ChangeStatus;
  path: string;
}

const LABELS: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type changed",
};

export function changeLabel(status: ChangeStatus): string {
  return LABELS[status] ?? status;
}

/**
 * Parse `git show --name-status --format= <sha>` output.
 *
 * Renames and copies arrive as three fields — `R100\told\tnew` — and the one
 * that matters is the last. Splitting on the first tab and taking field two
 * would yield `old`, a path that no longer exists at that commit, so every
 * `git show <sha>:<path>` against it would come back empty and the diff would
 * render as a whole-file deletion.
 */
/** One `@@` block of a unified diff, with both sides reassembled. */
export interface Hunk {
  /** The `@@ -a,b +c,d @@` line, used as the row's label. */
  header: string;
  /** Where the hunk starts in the new file — what a jump-to would use. */
  line: number;
  /** The hunk's lines as the file looked before, and as it looks after.
   *  Context lines are in both, which is what gives a revert an anchor to
   *  match against. */
  before: string;
  after: string;
}

/**
 * Split a unified diff into hunks.
 *
 * Reassembling both whole sides rather than keeping the +/- markers is the
 * point: a revert is then `applyEdits(current, { search: after, replace:
 * before })`, which is the same whitespace-tolerant matcher the agent's own
 * edits go through, including its refusal to fuzzy-apply. No second
 * patch-application path to keep correct.
 */
export function parseHunks(unified: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let before: string[] = [];
  let after: string[] = [];

  const flush = () => {
    if (current) hunks.push({ ...current, before: before.join("\n"), after: after.join("\n") });
  };

  for (const raw of unified.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const at = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (at) {
      flush();
      current = { header: line, line: Number(at[1]), before: "", after: "" };
      before = [];
      after = [];
      continue;
    }
    if (!current) continue; // the `diff --git` / `index` / `---` preamble
    const body = line.slice(1);
    // Anything else — "\ No newline at end of file", the trailing empty string
    // from the split — belongs to neither side.
    if (line.startsWith(" ")) {
      before.push(body);
      after.push(body);
    } else if (line.startsWith("-")) {
      before.push(body);
    } else if (line.startsWith("+")) {
      after.push(body);
    }
  }
  flush();
  return hunks;
}

export function parseNameStatus(out: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length < 2) continue;
    // R and C carry a similarity score (`R100`); the letter is the status.
    changes.push({ status: fields[0][0] as ChangeStatus, path: fields[fields.length - 1] });
  }
  return changes;
}
