import { useEffect, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import { useHearthStore, type DiffView } from "../lib/store";
import { useLsp } from "../lib/lsp";
import { attachModel, findReferences, CTRL_K, SHIFT_F12 } from "../lib/monaco-ts";
import { inlineEdit } from "../lib/inline";
import { cancelChat } from "../lib/ollama";
import { fileHunks, revertHunk } from "../lib/git";
import { resolveInProject } from "../lib/edit";
import type { Hunk } from "../lib/gitdiff";

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  rs: "rust",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
};

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "plaintext";
}

/** tsserver answers in forward slashes; the picker hands us Windows ones, and
 *  not always in the same drive-letter case. */
function sameFile(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

/**
 * The reject half of build plan §8's diff review.
 *
 * A strip rather than controls inside the diff editor: Monaco's diff view has
 * no per-hunk affordance to hang a button on, and rendering our own gutter over
 * it would mean tracking its scroll. The list is also the only place that can
 * say a hunk has already been put back.
 */
function HunkStrip({ diff, root }: { diff: DiffView & { sha: string }; root: string }) {
  const [hunks, setHunks] = useState<Hunk[] | null>(null);
  const [reverted, setReverted] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHunks(null);
    setReverted(new Set());
    setError(null);
    fileHunks(root, diff.sha, diff.path).then(setHunks, (err: Error) => setError(err.message));
  }, [root, diff.sha, diff.path]);

  async function revert(hunk: Hunk, i: number) {
    setError(null);
    try {
      await revertHunk(root, diff.path, hunk);
      // The diff above is history and doesn't move; the file on disk and any
      // open tab do. Resolved first: a `DiffView` path is project-relative (it
      // comes from git), and `syncFromDisk` matches against tab paths, which are
      // absolute — handed the relative one it silently matches nothing, leaving
      // the editor holding pre-revert text that the next save writes back.
      await useHearthStore.getState().syncFromDisk(resolveInProject(root, diff.path));
      setReverted((s) => new Set(s).add(i));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error) return <div className="shrink-0 bg-red-950/40 px-2 py-1 text-[11px] text-red-300">{error}</div>;
  if (!hunks || hunks.length <= 0) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-neutral-800 bg-neutral-950 px-2 py-1">
      <span className="mr-1 text-[10px] uppercase tracking-wide text-neutral-600">
        {hunks.length} hunk{hunks.length === 1 ? "" : "s"}
      </span>
      {hunks.map((hunk, i) => (
        <button
          key={i}
          onClick={() => void revert(hunk, i)}
          disabled={reverted.has(i)}
          title={reverted.has(i) ? "Put back" : `Undo this part of the turn in the file on disk\n\n${hunk.header}`}
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
            reverted.has(i)
              ? "bg-neutral-900 text-neutral-600 line-through"
              : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
          }`}
        >
          ↩ line {hunk.line}
        </button>
      ))}
    </div>
  );
}

/**
 * `path` pins this pane to one file — the split. Without it the pane follows
 * `activePath`, which is the main editor.
 *
 * The two share Monaco's model registry, keyed by path, so splitting a file
 * against itself is two views of one buffer rather than two buffers racing to
 * save. What the split pane deliberately doesn't do is take part in anything
 * global: the diff takes over the main pane, and a go-to-definition jump moves
 * the main pane, because both would otherwise fire twice and the second one
 * would win.
 */
export function EditorPane({ path }: { path?: string } = {}) {
  const isSplit = path !== undefined;
  const tabs = useHearthStore((s) => s.tabs);
  const activePath = useHearthStore((s) => (path !== undefined ? path : s.activePath));
  const setTabContent = useHearthStore((s) => s.setTabContent);
  const diff = useHearthStore((s) => s.diff);
  const closeDiff = useHearthStore((s) => s.closeDiff);

  const projectRoot = useHearthStore((s) => s.projectRoot);
  const activeTab = tabs.find((t) => t.path === activePath);
  const reveal = useLsp((s) => s.reveal);
  const agentLines = useHearthStore((s) => (activePath ? s.agentLines[activePath] : undefined));
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // State as well as a ref: the decoration effect below has to re-run when the
  // editor finishes mounting, and a ref assignment doesn't re-render.
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Ctrl+K: the selection to rewrite, held while the instruction is typed.
  const [inline, setInline] = useState<{ range: monaco.IRange; code: string } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [inlineBusy, setInlineBusy] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const inlineCancel = useRef("");

  async function runInline() {
    if (!inline || !editor || !activeTab || !instruction.trim()) return;
    setInlineBusy(true);
    setInlineError(null);
    inlineCancel.current = `inline#${Date.now()}`;
    try {
      const replacement = await inlineEdit({
        path: activeTab.path,
        language: languageFor(activeTab.path),
        selection: inline.code,
        instruction: instruction.trim(),
        cancelId: inlineCancel.current,
      });
      // Through the editor rather than the store, so it lands as one undo step
      // and the tab goes dirty like anything else you typed.
      editor.executeEdits("hearth.inlineEdit", [{ range: inline.range, text: replacement }]);
      editor.focus();
      setInline(null);
      setInstruction("");
    } catch (err) {
      setInlineError((err as Error).message);
    } finally {
      setInlineBusy(false);
    }
  }

  function closeInline() {
    if (inlineBusy) void cancelChat(inlineCancel.current);
    setInline(null);
    setInstruction("");
    setInlineError(null);
    editor?.focus();
  }

  // What the agent just wrote, marked in place. Without this a change you
  // didn't type is invisible unless you already know where to look — and the
  // whole point of the agent editing the open file is that you're watching.
  useEffect(() => {
    if (!editor || !agentLines?.length) return;
    const marks = editor.createDecorationsCollection(
      agentLines.map((line) => ({
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: {
          isWholeLine: true,
          className: "hearth-agent-line",
          linesDecorationsClassName: "hearth-agent-gutter",
        },
      })),
    );
    return () => marks.clear();
  }, [editor, agentLines]);

  // Jump to a position asked for by go-to-definition or a Problems row.
  //
  // Two cases, and both are normal: the target is already the open file, or it
  // isn't and the tab has to be opened first — which unmounts this editor, so
  // the jump has to survive on the store and be applied by whichever editor
  // mounts next. Hence a request that outlives the component that made it.
  function applyReveal(editor: monaco.editor.IStandaloneCodeEditor): boolean {
    const pending = useLsp.getState().reveal;
    if (!pending || !activeTab || !sameFile(pending.path, activeTab.path)) return false;
    useLsp.getState().takeReveal();
    editor.setPosition({ lineNumber: pending.line, column: pending.column });
    editor.revealLineInCenter(pending.line);
    editor.focus();
    return true;
  }

  useEffect(() => {
    if (!reveal || isSplit) return;
    // Already mounted on the right file — no tab switch to wait for.
    if (editorRef.current && applyReveal(editorRef.current)) return;
    const name = reveal.path.split(/[\\/]/).pop() ?? reveal.path;
    void useHearthStore
      .getState()
      .openFile(reveal.path, name)
      .catch(() => useLsp.getState().takeReveal());
  }, [reveal, activeTab?.path]);

  // Takes over the pane rather than opening as a tab: a diff is a view of a
  // past commit, not a file you can save, and a tab implies both.
  if (diff && !isSplit) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2 text-[11px]">
          <span className="truncate text-neutral-300">{diff.path}</span>
          <span className="shrink-0 text-neutral-600">{diff.label}</span>
          <button
            onClick={closeDiff}
            title="Close diff"
            className="ml-auto shrink-0 rounded px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            ✕
          </button>
        </div>
        {projectRoot && diff.sha && <HunkStrip diff={{ ...diff, sha: diff.sha }} root={projectRoot} />}
        <div className="min-h-0 flex-1">
          <DiffEditor
            original={diff.original}
            modified={diff.modified}
            language={languageFor(diff.path)}
            theme="vs-dark"
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              automaticLayout: true,
              // Both sides are history. Editing the right-hand side would look
              // like it wrote to the file, and it wouldn't.
              readOnly: true,
              originalEditable: false,
            }}
          />
        </div>
      </div>
    );
  }

  if (!activeTab) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-600">
        Open a file from the sidebar to start editing.
      </div>
    );
  }

  // Monaco builds its own URI from the path we hand it, so rather than
  // reverse-engineer that mapping the model registers itself here — that's what
  // lets diagnostics find the right editor and the providers turn a cursor
  // position back into a filename.
  function handleMount(mounted: monaco.editor.IStandaloneCodeEditor) {
    editorRef.current = mounted;
    setEditor(mounted);
    const model = mounted.getModel();
    if (model) attachModel(activeTab!.path, model);

    // Find-all-references as an action rather than Monaco's own reference
    // provider: the peek widget can only show files Monaco already has a model
    // for, which here means open tabs — and references in a file you haven't
    // opened are exactly the ones worth finding. The dock panel has no such
    // limit, so the results go there.
    mounted.addAction({
      id: "hearth.references",
      label: "Find All References",
      keybindings: [SHIFT_F12],
      contextMenuGroupId: "navigation",
      run: (self) => void findReferences(self),
    });

    // Ctrl+K. With nothing selected it takes the current line, which is the
    // common case — you put the cursor on the line you want changed.
    mounted.addAction({
      id: "hearth.inlineEdit",
      label: "Edit with the model",
      keybindings: [CTRL_K],
      contextMenuGroupId: "modification",
      run: (self) => {
        const target = self.getModel();
        const selection = self.getSelection();
        if (!target || !selection) return;
        const range = selection.isEmpty()
          ? {
              startLineNumber: selection.startLineNumber,
              startColumn: 1,
              endLineNumber: selection.startLineNumber,
              endColumn: target.getLineMaxColumn(selection.startLineNumber),
            }
          : selection;
        setInlineError(null);
        setInline({ range, code: target.getValueInRange(range) });
      },
    });

    // The effect above may have run before Monaco finished loading, so the
    // pending jump is applied here too rather than only there.
    applyReveal(mounted);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <Editor
          key={activeTab.path}
          path={activeTab.path}
          language={languageFor(activeTab.path)}
          value={activeTab.content}
          theme="vs-dark"
          onMount={handleMount}
          onChange={(value) => setTabContent(activeTab.path, value ?? "")}
          options={{
            fontSize: 13,
            minimap: { enabled: false },
            automaticLayout: true,
            tabSize: 2,
          }}
        />
      </div>

      {/* Under the editor rather than floating over the cursor: a widget at the
          cursor covers the code you are about to change, which is the code you
          want to be looking at while you describe the change. */}
      {inline && (
        <div className="shrink-0 border-t border-sky-900/60 bg-neutral-900 p-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] text-neutral-500">
              {inline.range.startLineNumber === inline.range.endLineNumber
                ? `line ${inline.range.startLineNumber}`
                : `lines ${inline.range.startLineNumber}–${inline.range.endLineNumber}`}
            </span>
            <input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runInline();
                if (e.key === "Escape") closeInline();
              }}
              disabled={inlineBusy}
              autoFocus
              placeholder="What should this become?"
              className="min-w-0 flex-1 rounded bg-neutral-800 px-2 py-1 text-[12px] text-neutral-100 outline-none placeholder:text-neutral-600 disabled:opacity-50"
            />
            <button
              onClick={closeInline}
              className="shrink-0 rounded px-1.5 py-1 text-[12px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            >
              {inlineBusy ? "Cancel" : "Esc"}
            </button>
          </div>
          {(inlineBusy || inlineError) && (
            <div className={`mt-1 text-[11px] ${inlineError ? "text-red-400" : "text-neutral-500"}`}>
              {inlineError ?? "rewriting…"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
