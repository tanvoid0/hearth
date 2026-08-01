// Pure path + search/replace logic for the agent's file tools. Deliberately
// import-free so `node --test` can run edit.test.ts against it directly.

export interface Edit {
  search: string;
  replace: string;
}

/**
 * Resolve a model-supplied path against the project root, refusing anything
 * that escapes it. Returns a native-separator absolute path so it compares
 * equal to the paths the Rust side hands back for the file tree and tabs.
 */
export function resolveInProject(root: string, input: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const nroot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  let rel = (input ?? "").replace(/\\/g, "/");

  // Models often reply with an absolute path. Accept it only if it's inside
  // the project, then treat it as relative from there.
  if (/^(\/|[a-zA-Z]:)/.test(rel)) {
    const lower = rel.toLowerCase();
    const lowerRoot = nroot.toLowerCase();
    if (lower === lowerRoot) rel = "";
    else if (lower.startsWith(lowerRoot + "/")) rel = rel.slice(nroot.length + 1);
    else throw new Error(`path escapes project root: ${input}`);
  }

  const parts: string[] = [];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) throw new Error(`path escapes project root: ${input}`);
      parts.pop();
      continue;
    }
    parts.push(seg);
  }

  const joined = [nroot, ...parts].join("/");
  return sep === "\\" ? joined.replace(/\//g, "\\") : joined;
}

/** Windows paths differ in case and separator between sources; compare loosely. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The 1-based lines of `after` that differ from `before`.
 *
 * Trims the common prefix and suffix rather than running a real diff: what this
 * feeds is a decoration saying "the agent touched here", and the honest answer
 * to "which lines" for a decoration is the span that changed. A pure deletion
 * returns nothing, which is right — there's no line left to mark.
 *
 * ponytail: one span, so two edits far apart in a file mark everything between
 * them. Run a real line diff if that ever reads as noise.
 */
export function changedLines(before: string, after: string): number[] {
  const a = before.split("\n");
  const b = after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const lines: number[] = [];
  for (let i = start; i <= endB; i++) lines.push(i + 1);
  return lines;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, " ").replace(/\s+$/gm, "").trim();
}

/**
 * Aider-style search/replace, per build plan §5: exact match, then
 * whitespace-normalised match, then fail loudly — never fuzzy-apply. Ported
 * from p0-spike/src/tools.ts, which is the version the P0 spike validated.
 *
 * All-or-nothing: if any edit misses, the file is left untouched.
 */
export function applyEdits(content: string, edits: Edit[] | Edit): { content: string; failures: string[] } {
  // Models routinely send a bare {search, replace} where the schema asks for a
  // list of them. Throwing on that spends a whole agent step teaching the model
  // something the object's shape already made unambiguous.
  const list = Array.isArray(edits) ? edits : edits ? [edits] : [];
  const failures: string[] = [];
  let next = content;

  for (const [i, edit] of list.entries()) {
    if (next.includes(edit.search)) {
      next = next.replace(edit.search, edit.replace);
      continue;
    }
    const searchNorm = normalizeWhitespace(edit.search);
    const lines = next.split("\n");
    const searchLines = edit.search.split("\n").length;
    let matched = false;
    for (let start = 0; start <= lines.length - searchLines; start++) {
      const chunk = lines.slice(start, start + searchLines).join("\n");
      if (normalizeWhitespace(chunk) === searchNorm) {
        lines.splice(start, searchLines, edit.replace);
        next = lines.join("\n");
        matched = true;
        break;
      }
    }
    if (!matched) {
      failures.push(`edit #${i}: SEARCH block not found (exact or whitespace-normalised):\n${edit.search}`);
    }
  }

  return failures.length > 0 ? { content, failures } : { content: next, failures };
}
