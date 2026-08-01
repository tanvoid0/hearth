import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { listDir, readTextFile, writeTextFile, type DirEntryInfo } from "./fs";
import { samePath } from "./edit";
import { createProject, defaultWorkspaceDir } from "./projects";
import type { TemplateKind } from "./workspace";
import { packTab, rebaseTab, type Tab } from "./session";
import { useRunner } from "./runner";
import { useLsp } from "./lsp";
import { useChatStore } from "./chat";

export type { Tab };

/** A checkpoint's before/after for one file, shown in place of the editor.
 *  Not persisted: it's a view of a past commit, not session state. */
export interface DiffView {
  path: string;
  label: string;
  original: string;
  modified: string;
  /** The checkpoint this diff came from — what the per-hunk revert needs to ask
   *  git for the hunks. Null for a diff that isn't one commit's change (the
   *  working file against the last checkpoint), where there are no hunks of a
   *  commit to reject. */
  sha: string | null;
}

interface HearthState {
  projectRoot: string | null;
  dirChildren: Record<string, DirEntryInfo[]>;
  expandedDirs: Set<string>;
  tabs: Tab[];
  activePath: string | null;
  /** Where new projects get created. Null until first resolved from $HOME. */
  workspaceDir: string | null;
  /** Set by newProject, consumed once by the chat panel — the prompt that
   *  created the project is also its first agent turn. */
  pendingPrompt: string | null;
  /** The agent panel's input box. In the store rather than in the component so
   *  the preview's element picker has somewhere to put what you clicked. */
  composer: string;
  /** Takes over the editor pane while a checkpoint file is under review. */
  diff: DiffView | null;
  /** The file pinned in a second editor beside the main one, or null for no
   *  split. One extra path rather than a second tab bar: the split exists to
   *  keep one file in view while you move around in the other, and a pane with
   *  its own tabs is a second editor to keep in step rather than a view. */
  splitPath: string | null;
  /** Lines the agent last wrote, by file, for the editor decoration. A change
   *  you didn't type is otherwise invisible until you go looking for it. Not
   *  persisted: it describes what just happened, not the session. */
  agentLines: Record<string, number[]>;

  openFolder: (root: string) => Promise<void>;
  newProject: (prompt: string, kind?: TemplateKind) => Promise<void>;
  closeProject: () => void;
  setWorkspaceDir: (dir: string) => void;
  takePendingPrompt: () => string | null;
  setComposer: (text: string) => void;
  /** Add to whatever is already typed rather than replacing it: picking an
   *  element is usually the *subject* of a sentence you have already started. */
  appendComposer: (text: string) => void;
  toggleDir: (path: string) => Promise<void>;
  openFile: (path: string, name: string) => Promise<void>;
  setActivePath: (path: string) => void;
  setTabContent: (path: string, content: string) => void;
  saveTab: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  syncFromDisk: (path: string) => Promise<void>;
  rehydrateFromDisk: () => Promise<void>;
  openDiff: (diff: DiffView) => void;
  closeDiff: () => void;
  setSplit: (path: string | null) => void;
  markAgentWrite: (path: string, lines: number[]) => void;
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

export const useHearthStore = create<HearthState>()(persist((set, get) => ({
  projectRoot: null,
  dirChildren: {},
  expandedDirs: new Set(),
  tabs: [],
  activePath: null,
  workspaceDir: null,
  pendingPrompt: null,
  composer: "",
  diff: null,
  splitPath: null,
  agentLines: {},

  // Every way in and out of a project routes through openFolder/closeProject,
  // so stopping the dev server here covers all of them — a server left running
  // against the previous project would keep serving it under the new one's name.
  openFolder: async (root: string) => {
    await useRunner.getState().stop();
    // Transcripts live in the project now, so switching projects has to read
    // one rather than look up a key. Before the tree loads: the panel renders
    // as soon as `projectRoot` is set, and an empty chat that fills in a beat
    // later reads as a conversation that was lost.
    await useChatStore.getState().hydrate(root).catch(console.error);
    // Returns as soon as the process is spawned — tsserver then spends a second
    // or two loading the compiler, which nothing here has to wait for.
    await useLsp.getState().start(root).catch(console.error);
    const children = await listDir(root);
    set({
      projectRoot: root,
      dirChildren: { [root]: children },
      expandedDirs: new Set([root]),
      tabs: [],
      activePath: null,
      diff: null,
      splitPath: null,
      agentLines: {},
    });
  },

  newProject: async (prompt: string, kind: TemplateKind = "react") => {
    const workspaceDir = get().workspaceDir ?? (await defaultWorkspaceDir());
    const root = await createProject(workspaceDir, prompt, kind);
    set({ workspaceDir });
    await get().openFolder(root);
    set({ pendingPrompt: prompt });
  },

  closeProject: () => {
    void useRunner.getState().stop();
    void useLsp.getState().stop();
    set({
      projectRoot: null,
      dirChildren: {},
      expandedDirs: new Set(),
      tabs: [],
      activePath: null,
      diff: null,
      splitPath: null,
      agentLines: {},
    });
  },

  setWorkspaceDir: (dir: string) => set({ workspaceDir: dir }),

  takePendingPrompt: () => {
    const prompt = get().pendingPrompt;
    if (prompt) set({ pendingPrompt: null });
    return prompt;
  },

  setComposer: (text: string) => set({ composer: text }),

  appendComposer: (text: string) =>
    set((state) => ({ composer: state.composer ? `${state.composer.replace(/\s+$/, "")} ${text}` : text })),

  toggleDir: async (path: string) => {
    const { expandedDirs, dirChildren } = get();
    const next = new Set(expandedDirs);
    if (next.has(path)) {
      next.delete(path);
      set({ expandedDirs: next });
      return;
    }
    next.add(path);
    if (!dirChildren[path]) {
      const children = await listDir(path);
      set({ expandedDirs: next, dirChildren: { ...dirChildren, [path]: children } });
    } else {
      set({ expandedDirs: next });
    }
  },

  // Asking for a file is asking to leave the diff — otherwise the click looks
  // like it did nothing, since the diff owns the pane the file would open in.
  openFile: async (path: string, name: string) => {
    const existing = get().tabs.find((t) => t.path === path);
    if (existing) {
      set({ activePath: path, diff: null });
      return;
    }
    const content = await readTextFile(path);
    useLsp.getState().touch(path, content);
    set((state) => ({
      tabs: [...state.tabs, { path, name, content, savedContent: content }],
      activePath: path,
      diff: null,
    }));
  },

  setActivePath: (path: string) => set({ activePath: path, diff: null }),

  // tsserver checks the buffer, not the file: type errors show up as they're
  // typed, before a save, which is the whole reason it holds open files in
  // memory. `touch` debounces the re-check.
  setTabContent: (path: string, content: string) => {
    useLsp.getState().touch(path, content);
    set((state) => ({
      tabs: state.tabs.map((t) => (t.path === path ? { ...t, content } : t)),
      // Typing in the file is the acknowledgement: the highlight has done its
      // job the moment you're working in there, and leaving it up turns it into
      // background colour nobody reads.
      agentLines: state.agentLines[path] ? omit(state.agentLines, path) : state.agentLines,
    }));
  },

  markAgentWrite: (path: string, lines: number[]) =>
    set((state) => ({ agentLines: { ...state.agentLines, [path]: lines } })),

  saveTab: async (path: string) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab || tab.content === tab.savedContent) return;
    await writeTextFile(path, tab.content);
    set((state) => ({
      tabs: state.tabs.map((t) => (t.path === path ? { ...t, savedContent: t.content } : t)),
    }));
  },

  // Called after the agent writes a file: pull the new content into any open
  // tab and refresh the tree so a created file shows up without reopening the
  // folder. The agent refuses to write over a dirty tab, so overwriting the
  // tab's content here can't lose user edits.
  syncFromDisk: async (path: string) => {
    const { tabs, dirChildren } = get();
    if (tabs.some((t) => samePath(t.path, path))) {
      const content = await readTextFile(path);
      set((state) => ({
        tabs: state.tabs.map((t) => (samePath(t.path, path) ? { ...t, content, savedContent: content } : t)),
      }));
    }
    const parent = path.replace(/[\\/][^\\/]+$/, "");
    const knownParent = Object.keys(dirChildren).find((d) => samePath(d, parent));
    if (knownParent) {
      const children = await listDir(knownParent);
      set((state) => ({ dirChildren: { ...state.dirChildren, [knownParent]: children } }));
    }
  },

  closeTab: (path: string) => {
    const { tabs, activePath } = get();
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;
    useLsp.getState().close(path);
    const nextTabs = tabs.filter((t) => t.path !== path);
    let nextActive = activePath;
    if (activePath === path) {
      const fallback = nextTabs[idx - 1] ?? nextTabs[0];
      nextActive = fallback ? fallback.path : null;
    }
    // A split pinned to the file just closed would show a tab that no longer
    // exists; closing it is what the user did.
    set({ tabs: nextTabs, activePath: nextActive, ...(get().splitPath === path ? { splitPath: null } : {}) });
  },

  // Runs once after the persisted session is read back. localStorage only holds
  // *which* dirs/files were open (plus unsaved drafts) — disk is the source of
  // truth for content, so re-read it here and drop anything that vanished
  // between sessions.
  rehydrateFromDisk: async () => {
    const { projectRoot, expandedDirs, tabs, activePath } = get();
    if (!projectRoot) return;

    const dirChildren: Record<string, DirEntryInfo[]> = {};
    const liveDirs = new Set<string>();
    await Promise.all(
      [...new Set([projectRoot, ...expandedDirs])].map(async (dir) => {
        try {
          dirChildren[dir] = await listDir(dir);
          liveDirs.add(dir);
        } catch {
          // dir deleted or renamed since last session — forget it
        }
      }),
    );

    // Project deleted or moved since last session — fall back to the home
    // screen rather than an empty tree with no way to tell why.
    if (!liveDirs.has(projectRoot)) {
      set({ projectRoot: null, dirChildren: {}, expandedDirs: new Set(), tabs: [], activePath: null });
      return;
    }

    const restored = await Promise.all(
      tabs.map(async (tab) => {
        try {
          return rebaseTab(tab, await readTextFile(tab.path));
        } catch {
          return null; // file gone since last session
        }
      }),
    );
    const liveTabs = restored.filter((t): t is Tab => t !== null);

    // Reopening the app lands here instead of in `openFolder`, so without this
    // a restored session would have no language server at all — no squiggles,
    // no hover, and an agent told there are no type errors. The transcript is
    // read here for the same reason: it lives in the project now, and a restart
    // that skipped this would show an empty chat for a project that has one.
    // Chat first, and neither allowed to take the other down with it: a
    // tsserver that won't spawn used to mean an empty chat for a project that
    // has one, and the throw went nowhere anyone would see it.
    await useChatStore.getState().hydrate(projectRoot).catch(console.error);
    await useLsp.getState().start(projectRoot).catch(console.error);
    for (const tab of liveTabs) useLsp.getState().touch(tab.path, tab.content);

    set({
      dirChildren,
      expandedDirs: liveDirs,
      tabs: liveTabs,
      activePath: liveTabs.some((t) => t.path === activePath) ? activePath : (liveTabs[0]?.path ?? null),
    });
  },

  openDiff: (diff: DiffView) => set({ diff }),
  closeDiff: () => set({ diff: null }),

  setSplit: (path) => set({ splitPath: path }),
}), {
  name: "hearth-session",
  // ponytail: writes on every keystroke (setTabContent). Fine for normal
  // files; debounce the write if a large dirty buffer ever hitches typing.
  storage: createJSONStorage(() => localStorage, {
    replacer: (_k, v) => (v instanceof Set ? { __set: [...v] } : v),
    reviver: (_k, v: any) => (v && typeof v === "object" && Array.isArray(v.__set) ? new Set<string>(v.__set) : v),
  }),
  partialize: (s) => ({
    projectRoot: s.projectRoot,
    workspaceDir: s.workspaceDir,
    expandedDirs: s.expandedDirs,
    activePath: s.activePath,
    tabs: s.tabs.map(packTab),
  }),
  onRehydrateStorage: () => (state) => void state?.rehydrateFromDisk(),
}));
