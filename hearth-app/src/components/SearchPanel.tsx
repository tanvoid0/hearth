import { useState } from "react";
import { useLsp } from "../lib/lsp";
import { resolveInProject } from "../lib/edit";
import { searchFiles, type SearchHit } from "../lib/fs";

/** Enough to see that a name is used everywhere without paging; past this the
 *  answer is "narrow the query", not "scroll further". */
const MAX_HITS = 200;

/**
 * Build plan §4.7's search panel. The walk, the skip list and the literal match
 * live in Rust — this is the same `search_files` the agent calls, which is the
 * point: one search, not one for the model and a different one for the user.
 *
 * On Enter rather than as you type. The search reads every file in the project
 * on every call (deliberately — see `search_files` for why there's no index),
 * and a keystroke-triggered walk of a large repo is how a panel becomes the
 * reason the app feels slow.
 *
 * Replace-across-project isn't here. The plan lists it, but a bulk rewrite the
 * user starts has no undo boundary — checkpoints are per agent turn — and the
 * agent's own edit path already does project-wide changes with one behind it.
 */
export function SearchPanel({ root }: { root: string }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setHits(await searchFiles(root, query, MAX_HITS));
    } catch (err) {
      setError(String(err));
      setHits(null);
    } finally {
      setBusy(false);
    }
  }

  function show(hit: SearchHit) {
    // Through the agent's own resolver, not string concatenation: hits come
    // back with forward slashes and tabs are keyed by the exact path string, so
    // `root + "/" + rel` would open a second tab for a file the tree already
    // has open under backslashes.
    //
    // `jumpTo` alone opens the tab as well — the editor that lands on the file
    // is the one that applies the position, since opening unmounts the one that
    // asked.
    useLsp.getState().jumpTo(resolveInProject(root, hit.path), hit.line, 1);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2 text-[11px] text-neutral-500">
        <span className="shrink-0 uppercase tracking-wide">Search</span>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void run()}
          placeholder="Text to find, then Enter"
          spellCheck={false}
          className="min-w-0 flex-1 rounded bg-neutral-800 px-1.5 py-0.5 text-[12px] text-neutral-200 outline-none placeholder:text-neutral-600"
        />
        {hits && !busy && (
          <span className="shrink-0 text-neutral-400">
            {hits.length}
            {hits.length === MAX_HITS ? "+" : ""}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px]">
        {busy ? (
          <p className="p-3 text-[12px] text-neutral-600">Searching…</p>
        ) : error ? (
          <p className="p-3 text-[12px] text-red-400">{error}</p>
        ) : !hits ? (
          <p className="p-3 text-[12px] text-neutral-600">
            Literal, case-insensitive, skipping node_modules and the other directories the file tree hides.
          </p>
        ) : hits.length === 0 ? (
          <p className="p-3 text-[12px] text-neutral-600">No matches.</p>
        ) : (
          hits.map((hit, i) => (
            <button
              key={`${hit.path}:${hit.line}:${i}`}
              onClick={() => show(hit)}
              className="flex w-full gap-2 border-b border-neutral-900 px-2 py-1 text-left hover:bg-neutral-800/60"
            >
              <span className="min-w-0 flex-1 truncate text-neutral-200">{hit.text}</span>
              <span className="shrink-0 text-neutral-500">
                {hit.path}:{hit.line}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
