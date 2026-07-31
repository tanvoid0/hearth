import { create } from "zustand";
import { listDir, readTextFile, writeTextFile, type DirEntryInfo } from "./fs";

export interface Tab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
}

interface HearthState {
  projectRoot: string | null;
  dirChildren: Record<string, DirEntryInfo[]>;
  expandedDirs: Set<string>;
  tabs: Tab[];
  activePath: string | null;

  openFolder: (root: string) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  openFile: (path: string, name: string) => Promise<void>;
  setActivePath: (path: string) => void;
  setTabContent: (path: string, content: string) => void;
  saveTab: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
}

export const useHearthStore = create<HearthState>((set, get) => ({
  projectRoot: null,
  dirChildren: {},
  expandedDirs: new Set(),
  tabs: [],
  activePath: null,

  openFolder: async (root: string) => {
    const children = await listDir(root);
    set({
      projectRoot: root,
      dirChildren: { [root]: children },
      expandedDirs: new Set([root]),
      tabs: [],
      activePath: null,
    });
  },

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

  openFile: async (path: string, name: string) => {
    const existing = get().tabs.find((t) => t.path === path);
    if (existing) {
      set({ activePath: path });
      return;
    }
    const content = await readTextFile(path);
    set((state) => ({
      tabs: [...state.tabs, { path, name, content, savedContent: content }],
      activePath: path,
    }));
  },

  setActivePath: (path: string) => set({ activePath: path }),

  setTabContent: (path: string, content: string) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.path === path ? { ...t, content } : t)),
    })),

  saveTab: async (path: string) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return;
    await writeTextFile(path, tab.content);
    set((state) => ({
      tabs: state.tabs.map((t) => (t.path === path ? { ...t, savedContent: t.content } : t)),
    }));
  },

  closeTab: (path: string) => {
    const { tabs, activePath } = get();
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;
    const nextTabs = tabs.filter((t) => t.path !== path);
    let nextActive = activePath;
    if (activePath === path) {
      const fallback = nextTabs[idx - 1] ?? nextTabs[0];
      nextActive = fallback ? fallback.path : null;
    }
    set({ tabs: nextTabs, activePath: nextActive });
  },
}));
