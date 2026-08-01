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
 * How far below the budget a re-cut window lands. The cost of freezing the
 * prefix is sending less than the window holds for a few iterations after each
 * cut; lower means fewer cuts and more wasted window.
 *
 * Measured over a 48-append turn at `num_ctx` 8192 — eight rounds of
 * read/edit/check, reads at the cap:
 *
 * | refill | prefix changes in 48 appends |
 * |---|---|
 * | sliding (no hysteresis) | 48 |
 * | 0.5 | 4 |
 * | 0.6 – 0.9 | 7 |
 *
 * So the band is flat and almost anything beats sliding. What sets the floor
 * isn't this number: one file read is capped at half the window
 * (`contextLimits`), so two of them can't share a window whatever the refill —
 * 0.5 wins its extra three cuts by holding back half the context, which is the
 * more expensive half of the trade. 0.7 sits on the plateau and keeps more.
 */
const REFILL = 0.7;

/**
 * The slice of the conversation to send, with a prefix that holds still.
 *
 * `packHistory` answers a storage question and is anchored at the *newest*
 * message, so every append moves where it starts. Sent to a model that is what
 * build plan §5 spends a section forbidding: Ollama reuses its KV cache only
 * for a byte-identical prefix, so a window that slides by one message per
 * iteration is recomputed from scratch on every call of a turn — and a turn is
 * where the iterations are. §9 lists a stable prefix as the first thing to
 * reach for when turns are slow.
 *
 * Two file reads exhaust the budget at `num_ctx` 8192, so this is the normal
 * path, not the long tail.
 *
 * The fix is hysteresis: `start` only ever moves forward, and only when the
 * window no longer fits — then it cuts back to `REFILL` of the budget so the
 * next several appends land inside a window that hasn't moved. The caller keeps
 * the returned `start` and hands it back.
 *
 * The system prompt survives and the window never opens on an orphaned tool
 * result, exactly as `packHistory` guarantees — a model handed a tool result
 * whose call was trimmed away is being shown an answer to a question it can't
 * see.
 */
export function sendWindow<T extends { role: string }>(
  messages: T[],
  budgetChars: number,
  prevStart = 0
): { messages: T[]; start: number } {
  const floor = messages[0]?.role === "system" ? 1 : 0;
  const system = messages.slice(0, floor);
  let start = Math.max(prevStart, floor);
  if (jsonSize(messages.slice(start)) > budgetChars) {
    const kept = trimForStorage(messages.slice(floor), Math.floor(budgetChars * REFILL));
    // Forward-only even if the re-cut lands earlier, which `trimForStorage`'s
    // keep-one-oversized rule can do: going back would re-expand the prefix and
    // cost the cache the cut was paying for.
    start = Math.max(start, messages.length - kept.length);
  }
  while (start < messages.length && messages[start].role === "tool") start++;
  return { messages: [...system, ...messages.slice(start)], start };
}

/** Matches what `trimForStorage` counts, so the two agree on "over budget". */
function jsonSize(items: unknown[]): number {
  return items.reduce<number>((n, item) => n + JSON.stringify(item).length, 0);
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

/**
 * Is another repair round worth a model call?
 *
 * `stalled`'s rule, applied to `finish`. The first bounce is the prod P10
 * exists for. A second one can only mean something if the model changed
 * something on disk in between — the verdict is read back off the project, so
 * without a write the second answer is provably the first one. Re-sending it
 * buys nothing and costs a full call, which on a model that spilled to CPU is
 * minutes.
 *
 * Measured in the loop spike: 15 of 21 repair rounds got no edit at all before
 * the next `finish`. gemma4's usual answer to a bounce is to re-assert that it
 * has finished.
 */
export function worthRepairing(rounds: number, max: number, wroteSinceLast: boolean): boolean {
  return rounds < max && (rounds === 0 || wroteSinceLast);
}

/**
 * Did the current turn already change something on disk?
 *
 * Asked of a resumed turn, whose writes happened in a process that no longer
 * exists — `runAgent` tracks this in a local for a turn it ran itself, and has
 * to recover it from the messages for one it inherited. It decides whether an
 * unfinished turn is verified or just ended, so getting it wrong either passes
 * a broken edit off as success or spends a project-wide type check on a
 * conversational reply.
 *
 * From the last user message on: the list a resume starts from carries every
 * earlier turn's writes too. With the PLAN step that message is the plan's
 * acknowledgement rather than the prompt, which is still inside this turn and
 * still ahead of every tool call in it.
 */
export function wroteThisTurn(messages: Array<{ role: string; tool_name?: string }>): boolean {
  const start = messages.map((m) => m.role).lastIndexOf("user");
  return messages
    .slice(start)
    .some((m) => m.role === "tool" && (m.tool_name === "edit_file" || m.tool_name === "write_file"));
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
