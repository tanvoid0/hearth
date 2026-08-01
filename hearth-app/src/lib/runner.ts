import { invoke, Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { capLog, exitReason, readyUrl, pushEntry, type ConsoleEntry } from "./runlog";

interface RunnerState {
  running: boolean;
  /** Set once the server is serving; null while installing or starting. */
  url: string | null;
  log: string[];
  /** Bumped to force the iframe to remount and refetch. */
  nonce: number;

  /** Runtime errors and warnings forwarded by the preview page's bridge. */
  consoleLog: ConsoleEntry[];
  /** True only while a bridged page is loaded and being listened to. Anything
   *  else — preview closed, server down, project without the bridge — has to
   *  read as "unknown" rather than "clean". */
  consoleAttached: boolean;
  /** `consoleLog.length` at the agent's last write; see `consoleTail`. */
  consoleMark: number;
  attachConsole: () => void;
  detachConsole: () => void;
  pushConsole: (kind: string, text: string) => void;
  markConsole: () => void;

  start: (root: string) => Promise<void>;
  stop: () => Promise<void>;
  reload: () => void;
}

export const useRunner = create<RunnerState>((set, get) => ({
  running: false,
  url: null,
  log: [],
  nonce: 0,
  consoleLog: [],
  consoleAttached: false,
  consoleMark: 0,

  // A fresh document means the old messages describe a page that no longer
  // exists — including after a full reload triggered by an agent edit.
  attachConsole: () => set({ consoleAttached: true, consoleLog: [], consoleMark: 0 }),
  detachConsole: () => set({ consoleAttached: false }),
  pushConsole: (kind, text) => set((s) => ({ consoleLog: pushEntry(s.consoleLog, `${kind}: ${text}`) })),
  markConsole: () => set((s) => ({ consoleMark: s.consoleLog.length })),

  start: async (root) => {
    if (get().running) return;
    set({ running: true, url: null, log: [], consoleLog: [], consoleAttached: false, consoleMark: 0 });

    let port = 0;
    const onEvent = new Channel<string>();
    onEvent.onmessage = (line) => {
      const exit = exitReason(line);
      set((s) => ({
        log: capLog(s.log, exit ?? line),
        url: s.url ?? (port ? readyUrl(line, port) : null),
        running: exit ? false : s.running,
      }));
    };

    try {
      port = await invoke<number>("run_dev", { root, onEvent });
    } catch (err) {
      set((s) => ({ running: false, log: capLog(s.log, String(err)) }));
    }
  },

  stop: async () => {
    await invoke("stop_dev");
    set({ running: false, url: null, consoleAttached: false });
  },

  // The remount reloads the document, so the bridge re-announces itself and
  // clears the buffer on its own.
  reload: () => set((s) => ({ nonce: s.nonce + 1, consoleAttached: false })),
}));
