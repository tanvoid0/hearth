import { useEffect, useState } from "react";
import { useHearthStore } from "../lib/store";
import { request, useLsp } from "../lib/lsp";

/**
 * Build plan §4.1's symbol outline, and §4.5's find-all-references — one panel,
 * because they are the same list of places to jump to and differ only in how
 * the list was chosen.
 *
 * References take the panel over when there are some, because a search is
 * something you just asked for; the outline is what's there the rest of the
 * time. Closing the references returns it to the outline rather than to
 * nothing.
 */

interface Row {
  name: string;
  detail: string;
  depth: number;
  path: string;
  line: number;
  column: number;
}

/** tsserver's navtree, flattened. The root node is the file itself, so its
 *  children are the symbols and everything below them is nesting. */
function flatten(node: any, file: string, depth: number): Row[] {
  const span = node.spans?.[0];
  if (!span) return [];
  return [
    { name: node.text, detail: node.kind ?? "", depth, path: file, line: span.start.line, column: span.start.offset },
    ...(node.childItems ?? []).flatMap((child: any) => flatten(child, file, depth + 1)),
  ];
}

export function OutlinePanel({ root }: { root: string }) {
  const activePath = useHearthStore((s) => s.activePath);
  const activeContent = useHearthStore((s) => s.tabs.find((t) => t.path === s.activePath)?.content);
  const references = useLsp((s) => s.references);
  const status = useLsp((s) => s.status);
  const [outline, setOutline] = useState<Row[]>([]);

  // Re-asked as the file is edited: an outline that still lists a function you
  // deleted is worse than none, since clicking it jumps somewhere arbitrary.
  useEffect(() => {
    if (!activePath || status !== "ok" || references) return setOutline([]);
    let alive = true;
    const file = activePath.replace(/\\/g, "/");
    const id = setTimeout(() => {
      void request<any>("navtree", { file }).then((tree) => {
        if (alive) setOutline((tree?.childItems ?? []).flatMap((child: any) => flatten(child, file, 0)));
      });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [activePath, activeContent, status, references]);

  const rows: Row[] = references
    ? references.items.map((r) => ({
        name: r.text || r.path,
        detail: r.isDefinition ? "definition" : "",
        depth: 0,
        path: r.path,
        line: r.line,
        column: r.column,
      }))
    : outline;

  function jump(row: Row) {
    const name = row.path.split(/[\\/]/).pop() ?? row.path;
    void useHearthStore
      .getState()
      .openFile(row.path, name)
      .then(() => useLsp.getState().jumpTo(row.path, row.line, row.column));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2 text-[11px] text-neutral-500">
        <span className="uppercase tracking-wide">{references ? "References" : "Outline"}</span>
        {references?.symbol && <span className="font-mono text-neutral-400">{references.symbol}</span>}
        {rows.length > 0 && <span className="text-neutral-400">{rows.length}</span>}
        {references && (
          <button
            onClick={() => useLsp.getState().clearReferences()}
            title="Back to the outline"
            className="ml-auto rounded px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            ✕
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px]">
        {references?.loading ? (
          <p className="p-3 text-neutral-600">Searching…</p>
        ) : rows.length === 0 ? (
          <p className="p-3 text-neutral-600">
            {references
              ? "No references found."
              : status !== "ok"
                ? "No language server for this project."
                : activePath
                  ? "No symbols in this file."
                  : "Open a file to see its symbols. Shift+F12 in the editor finds references."}
          </p>
        ) : (
          rows.map((row, i) => (
            <button
              key={`${row.path}:${row.line}:${row.column}:${i}`}
              onClick={() => jump(row)}
              className="flex w-full gap-2 border-b border-neutral-900 px-2 py-1 text-left hover:bg-neutral-800/60"
              style={{ paddingLeft: 8 + row.depth * 12 }}
            >
              <span className="min-w-0 flex-1 truncate text-neutral-200">{row.name}</span>
              {row.detail && <span className="shrink-0 text-neutral-600">{row.detail}</span>}
              <span className="shrink-0 text-neutral-500">
                {references ? `${relative(row.path, root)}:${row.line}` : row.line}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function relative(file: string, root: string): string {
  const slashed = file.replace(/\\/g, "/");
  const base = root.replace(/\\/g, "/");
  return slashed.toLowerCase().startsWith(base.toLowerCase() + "/") ? slashed.slice(base.length + 1) : slashed;
}
