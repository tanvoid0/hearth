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
