import { create } from "zustand";
import { readTextFile } from "./fs";
import { resolveInProject } from "./edit";
import { packHistory } from "./session";
import { db } from "./db";
import {
  DELETE_ENTRIES,
  INSERT_ENTRY,
  SELECT_ENTRIES,
  SEARCH_ENTRIES,
  SEARCH_ENTRIES_IN_PROJECT,
  SELECT_SESSION,
  UPSERT_SESSION,
  likePattern,
  searchText,
} from "./chatsql";
import { decodeEntries, LOAD_LIMIT, SESSION_REL, TRANSCRIPT_REL } from "./transcript";
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

/** The two stores this one replaces, read once per project so an existing
 *  conversation carries forward rather than appearing to have been lost. */
const LEGACY_KEY = "hearth-chats";
const transcriptPath = (root: string) => resolveInProject(root, TRANSCRIPT_REL);
const jsonlSessionPath = (root: string) => resolveInProject(root, SESSION_REL);

/**
 * Writes, one at a time and in order.
 *
 * They're dispatched from a synchronous store action, so without this two
 * entries landing in the same tick would race. A queue rather than an await at
 * the call site: the panel must not wait on a write to render the message the
 * user just sent.
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
 * Conversations live in SQLite, one row per entry.
 *
 * The store this replaces held every project's conversation in one localStorage
 * blob and rewrote all of it on every entry, so it had to be trimmed to a
 * quota-shaped budget — a storage number that was silently also a history
 * limit. A row at a time there is nothing to trim: `LOAD_LIMIT` bounds what the
 * panel reads back and the table keeps the rest.
 *
 * One database rather than a file per project, which is what a database is for:
 * `searchChats` can answer "where did I solve this before" across every project
 * at once, and a file per project can't.
 */
export const useChatStore = create<ChatStore>()((set, get) => ({
  chats: {},

  hydrate: async (root) => {
    const conn = await db();
    const rows = (await conn.select(SELECT_ENTRIES, [root, LOAD_LIMIT])) as Array<{ json: string }>;
    if (rows.length === 0) {
      // Nothing stored for this project. Carry forward a conversation held by
      // either store this one replaces, so an upgrade doesn't read as lost
      // history — then it's rows like everything else.
      const imported = (await jsonlChat(root)) ?? legacyChat(root);
      if (imported) {
        for (const entry of imported.entries) enqueue(() => insert(root, entry));
        enqueue(() => writeSession(root, imported));
      }
      set((s) => ({ chats: { ...s.chats, [root]: imported ?? EMPTY } }));
      return;
    }
    // Newest-first out of SQL so the limit takes the newest; the panel reads
    // top to bottom.
    const entries = rows.map((r) => JSON.parse(r.json) as Entry).reverse();
    const session = await loadSession(root);
    set((s) => ({ chats: { ...s.chats, [root]: { entries, ...session } } }));
  },

  addEntry: (root, entry) => {
    enqueue(() => insert(root, entry));
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
    // This project's rows only — the table holds every project, and New chat
    // means this conversation is over, not everyone's.
    enqueue(async () => (await db()).execute(DELETE_ENTRIES, [root]));
    enqueue(() => writeSession(root, EMPTY));
  },
}));

/**
 * Search every conversation, or one project's.
 *
 * The reason this store is a database. Matching is on the text lifted out of
 * each entry at insert time rather than on its JSON — see `searchText`.
 */
export interface ChatHit {
  root: string;
  kind: string;
  text: string;
}

export async function searchChats(query: string, root: string | null, limit = 100): Promise<ChatHit[]> {
  const conn = await db();
  const pattern = likePattern(query);
  return root
    ? conn.select<ChatHit[]>(SEARCH_ENTRIES_IN_PROJECT, [root, pattern, limit])
    : conn.select<ChatHit[]>(SEARCH_ENTRIES, [pattern, limit]);
}

async function insert(root: string, entry: Entry): Promise<void> {
  const conn = await db();
  const record = entry as unknown as Record<string, unknown>;
  await conn.execute(INSERT_ENTRY, [root, entry.kind, searchText(record), JSON.stringify(entry)]);
}

async function loadSession(root: string): Promise<Pick<ChatSession, "history" | "pending">> {
  const conn = await db();
  const rows = (await conn.select(SELECT_SESSION, [root])) as Array<{ json: string }>;
  try {
    const stored = JSON.parse(rows[0]?.json ?? "{}") as Pick<ChatSession, "history" | "pending">;
    return { history: stored.history ?? [], pending: stored.pending };
  } catch {
    return { history: [] };
  }
}

async function writeSession(root: string, chat: ChatSession | undefined): Promise<void> {
  const { history = [], pending } = chat ?? EMPTY;
  const conn = await db();
  await conn.execute(UPSERT_SESSION, [
    root,
    JSON.stringify({
      history: packHistory(history, HISTORY_BUDGET),
      ...(pending
        ? { pending: pending.partial ? { ...pending, partial: packHistory(pending.partial, HISTORY_BUDGET) } : pending }
        : {}),
    }),
  ]);
}

/** The per-project JSONL this store replaced. Left on disk rather than deleted:
 *  removing a user's only copy of a conversation to tidy up is not a trade
 *  worth making, and an import that ran once will find no rows to re-add. */
async function jsonlChat(root: string): Promise<ChatSession | null> {
  const blob = await readTextFile(transcriptPath(root)).catch(() => null);
  if (blob === null) return null;
  const { entries } = decodeEntries<Entry>(blob, LOAD_LIMIT);
  if (entries.length === 0) return null;
  // The history too, not just the transcript: without it the first turn after
  // an upgrade would be sent a conversation the model has never seen.
  const session = await readTextFile(jsonlSessionPath(root))
    .then((text) => JSON.parse(text) as Pick<ChatSession, "history" | "pending">)
    .catch((): Pick<ChatSession, "history" | "pending"> => ({ history: [] }));
  return { entries, history: session.history ?? [], pending: session.pending };
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
