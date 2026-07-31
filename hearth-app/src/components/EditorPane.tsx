import Editor from "@monaco-editor/react";
import * as monaco from "monaco-editor";
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
  const saveTab = useHearthStore((s) => s.saveTab);

  const activeTab = tabs.find((t) => t.path === activePath);

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
      onMount={(editor) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          void saveTab(activeTab.path);
        });
      }}
      options={{
        fontSize: 13,
        minimap: { enabled: false },
        automaticLayout: true,
        tabSize: 2,
      }}
    />
  );
}
