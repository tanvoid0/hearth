import { invoke, Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { readTextFile, writeTextFile } from "./fs";
import { bridgeConfig, BRIDGE_CONFIG_REL } from "./workspace";
import {
  capLog,
  exitReason,
  isPhaseLine,
  isRunning,
  readyUrl,
  reduceStatus,
  pushEntry,
  type ConsoleEntry,
  type RunStatus,
} from "./runlog";

/** The script every scaffold has and almost every project names the same. */
export const DEFAULT_SCRIPT = "dev";

interface RunnerState {
  /** Derived from `status`; kept as a field so components that only care
   *  whether anything is up don't have to know the state machine. */
  running: boolean;
  status: RunStatus;
  /** Which package.json script the last run started. */
  script: string;
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

  start: (root: string, script?: string) => Promise<void>;
  stop: () => Promise<void>;
  reload: () => void;
}

/**
 * The project's runnable scripts, and whether each one is a vite dev server.
 *
 * The second half is what decides whether a run gets a port and a preview:
 * `--port --strictPort` handed to `npm run build` is an error, and a build
 * script parked at "starting" waiting for a URL never resolves.
 */
export async function projectScripts(root: string): Promise<Array<{ name: string; serve: boolean }>> {
  try {
    const pkg = JSON.parse(await readTextFile(`${root}/package.json`));
    return Object.entries(pkg.scripts ?? {}).map(([name, command]) => ({
      name,
      serve: /\bvite\b/.test(String(command)) && !/\bbuild\b|\bpreview\b/.test(String(command)),
    }));
  } catch {
    return []; // no package.json, or malformed — the Run button says so
  }
}

export const useRunner = create<RunnerState>((set, get) => ({
  running: false,
  status: "stopped",
  script: DEFAULT_SCRIPT,
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

  start: async (root, script = get().script) => {
    if (get().running) return;
    const scripts = await projectScripts(root);
    const serve = scripts.find((s) => s.name === script)?.serve ?? script === DEFAULT_SCRIPT;

    set({
      running: true,
      status: "starting",
      script,
      url: null,
      log: [],
      consoleLog: [],
      consoleAttached: false,
      consoleMark: 0,
    });

    // The console bridge for a project Hearth didn't scaffold: a generated vite
    // config that wraps the project's own and injects the snippet. Written per
    // run rather than once, so it can't go stale against the bridge source.
    // Failing to write it costs the console, not the run.
    let config: string | null = null;
    if (serve) {
      config = await writeTextFile(`${root}/${BRIDGE_CONFIG_REL}`, bridgeConfig()).then(
        () => BRIDGE_CONFIG_REL,
        () => null,
      );
    }

    let port = 0;
    const onEvent = new Channel<string>();
    onEvent.onmessage = (line) => {
      set((s) => {
        const status = reduceStatus(s.status, line, port);
        return {
          status,
          running: isRunning(status),
          // Phase markers drive the machine and say nothing worth reading.
          log: isPhaseLine(line) ? s.log : capLog(s.log, exitReason(line) ?? line),
          url: s.url ?? (port ? readyUrl(line, port) : null),
        };
      });
    };

    try {
      port = await invoke<number>("run_dev", { root, script, serve, config, onEvent });
    } catch (err) {
      set((s) => ({ running: false, status: "crashed", log: capLog(s.log, String(err)) }));
    }
  },

  stop: async () => {
    await invoke("stop_dev");
    set({ running: false, status: "stopped", url: null, consoleAttached: false });
  },

  // The remount reloads the document, so the bridge re-announces itself and
  // clears the buffer on its own.
  reload: () => set((s) => ({ nonce: s.nonce + 1, consoleAttached: false })),
}));
