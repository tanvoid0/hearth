// The repo map of build plan §11, kept import-free (like edit.ts, runlog.ts and
// session.ts) so `npm test` exercises it on plain node.

/**
 * Exported names from one source file.
 *
 * A regex rather than the language server, which is the surprising half. The
 * map covers every source file in the project, and asking tsserver would mean
 * opening all of them — a cold project-wide load that takes tens of seconds and
 * holds every file in memory afterwards, to answer a question that doesn't need
 * types at all. The map only has to say what exists and roughly where; the
 * agent reads the file when it needs to be right.
 *
 * ponytail: misses `export * from "./x"` re-exports, which name nothing
 * locally. Resolve them if barrel files ever turn out to be where the agent
 * keeps getting lost.
 */
export function exportedSymbols(source: string): string[] {
  const found: string[] = [];

  // `export function f`, `export default class C`, `export const x`, and the
  // type-only forms — one shape because they only differ by keyword.
  const declared = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of source.matchAll(declared)) found.push(m[1]);

  // `export { a, b as c }` — the alias is the name importers use, so it wins.
  const listed = /^\s*export\s*\{([^}]*)\}/gm;
  for (const m of source.matchAll(listed)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && name !== "default") found.push(name);
    }
  }

  // `export default App;` — a re-export of something declared above, which
  // neither pattern above sees.
  for (const m of source.matchAll(/^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;/gm)) found.push(m[1]);

  return [...new Set(found)];
}

/** Files worth mapping. Anything else has no exports to find. */
export function isSourceFile(path: string): boolean {
  return /\.(?:m|c)?[jt]sx?$/.test(path) && !/\.d\.ts$/.test(path);
}

export interface FileSymbols {
  path: string;
  symbols: string[];
}

/**
 * Render the map the agent reads.
 *
 * Files with no exports are dropped rather than listed empty: `list_files`
 * already says what exists, and this is the answer to a different question —
 * where does a given name live.
 */
export function formatRepoMap(files: FileSymbols[], truncated = false): string {
  const lines = files
    .filter((f) => f.symbols.length > 0)
    .map((f) => `${f.path}: ${f.symbols.join(", ")}`)
    .sort();
  if (lines.length === 0) {
    return "no exported symbols found — this project may not be JavaScript or TypeScript, or its code may be somewhere list_files hasn't reached";
  }
  return [
    "exported symbols by file:",
    ...lines,
    truncated ? "… (more files not scanned — narrow with search instead)" : "",
  ]
    .filter(Boolean)
    .join("\n");
}
