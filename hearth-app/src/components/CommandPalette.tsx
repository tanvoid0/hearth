import { useEffect, useMemo, useRef, useState } from "react";
import { listDir } from "../lib/fs";
import { rank } from "../lib/fuzzy";
import { useHearthStore } from "../lib/store";

export interface PaletteCommand {
  label: string;
  run: () => void;
}

/** Mirrors the file tree's skip list — walking node_modules would take longer
 *  than the palette is open for. */
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", ".hearth"]);
/** Enough for any hand-written project; a repo past this is one where quick-open
 *  wants a real index, not a walk. */
const MAX_FILES = 5000;

async function walkFiles(root: string): Promise<{ path: string; rel: string }[]> {
  const out: { path: string; rel: string }[] = [];
  const queue = [root];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await listDir(dir);
    } catch {
      continue; // an unreadable directory shouldn't abort the whole walk
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.is_dir) queue.push(entry.path);
      else out.push({ path: entry.path, rel: entry.path.slice(root.length + 1).replace(/\\/g, "/") });
    }
  }
  return out;
}

function Highlighted({ text, hits }: { text: string; hits: number[] }) {
  const set = new Set(hits);
  return (
    <>
      {[...text].map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="text-amber-400">
            {ch}
          </span>
        ) : (
          ch
        ),
      )}
    </>
  );
}

/**
 * Ctrl+P opens files, Ctrl+Shift+P runs commands — one component because
 * they're the same list with a different source, which is also why `>` switches
 * between them the way every editor does.
 */
export function CommandPalette({ commands }: { commands: PaletteCommand[] }) {
  const projectRoot = useHearthStore((s) => s.projectRoot);
  const openFile = useHearthStore((s) => s.openFile);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [files, setFiles] = useState<{ path: string; rel: string }[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "p") return;
      e.preventDefault();
      setQuery(e.shiftKey ? ">" : "");
      setCursor(0);
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Walked when the palette opens rather than on project load: it's the only
  // thing that needs a flat list, and a stale one is worse than a 200ms wait.
  useEffect(() => {
    if (!open || !projectRoot) return;
    let alive = true;
    void walkFiles(projectRoot).then((found) => alive && setFiles(found));
    return () => void (alive = false);
  }, [open, projectRoot]);

  const commandMode = query.startsWith(">");
  const results = useMemo(() => {
    if (commandMode) {
      return rank(query.slice(1).trim(), commands, (c) => c.label).map((r) => ({
        key: r.item.label,
        label: r.item.label,
        hits: r.hits,
        run: r.item.run,
      }));
    }
    return rank(query, files, (f) => f.rel).map((r) => ({
      key: r.item.path,
      label: r.item.rel,
      hits: r.hits,
      run: () => void openFile(r.item.path, r.item.rel.split("/").pop() ?? r.item.rel),
    }));
  }, [query, files, commands, commandMode, openFile]);

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  function choose(index: number) {
    results[index]?.run();
    setOpen(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="h-fit w-[560px] max-w-[90vw] overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") return setOpen(false);
            if (e.key === "Enter") return choose(cursor);
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            // Wrap, so holding one arrow reaches everything.
            const step = e.key === "ArrowDown" ? 1 : -1;
            setCursor((c) => (results.length === 0 ? 0 : (c + step + results.length) % results.length));
          }}
          placeholder="Search files, or > for commands"
          className="w-full bg-transparent px-3 py-2.5 text-[13px] text-neutral-100 outline-none placeholder:text-neutral-600"
        />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto border-t border-neutral-800">
          {results.length === 0 && (
            <p className="px-3 py-2 text-[12px] text-neutral-600">
              {commandMode || files.length > 0 ? "No matches" : "Indexing…"}
            </p>
          )}
          {results.map((r, i) => (
            <button
              key={r.key}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(i)}
              className={`block w-full truncate px-3 py-1.5 text-left font-mono text-[12px] ${
                i === cursor ? "bg-neutral-700 text-neutral-100" : "text-neutral-400"
              }`}
            >
              <Highlighted text={r.label} hits={r.hits} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
