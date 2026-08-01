import { useHearthStore } from "../lib/store";
import { useLsp } from "../lib/lsp";
import type { Problem } from "../lib/problems";

/**
 * Build plan §4.7's Problems panel, for the type-checking source. Build errors
 * and browser console errors reach the agent through `get_errors` but have
 * their own panels (the run log, the preview badge); folding all three into one
 * list is worth doing when a second source has something the log doesn't
 * already show better.
 */
export function ProblemsPanel({ root }: { root: string }) {
  const problems = useLsp((s) => s.problems);
  const status = useLsp((s) => s.status);
  const openFile = useHearthStore((s) => s.openFile);

  function show(problem: Problem) {
    const name = problem.file.split(/[\\/]/).pop() ?? problem.file;
    void openFile(problem.file, name).then(() =>
      useLsp.setState({ reveal: { path: problem.file, line: problem.line, column: problem.column } }),
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2 text-[11px] text-neutral-500">
        <span className="uppercase tracking-wide">Problems</span>
        {problems.length > 0 && <span className="text-neutral-400">{problems.length}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px]">
        {status !== "ok" ? (
          // Never silence: an unchecked project and a clean one look identical
          // otherwise, which is the same trap `get_errors` avoids for the agent.
          <p className="p-3 text-[12px] text-neutral-500">
            {status === "unavailable"
              ? "Type checking unavailable — no TypeScript found, or the language server failed to start."
              : "Not type-checked — this project has no tsconfig.json or jsconfig.json."}
          </p>
        ) : problems.length === 0 ? (
          <p className="p-3 text-[12px] text-neutral-600">No problems.</p>
        ) : (
          problems.map((problem, i) => (
            <button
              key={`${problem.file}:${problem.line}:${problem.column}:${problem.code}:${i}`}
              onClick={() => show(problem)}
              className="flex w-full gap-2 border-b border-neutral-900 px-2 py-1 text-left hover:bg-neutral-800/60"
            >
              <span className={problem.severity === "warning" ? "text-amber-400" : "text-red-400"}>
                {problem.severity === "warning" ? "▲" : "✕"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="whitespace-pre-wrap break-words text-neutral-200">{problem.text}</span>
                <span className="ml-2 text-neutral-500">
                  {relative(problem.file, root)}:{problem.line}:{problem.column}
                </span>
              </span>
              <span className="shrink-0 text-neutral-600">TS{problem.code}</span>
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
