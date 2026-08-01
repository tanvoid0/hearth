// Session persistence rules, kept import-free (like edit.ts) so `npm test`
// can exercise them on plain node.
//
// Only *which* files were open needs storing — disk stays the source of truth
// for content. The exception is an unsaved draft: that exists nowhere else, so
// it's kept along with the baseline it was edited from, which is what lets
// dirtiness survive a reload even for a draft edited down to empty.

export interface Tab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
}

export function packTab(t: Tab): Tab {
  return t.content === t.savedContent ? { ...t, content: "", savedContent: "" } : t;
}

export function rebaseTab(t: Tab, disk: string): Tab {
  return t.content === t.savedContent
    ? { ...t, content: disk, savedContent: disk }
    : { ...t, savedContent: disk }; // keep the draft, rebase the dirty marker
}

/**
 * Keep the newest items that fit in `budgetChars` of JSON. Chat transcripts
 * carry whole file reads (40k chars a piece), so an unbounded conversation
 * would eventually blow localStorage's per-origin quota and lose *everything*
 * persisted, not just the excess. One oversized item is kept regardless —
 * persisting a truncated conversation beats persisting none.
 */
export function trimForStorage<T>(items: T[], budgetChars: number): T[] {
  const kept: T[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    used += JSON.stringify(items[i]).length;
    if (used > budgetChars && kept.length > 0) break;
    kept.unshift(items[i]);
  }
  return kept;
}

/**
 * Same, for the message list fed back to the model — which has two constraints
 * a plain trim would break: the system prompt names the project root and must
 * survive, and a restored history can't open on a tool result whose assistant
 * tool-call got trimmed away.
 */
export function packHistory<T extends { role: string }>(messages: T[], budgetChars: number): T[] {
  const system = messages[0]?.role === "system" ? messages.slice(0, 1) : [];
  const kept = trimForStorage(messages.slice(system.length), budgetChars);
  while (kept.length > 0 && kept[0].role === "tool") kept.shift();
  return [...system, ...kept];
}

/**
 * Has the agent stopped getting anywhere?
 *
 * `signatures` are one entry per tool call, each combining the call *and* what
 * it returned. Repetition alone isn't the signal — checking errors four times
 * across four edits is exactly the loop this app wants — so what counts is the
 * same call returning the same answer, which means nothing changed between
 * them. Build plan §10 asks for loop detection alongside the repair cap; the
 * cap bounds a productive loop, this catches an unproductive one, and without
 * it a model that can't fix an error burns every remaining iteration retrying
 * the edit that already failed.
 */
export function stalled(signatures: string[], limit = 3): boolean {
  const last = signatures[signatures.length - 1];
  if (last === undefined) return false;
  return signatures.filter((s) => s === last).length >= limit;
}

// ponytail: chars-per-token estimate, not a tokeniser. 3 is below the usual ~4
// for code so the guess errs toward underfilling the window, and it has to
// leave room for the tool definitions and the reply, neither of which is in
// `messages`. If a turn still gets truncated by Ollama, count tokens properly
// rather than raising this.
const CHARS_PER_TOKEN = 3;

/** Ceiling on one file read however big the window is. */
const MAX_READ_CHARS = 40_000;

/**
 * What fits in a context window: how much conversation to send, and how much
 * of any one file. Ollama handles overflow by dropping from the front, which
 * takes the system prompt with it — so the agent stops following its own
 * instructions partway through a session, silently. Staying under the line is
 * the caller's job.
 */
export function contextLimits(numCtx: number): { history: number; read: number } {
  const history = numCtx * CHARS_PER_TOKEN;
  // Half the window for a single file, so a read still leaves room for the
  // system prompt and the turn that asked for it. At a small `num_ctx` this is
  // what stops one big file from being the entire conversation.
  return { history, read: Math.min(MAX_READ_CHARS, Math.floor(history / 2)) };
}
