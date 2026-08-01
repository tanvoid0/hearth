import { useEffect, useState } from "react";
import { useHearthStore } from "../lib/store";
import { changedFiles, fileVersions, listCheckpoints, restore, type Checkpoint } from "../lib/git";
import { changeLabel, type FileChange } from "../lib/gitdiff";

/**
 * Build plan §13's checkpoint timeline, read from `.hearth/git`.
 *
 * The repo has held every turn since P8; what was missing was a way to reach
 * one that wasn't the card in the transcript — so clearing the chat hid history
 * git still had, and there was no way at all to see turns from a previous
 * session.
 *
 * Deliberately not the staging/branching UI §13 also lists. That surface is the
 * *user's* repo, not Hearth's checkpoint repo, and putting both behind one
 * "Source control" tab would make it very easy to reset the wrong one.
 */
const MAX_CHECKPOINTS = 100;

export function HistoryPanel({ root }: { root: string }) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpen(null);
    listCheckpoints(root, MAX_CHECKPOINTS).then(setCheckpoints, () => setCheckpoints([]));
  }, [root]);

  async function toggle(sha: string) {
    if (open === sha) return setOpen(null);
    setOpen(sha);
    setFiles([]);
    setFiles(await changedFiles(root, sha).catch(() => []));
  }

  async function review(sha: string, file: FileChange) {
    setError(null);
    try {
      const { before, after } = await fileVersions(root, sha, file.path);
      useHearthStore.getState().openDiff({
        path: file.path,
        label: `checkpoint ${sha.slice(0, 7)}`,
        original: before,
        modified: after,
        sha,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function restoreTo(sha: string) {
    if (!confirm(`Restore the project to checkpoint ${sha.slice(0, 7)}?\n\nEverything after it is discarded.`)) return;
    setError(null);
    try {
      await restore(root, sha);
      useHearthStore.getState().closeDiff();
      await useHearthStore.getState().rehydrateFromDisk();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2 text-[11px] text-neutral-500">
        <span className="uppercase tracking-wide">History</span>
        {checkpoints && checkpoints.length > 0 && <span className="text-neutral-400">{checkpoints.length}</span>}
        <button
          onClick={() => void listCheckpoints(root, MAX_CHECKPOINTS).then(setCheckpoints)}
          title="Reload"
          className="ml-auto rounded px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        >
          ↻
        </button>
      </div>

      {error && <div className="shrink-0 bg-red-950/40 px-2 py-1 text-[11px] text-red-300">{error}</div>}

      <div className="min-h-0 flex-1 overflow-auto text-[12px]">
        {checkpoints === null ? (
          <p className="p-3 text-neutral-600">Reading checkpoints…</p>
        ) : checkpoints.length === 0 ? (
          <p className="p-3 text-neutral-600">
            No checkpoints yet — one is written every time an agent turn changes a file.
          </p>
        ) : (
          checkpoints.map((cp) => (
            <div key={cp.sha} className="border-b border-neutral-900">
              <div className="flex items-center gap-2 px-2 py-1 hover:bg-neutral-800/60">
                <button onClick={() => void toggle(cp.sha)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className="shrink-0 font-mono text-[11px] text-neutral-500">◈ {cp.sha.slice(0, 7)}</span>
                  <span className="min-w-0 flex-1 truncate text-neutral-300">{cp.message}</span>
                  <span className="shrink-0 text-[11px] text-neutral-600">{cp.when}</span>
                </button>
                <button
                  onClick={() => void restoreTo(cp.sha)}
                  title="Reset the project to how it looked right after this turn. Untracked files are left alone."
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
                >
                  Restore
                </button>
              </div>
              {open === cp.sha &&
                files.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => void review(cp.sha, f)}
                    className="flex w-full items-center gap-2 py-0.5 pl-8 pr-2 text-left font-mono text-[11px] hover:bg-neutral-800"
                  >
                    <span className="w-3 shrink-0 text-neutral-500" title={changeLabel(f.status)}>
                      {f.status}
                    </span>
                    <span className="truncate text-neutral-400">{f.path}</span>
                  </button>
                ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
