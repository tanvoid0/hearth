// Subsequence matching for the command palette, kept import-free (like edit.ts
// and markdown.ts) so `npm test` can exercise it on plain node.
//
// Hand-rolled rather than fuse.js: the whole behaviour anyone wants from
// quick-open is "letters in order, prefer word starts, prefer the filename over
// the directories it sits in", which is the scoring below. A dependency here
// would be more code to ship and less control over that last rule.

export interface Scored<T> {
  item: T;
  score: number;
  /** Indices into the haystack that matched, for highlighting. */
  hits: number[];
}

const BOUNDARY = /[\/\\ _\-.]/;

/**
 * Score `query` against `text`, or null if the letters don't appear in order.
 * Higher is better.
 */
export function score(query: string, text: string): { score: number; hits: number[] } | null {
  if (query === "") return { score: 0, hits: [] };

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const hits: number[] = [];
  let total = 0;
  let at = 0;
  // Where the filename starts. Without this, a path whose every letter happens
  // to sit after a slash collects the boundary bonus on all of them and beats a
  // solid run inside a real filename — `s/e/s/s.ts` outscoring `session.ts`.
  const baseStart = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1;

  for (const ch of q) {
    const found = t.indexOf(ch, at);
    if (found === -1) return null;

    // A run of adjacent matches is what distinguishes "sess" hitting
    // `session.ts` from the same letters scattered across `src/e/s/s.ts`.
    if (found === at && hits.length > 0) total += 8;
    // Matching the first letter of a path segment or word is what makes "st"
    // find `store.ts` rather than the first `s…t…` anywhere.
    if (found === 0 || BOUNDARY.test(text[found - 1])) total += 6;
    else total += 1;
    // People search for the file, not the folders above it.
    if (found >= baseStart) total += 4;
    // Distance penalty, floored so a long path can't score negative.
    total -= Math.min(found - at, 4);

    hits.push(found);
    at = found + 1;
  }

  // A short match is a more specific one: "app" should rank `App.tsx` above
  // `components/ApprovalPanel.tsx`.
  return { score: total - text.length * 0.05, hits };
}

/** Rank `items` by how well `key(item)` matches `query`, dropping non-matches. */
export function rank<T>(query: string, items: T[], key: (item: T) => string, limit = 50): Scored<T>[] {
  const out: Scored<T>[] = [];
  for (const item of items) {
    const hit = score(query, key(item));
    if (hit) out.push({ item, score: hit.score, hits: hit.hits });
  }
  // Stable within equal scores: `sort` is stable in every engine this runs on,
  // so equally-scored items keep the caller's order rather than shuffling as
  // the user types.
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
