import { useState } from "react";
import { useLsp } from "../lib/lsp";
import { useHearthStore } from "../lib/store";
import { resolveInProject } from "../lib/edit";
import { searchChats, type ChatHit } from "../lib/chat";
import { searchFiles, type SearchHit } from "../lib/fs";

/** Enough to see that a name is used everywhere without paging; past this the
 *  answer is "narrow the query", not "scroll further". */
const MAX_HITS = 200;

type Mode = "files" | "chats";

/**
 * Build plan §4.7's search panel, over two sources.
 *
 * **Files** is the same `search_files` the agent calls — one search, not one
 * for the model and a different one for the user. The walk, the skip list and
 * the literal match live in Rust.
 *
 * **Chats** searches every conversation in every project, which is the thing a
 * database buys over a transcript file per project and the reason the store is
 * one. "Where did I solve this before" is a question about the projects you
 * aren't currently in.
 *
 * On Enter rather than as you type: the file search reads every file in the
 * project on every call (deliberately — see `search_files` for why there's no
 * index), and a keystroke-triggered walk of a large repo is how a panel becomes
 * the reason an app feels slow.
 *
 * Replace-across-project isn't here. The plan lists it, but a bulk rewrite the
 * user starts has no undo boundary — checkpoints are per agent turn — and the
 * agent's own edit path already does project-wide changes with one behind it.
 */
export function SearchPanel({ root }: { root: string }) {
  const [mode, setMode] = useState<Mode>("files");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [chats, setChats] = useState<ChatHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const results = mode === "files" ? hits : chats;

  async function run(next: Mode = mode) {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (next === "files") setHits(await searchFiles(root, query, MAX_HITS));
      else setChats(await searchChats(query, null, MAX_HITS));
    } catch (err) {
      setError(String(err));
      setHits(null);
      setChats(null);
    } finally {
      setBusy(false);
    }
  }

  function switchTo(next: Mode) {
    setMode(next);
    setError(null);
    // Re-run rather than clear: the query is the same question asked of the
    // other source, and making it retype is the only other option.
    if (query.trim()) void run(next);
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

  /** A hit in another project is only reachable by going there — the panel
   *  shows one project's conversation at a time, as the agent does. */
  function open(hit: ChatHit) {
    if (hit.root !== root) void useHearthStore.getState().openFolder(hit.root);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2 text-[11px] text-neutral-500">
        <span className="shrink-0 uppercase tracking-wide">Search</span>
        {(["files", "chats"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => switchTo(m)}
            className={`shrink-0 rounded px-1.5 py-0.5 ${
              mode === m ? "bg-neutral-700 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {m}
          </button>
        ))}
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void run()}
          placeholder={mode === "files" ? "Text to find, then Enter" : "Search every conversation, then Enter"}
          spellCheck={false}
          className="min-w-0 flex-1 rounded bg-neutral-800 px-1.5 py-0.5 text-[12px] text-neutral-200 outline-none placeholder:text-neutral-600"
        />
        {results && !busy && (
          <span className="shrink-0 text-neutral-400">
            {results.length}
            {results.length === MAX_HITS ? "+" : ""}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px]">
        {busy ? (
          <p className="p-3 text-[12px] text-neutral-600">Searching…</p>
        ) : error ? (
          <p className="p-3 text-[12px] text-red-400">{error}</p>
        ) : !results ? (
          <p className="p-3 text-[12px] text-neutral-600">
            {mode === "files"
              ? "Literal, case-insensitive, skipping node_modules and the other directories the file tree hides."
              : "Every turn of every conversation, across all your projects — not just this one."}
          </p>
        ) : results.length === 0 ? (
          <p className="p-3 text-[12px] text-neutral-600">No matches.</p>
        ) : mode === "files" ? (
          (results as SearchHit[]).map((hit, i) => (
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
        ) : (
          (results as ChatHit[]).map((hit, i) => (
            <button
              key={`${hit.root}:${i}`}
              onClick={() => open(hit)}
              title={hit.root === root ? "In this project" : `Switch to ${hit.root}`}
              className="flex w-full gap-2 border-b border-neutral-900 px-2 py-1 text-left hover:bg-neutral-800/60"
            >
              <span className="shrink-0 text-neutral-600">{hit.kind}</span>
              <span className="min-w-0 flex-1 truncate text-neutral-200">{hit.text}</span>
              {hit.root !== root && (
                <span className="shrink-0 text-sky-400">{hit.root.split(/[\\/]/).pop()}</span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
