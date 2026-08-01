import { useEffect, useRef } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import { useHearthStore } from "../lib/store";
import { useLsp } from "../lib/lsp";
import { attachModel } from "../lib/monaco-ts";

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

export function EditorPane() {
  const tabs = useHearthStore((s) => s.tabs);
  const activePath = useHearthStore((s) => s.activePath);
  const setTabContent = useHearthStore((s) => s.setTabContent);
  const diff = useHearthStore((s) => s.diff);
  const closeDiff = useHearthStore((s) => s.closeDiff);

  const activeTab = tabs.find((t) => t.path === activePath);
  const reveal = useLsp((s) => s.reveal);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

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
    if (!reveal) return;
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
  if (diff) {
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
  function handleMount(editor: monaco.editor.IStandaloneCodeEditor) {
    editorRef.current = editor;
    const model = editor.getModel();
    if (model) attachModel(activeTab!.path, model);
    // The effect above may have run before Monaco finished loading, so the
    // pending jump is applied here too rather than only there.
    applyReveal(editor);
  }

  return (
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
  );
}
