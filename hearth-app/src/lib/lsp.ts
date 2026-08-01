import { invoke, Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  allProblems,
  applyDiagEvent,
  forgetFile,
  fullReplaceRange,
  type CheckStatus,
  type Diags,
  type Problem,
} from "./problems";

/**
 * The tsserver client (build plan §4.5).
 *
 * Talks the tsserver protocol directly rather than LSP through
 * `typescript-language-server`: that wrapper wraps this, `typescript` is
 * already a dependency here, and Monaco doesn't speak LSP either — so the
 * wire format has to be translated to Monaco's shapes whichever end we start
 * from. See `tsserver_script` in lib.rs for the version-resolution rules.
 *
 * Rust owns the framing (`Content-Length` in, newline-delimited JSON out) and
 * hands over raw message bodies; the protocol lives here.
 *
 * Deliberately free of any Monaco import — that lives in `monaco-ts.ts`, which
 * subscribes to this store. Not tidiness: `agent.ts` reaches this module for
 * `get_errors`, and the P10 probe imports `agent.ts` on plain node, where
 * loading Monaco dies on `window is not defined`.
 */

/** tsserver answers with forward slashes whatever it's given, so everything
 *  going out is converted first — otherwise the paths in its events don't match
 *  the paths we sent and every lookup misses. */
function tsPath(path: string): string {
  return path.replace(/\\/g, "/");
}

let seq = 0;
const pending = new Map<number, (response: any) => void>();
const completed = new Map<number, () => void>();
/** What tsserver believes each open file contains. `change` is a range edit, so
 *  the range has to describe this, not what the editor now shows. */
const sentContent = new Map<string, string>();

function nextSeq(): number {
  seq += 1;
  return seq;
}

function post(command: string, args: unknown, id = nextSeq()): number {
  void invoke("ts_send", { body: JSON.stringify({ seq: id, type: "request", command, arguments: args }) }).catch(
    () => {
      // The server is gone; the pending waiters below time out on their own.
    },
  );
  return id;
}

export function request<T = any>(command: string, args: unknown, timeoutMs = 5000): Promise<T | null> {
  const id = nextSeq();
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeoutMs);
    pending.set(id, (response) => {
      clearTimeout(timer);
      resolve(response?.success === false ? null : (response?.body ?? null));
    });
    post(command, args, id);
  });
}

/** `geterr` and `geterrForProject` answer with events, not a response — the
 *  only "done" signal is a `requestCompleted` naming the sequence number. */
function requestErrors(command: string, args: unknown, timeoutMs: number): Promise<void> {
  const id = nextSeq();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      completed.delete(id);
      resolve();
    }, timeoutMs);
    completed.set(id, () => {
      clearTimeout(timer);
      resolve();
    });
    post(command, args, id);
  });
}

interface LspState {
  status: CheckStatus;
  diags: Diags;
  /** Kept alongside `diags` so components re-render on a stable array rather
   *  than a fresh one every render. */
  problems: Problem[];
  /** Set by go-to-definition when the target is in a file that isn't open yet;
   *  consumed by EditorPane once that file's editor mounts. */
  reveal: { path: string; line: number; column: number } | null;

  start: (root: string) => Promise<void>;
  stop: () => Promise<void>;
  /** Editor tab opened, or agent write landed: make sure tsserver has this
   *  file with this exact content, and re-check it. */
  touch: (path: string, content: string) => void;
  close: (path: string) => void;
  /** Type-check every file in the project, including ones nobody opened —
   *  an edit in one file breaks another, and that's the whole point of having
   *  a compiler rather than a linter. */
  checkProject: () => Promise<void>;
  takeReveal: () => { path: string; line: number; column: number } | null;
}

/** Debounce before re-checking a file being typed into. Long enough that a
 *  burst of keystrokes is one check, short enough to feel immediate. */
const CHECK_DEBOUNCE_MS = 400;
/** A cold project-wide check loads every file the project references. */
const PROJECT_CHECK_TIMEOUT_MS = 30_000;

const checkTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Any file tsserver has open — `geterrForProject` needs one to name the
 *  project, and a re-check needs the set. */
const openFiles = new Set<string>();
/** Passed on every `open` so tsserver scopes the project to the folder Hearth
 *  has open, rather than inferring it by walking up from each file. */
let projectRoot = "";

function setDiags(next: Diags) {
  if (next === useLsp.getState().diags) return;
  useLsp.setState({ diags: next, problems: allProblems(next) });
}

function handleMessage(raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return; // a body we couldn't parse tells us nothing; the next one might
  }

  if (msg.type === "response") {
    pending.get(msg.request_seq)?.(msg);
    pending.delete(msg.request_seq);
    return;
  }
  if (msg.type !== "event") return;

  if (msg.event === "requestCompleted") {
    completed.get(msg.body?.request_seq)?.();
    completed.delete(msg.body?.request_seq);
    return;
  }
  setDiags(applyDiagEvent(useLsp.getState().diags, msg.event, msg.body));
}

export const useLsp = create<LspState>((set, get) => ({
  status: "unavailable",
  diags: {},
  problems: [],
  reveal: null,

  start: async (root: string) => {
    await get().stop();
    const onMessage = new Channel<string>();
    onMessage.onmessage = handleMessage;
    projectRoot = tsPath(root);
    try {
      await invoke("ts_start", { root: projectRoot, onMessage });
      // "Started" isn't "checking": whether anything gets type-checked depends
      // on a tsconfig/jsconfig existing, and that answer only arrives once a
      // file is open. `touch` resolves it.
      set({ status: "ok", diags: {}, problems: [] });
    } catch {
      set({ status: "unavailable", diags: {}, problems: [] });
    }
  },

  stop: async () => {
    for (const timer of checkTimers.values()) clearTimeout(timer);
    checkTimers.clear();
    openFiles.clear();
    sentContent.clear();
    pending.clear();
    completed.clear();
    await invoke("ts_stop").catch(() => {});
    set({ status: "unavailable", diags: {}, problems: [], reveal: null });
  },

  touch: (path: string, content: string) => {
    if (get().status === "unavailable") return;
    const file = tsPath(path);
    const previous = sentContent.get(file);

    if (previous === undefined) {
      post("open", { file, fileContent: content, projectRootPath: projectRoot });
      openFiles.add(file);
      // One question, asked once a file exists to ask it about: is this project
      // configured at all? Without a tsconfig/jsconfig, tsserver files it under
      // an inferred project and reports nothing for plain JS — which looks
      // exactly like a clean project unless someone says otherwise.
      if (openFiles.size === 1) void resolveStatus(file);
    } else if (previous !== content) {
      post("change", { file, ...fullReplaceRange(previous), insertString: content });
    } else {
      return; // nothing changed; a re-check would report what we already have
    }
    sentContent.set(file, content);

    clearTimeout(checkTimers.get(file));
    checkTimers.set(
      file,
      setTimeout(() => {
        checkTimers.delete(file);
        void requestErrors("geterr", { files: [file], delay: 0 }, 10_000);
      }, CHECK_DEBOUNCE_MS),
    );
  },

  close: (path: string) => {
    const file = tsPath(path);
    if (!openFiles.delete(file)) return;
    clearTimeout(checkTimers.get(file));
    checkTimers.delete(file);
    sentContent.delete(file);
    post("close", { file });
    // Its diagnostics go with it: nothing is re-checking that file now, so
    // leaving them would show errors that may already be fixed.
    setDiags(forgetFile(useLsp.getState().diags, file));
  },

  checkProject: async () => {
    const anchor = [...openFiles][0];
    if (get().status !== "ok" || !anchor) return;
    await requestErrors("geterrForProject", { file: anchor, delay: 0 }, PROJECT_CHECK_TIMEOUT_MS);
  },

  takeReveal: () => {
    const reveal = get().reveal;
    if (reveal) set({ reveal: null });
    return reveal;
  },
}));

/** tsserver's name for "this file belongs to no project I was configured for". */
const INFERRED = "/dev/null/inferredProject";

async function resolveStatus(file: string) {
  const info = await request<{ configFileName?: string }>("projectInfo", { file, needFileNameList: false });
  if (!info) return; // no answer; leave the optimistic "ok" and let diagnostics speak
  const configured = !!info.configFileName && !info.configFileName.includes(INFERRED);
  useLsp.setState({ status: configured ? "ok" : "unconfigured" });
}

/** True once the agent has anything to report about. Distinguishes "checked and
 *  clean" from "nothing has been checked yet", which are the same silence. */
export function hasChecked(): boolean {
  return openFiles.size > 0;
}
