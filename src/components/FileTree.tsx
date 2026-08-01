import { useHearthStore } from "../lib/store";
import type { DirEntryInfo } from "../lib/fs";

function iconFor(entry: DirEntryInfo, expanded: boolean): string {
  if (entry.is_dir) return expanded ? "▾" : "▸";
  return "";
}

function TreeNode({ entry, depth }: { entry: DirEntryInfo; depth: number }) {
  const expandedDirs = useHearthStore((s) => s.expandedDirs);
  const dirChildren = useHearthStore((s) => s.dirChildren);
  const activePath = useHearthStore((s) => s.activePath);
  const toggleDir = useHearthStore((s) => s.toggleDir);
  const openFile = useHearthStore((s) => s.openFile);

  const expanded = entry.is_dir && expandedDirs.has(entry.path);
  const isActive = activePath === entry.path;

  return (
    <div>
      <button
        onClick={() => (entry.is_dir ? toggleDir(entry.path) : openFile(entry.path, entry.name))}
        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[13px] hover:bg-neutral-800 ${
          isActive ? "bg-neutral-800 text-white" : "text-neutral-300"
        }`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        <span className="inline-block w-3 shrink-0 text-neutral-500">{iconFor(entry, expanded)}</span>
        <span className="truncate">{entry.name}</span>
      </button>
      {entry.is_dir && expanded && (
        <div>
          {(dirChildren[entry.path] ?? []).map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree() {
  const projectRoot = useHearthStore((s) => s.projectRoot);
  const dirChildren = useHearthStore((s) => s.dirChildren);

  if (!projectRoot) {
    return <div className="p-3 text-[13px] text-neutral-500">No folder open.</div>;
  }

  const rootChildren = dirChildren[projectRoot] ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1">
      {rootChildren.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} />
      ))}
    </div>
  );
}
