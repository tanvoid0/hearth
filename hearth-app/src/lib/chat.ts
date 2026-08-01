import { create } from "zustand";
import { appendTextFile, readTextFile, writeTextFile } from "./fs";
import { resolveInProject } from "./edit";
import { packHistory } from "./session";
import { decodeEntries, encodeEntry, LOAD_LIMIT, SESSION_REL, TRANSCRIPT_REL } from "./transcript";
import type { ChatMessage } from "./ollama";
import type { FileChange } from "./gitdiff";

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  /** The PLAN step's output. Its own kind so it can be styled as a thing the
   *  agent is about to do rather than a thing it has done. */
  | { kind: "plan"; text: string }
  | { kind: "tool"; label: string; ok: boolean; detail: string }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string }
  /** One agent turn's git commit. Only the sha is stored, not the diff —
   *  the repo holds that, and a transcript trimmed for localStorage would
   *  otherwise be throwing away the review. */
  | { kind: "checkpoint"; sha: string; files: FileChange[] };

/**
 * A turn that started and never finished — the page was reloaded, or the app
 * was killed, while the model was still working.
 *
 * Kept beside `history` rather than in it. `history` is the record of
 * *completed* turns: an abandoned turn must not leak into the next one's
 * context, and a resumed one has to pick up the tool results it already paid
 * for rather than start the same work again.
 */
export interface PendingTurn {
  prompt: string;
  /** Names the model call the dead page left in flight. The id registry lives
   *  in the Rust process, which outlives a page reload — so a resume can abort
   *  the orphan instead of competing with it for the GPU. */
  cancelId: string;
  /** The turn's messages as of its last completed step, tool results included.
   *  Absent when it died before finishing one — there's nothing to resume from
   *  then, and the prompt is re-run from the top. */
  partial?: ChatMessage[];
}

/** `entries` is what the panel renders; `history` is what goes back to the
 *  model. They diverge — tool rows carry a label the model never sees, and the
 *  history carries a system prompt the panel never shows. */
export interface ChatSession {
  entries: Entry[];
  history: ChatMessage[];
  pending?: PendingTurn;
}

const EMPTY: ChatSession = { entries: [], history: [] };

/** What the *model* is sent is bounded by `contextLimits`; this only bounds the
 *  snapshot on disk, which has to hold whatever the next turn starts from. */
const HISTORY_BUDGET = 200_000;

/** Where transcripts used to live. Read once per project, to carry an existing
 *  conversation onto disk rather than appear to have lost it. */
const LEGACY_KEY = "hearth-chats";

const transcriptPath = (root: string) => resolveInProject(root, TRANSCRIPT_REL);
const sessionPath = (root: string) => resolveInProject(root, SESSION_REL);

/**
 * Disk writes, one at a time and in order.
 *
 * Appends are dispatched from a synchronous store action, so without this two
 * entries landing in the same tick would race each other into the same file.
 * A queue rather than an await at the call site: the panel must not wait on a
 * disk write to render the message the user just sent.
 */
let writes: Promise<unknown> = Promise.resolve();
function enqueue(write: () => Promise<unknown>): void {
  // Failures are swallowed on purpose: losing the on-disk copy of a turn is
  // bad, and losing the turn itself because a write failed is worse. The
  // in-memory store stays authoritative for the session either way.
  writes = writes.then(write, write).catch(() => {});
}

interface ChatStore {
  /** Keyed by project root: a conversation's system prompt and tool calls are
   *  bound to one project, so switching projects switches conversations. */
  chats: Record<string, ChatSession>;
  /** Read a project's conversation back off disk. Called when a project opens;
   *  everything else in this store is synchronous. */
  hydrate: (root: string) => Promise<void>;
  addEntry: (root: string, entry: Entry) => void;
  /** Mark a turn as in flight. `partial` carries the messages a resumed turn
   *  starts from, so an interrupted resume is itself resumable. */
  beginTurn: (root: string, prompt: string, cancelId: string, partial?: ChatMessage[]) => void;
  /** Checkpoint the in-flight turn at a point it could restart from. */
  stepTurn: (root: string, partial: ChatMessage[]) => void;
  /** Commit the finished turn's history and forget it was ever in flight. */
  endTurn: (root: string, history: ChatMessage[]) => void;
  /** Give up on an interrupted turn without resuming it. */
  dropPending: (root: string) => void;
  clearChat: (root: string) => void;
}


/**
 * Transcripts live in the project they belong to (`.hearth/chat.jsonl`), not in
 * localStorage.
 *
 * The old store put every project's conversation in one blob and rewrote all of
 * it on every entry, so it had to be trimmed to a quota-shaped budget — a
 * storage number that was silently also a history limit. Per project, appended
 * a line at a time, there's nothing to trim: `LOAD_LIMIT` bounds what the panel
 * reads back, and the file keeps the rest.
 */
export const useChatStore = create<ChatStore>()((set, get) => ({
  chats: {},

  hydrate: async (root) => {
    const blob = await readTextFile(transcriptPath(root)).catch(() => null);
    if (blob === null) {
      // No file yet. Carry a conversation this project had under the old store
      // rather than let a version bump look like lost history.
      const imported = legacyChat(root);
      if (imported) {
        enqueue(() => writeTextFile(transcriptPath(root), imported.entries.map(encodeEntry).join("")));
        enqueue(() => writeSession(root, imported));
      }
      set((s) => ({ chats: { ...s.chats, [root]: imported ?? EMPTY } }));
      return;
    }
    const { entries } = decodeEntries<Entry>(blob, LOAD_LIMIT);
    const session = await readTextFile(sessionPath(root))
      .then((text) => JSON.parse(text) as Pick<ChatSession, "history" | "pending">)
      .catch(() => ({ history: [] as ChatMessage[], pending: undefined }));
    set((s) => ({
      chats: { ...s.chats, [root]: { entries, history: session.history ?? [], pending: session.pending } },
    }));
  },

  addEntry: (root, entry) => {
    enqueue(() => appendTextFile(transcriptPath(root), encodeEntry(entry)));
    set((s) => {
      const cur = s.chats[root] ?? EMPTY;
      return { chats: { ...s.chats, [root]: { ...cur, entries: [...cur.entries, entry] } } };
    });
  },

  beginTurn: (root, prompt, cancelId, partial) => {
    set((s) => ({
      chats: {
        ...s.chats,
        [root]: { ...(s.chats[root] ?? EMPTY), pending: { prompt, cancelId, ...(partial ? { partial } : {}) } },
      },
    }));
    enqueue(() => writeSession(root, get().chats[root]));
  },

  stepTurn: (root, partial) => {
    set((s) => {
      // No pending turn means the chat was cleared out from under the run
      // (New chat, or a project switch that took it) — don't resurrect it.
      const cur = s.chats[root];
      if (!cur?.pending) return s;
      return { chats: { ...s.chats, [root]: { ...cur, pending: { ...cur.pending, partial } } } };
    });
    if (get().chats[root]?.pending) enqueue(() => writeSession(root, get().chats[root]));
  },

  endTurn: (root, history) => {
    set((s) => ({ chats: { ...s.chats, [root]: { ...(s.chats[root] ?? EMPTY), history, pending: undefined } } }));
    enqueue(() => writeSession(root, get().chats[root]));
  },

  dropPending: (root) => {
    set((s) => (s.chats[root] ? { chats: { ...s.chats, [root]: { ...s.chats[root], pending: undefined } } } : s));
    enqueue(() => writeSession(root, get().chats[root]));
  },

  clearChat: (root) => {
    set((s) => ({ chats: { ...s.chats, [root]: EMPTY } }));
    // Truncate rather than delete: New chat means this conversation is over,
    // not that the project never had one, and an empty file says so without a
    // delete command existing anywhere in the app.
    enqueue(() => writeTextFile(transcriptPath(root), ""));
    enqueue(() => writeSession(root, EMPTY));
  },
}));

function writeSession(root: string, chat: ChatSession | undefined): Promise<void> {
  const { history = [], pending } = chat ?? EMPTY;
  return writeTextFile(
    sessionPath(root),
    JSON.stringify({
      history: packHistory(history, HISTORY_BUDGET),
      ...(pending
        ? { pending: pending.partial ? { ...pending, partial: packHistory(pending.partial, HISTORY_BUDGET) } : pending }
        : {}),
    }),
  );
}

/** The pre-file store, read straight from localStorage rather than through a
 *  zustand middleware that no longer exists. Missing or unreadable reads as
 *  "no previous conversation", which is also what it means. */
function legacyChat(root: string): ChatSession | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const chat = JSON.parse(raw)?.state?.chats?.[root] as ChatSession | undefined;
    return chat && chat.entries?.length > 0 ? chat : null;
  } catch {
    return null;
  }
}

export const chatFor = (root: string | null) => (s: ChatStore) => (root ? s.chats[root] : undefined) ?? EMPTY;
