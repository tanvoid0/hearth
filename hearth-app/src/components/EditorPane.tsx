import Editor, { DiffEditor } from "@monaco-editor/react";
import { useHearthStore } from "../lib/store";

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

export function EditorPane() {
  const tabs = useHearthStore((s) => s.tabs);
  const activePath = useHearthStore((s) => s.activePath);
  const setTabContent = useHearthStore((s) => s.setTabContent);
  const diff = useHearthStore((s) => s.diff);
  const closeDiff = useHearthStore((s) => s.closeDiff);

  const activeTab = tabs.find((t) => t.path === activePath);

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

  return (
    <Editor
      key={activeTab.path}
      path={activeTab.path}
      language={languageFor(activeTab.path)}
      value={activeTab.content}
      theme="vs-dark"
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
