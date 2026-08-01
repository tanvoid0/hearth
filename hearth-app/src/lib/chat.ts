import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { packHistory, trimForStorage } from "./session";
import type { ChatMessage } from "./ollama";
import type { FileChange } from "./gitdiff";

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; label: string; ok: boolean; detail: string }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string }
  /** One agent turn's git commit. Only the sha is stored, not the diff —
   *  the repo holds that, and a transcript trimmed for localStorage would
   *  otherwise be throwing away the review. */
  | { kind: "checkpoint"; sha: string; files: FileChange[] };

/** `entries` is what the panel renders; `history` is what goes back to the
 *  model. They diverge — tool rows carry a label the model never sees, and the
 *  history carries a system prompt the panel never shows. */
export interface ChatSession {
  entries: Entry[];
  history: ChatMessage[];
}

const EMPTY: ChatSession = { entries: [], history: [] };

// Roughly 0.4MB each as UTF-16 — well inside the webview's per-origin quota
// even with a handful of projects on the go.
const ENTRY_BUDGET = 200_000;
const HISTORY_BUDGET = 200_000;

interface ChatStore {
  /** Keyed by project root: a conversation's system prompt and tool calls are
   *  bound to one project, so switching projects switches conversations. */
  chats: Record<string, ChatSession>;
  addEntry: (root: string, entry: Entry) => void;
  setHistory: (root: string, history: ChatMessage[]) => void;
  clearChat: (root: string) => void;
}

// Separate store (and separate localStorage key) from the editor session on
// purpose: the editor blob is rewritten on every keystroke, and a transcript
// measured in hundreds of KB has no business being re-serialised that often.
export const useChatStore = create<ChatStore>()(
  persist(
    (set) => ({
      chats: {},

      addEntry: (root, entry) =>
        set((s) => {
          const cur = s.chats[root] ?? EMPTY;
          return { chats: { ...s.chats, [root]: { ...cur, entries: [...cur.entries, entry] } } };
        }),

      setHistory: (root, history) =>
        set((s) => ({ chats: { ...s.chats, [root]: { ...(s.chats[root] ?? EMPTY), history } } })),

      clearChat: (root) => set((s) => ({ chats: { ...s.chats, [root]: EMPTY } })),
    }),
    {
      name: "hearth-chats",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        chats: Object.fromEntries(
          Object.entries(s.chats).map(([root, c]) => [
            root,
            { entries: trimForStorage(c.entries, ENTRY_BUDGET), history: packHistory(c.history, HISTORY_BUDGET) },
          ]),
        ),
      }),
    },
  ),
);

export const chatFor = (root: string | null) => (s: ChatStore) => (root ? s.chats[root] : undefined) ?? EMPTY;
