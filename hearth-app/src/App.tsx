import { useEffect, useMemo, useState } from "react";
import { useHearthStore } from "./lib/store";
import { pickFolder } from "./lib/fs";
import { FileTree } from "./components/FileTree";
import { TabBar } from "./components/TabBar";
import { EditorPane } from "./components/EditorPane";
import { ChatPanel } from "./components/ChatPanel";
import { PreviewPane } from "./components/PreviewPane";
import { TerminalPanel } from "./components/TerminalPanel";
import { Home } from "./components/Home";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { useRunner } from "./lib/runner";

function App() {
  const projectRoot = useHearthStore((s) => s.projectRoot);
  const openFolder = useHearthStore((s) => s.openFolder);
  const closeProject = useHearthStore((s) => s.closeProject);
  const [chatOpen, setChatOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  // Once opened it stays mounted and is hidden instead: unmounting would kill
  // the shell, so toggling the panel would silently discard your cwd, your
  // history, and anything still running in it.
  const [terminalUsed, setTerminalUsed] = useState(false);
  // Only to mark the collapsed Preview button when a server is up behind it.
  const running = useRunner((s) => s.running);

  async function handleOpenFolder() {
    const folder = await pickFolder();
    if (folder) await openFolder(folder);
  }

  function handleBackToProjects() {
    const dirty = useHearthStore.getState().tabs.filter((t) => t.content !== t.savedContent);
    if (dirty.length > 0 && !confirm(`${dirty.length} unsaved file(s) will be discarded. Leave anyway?`)) return;
    closeProject();
  }

  // Window-level rather than a Monaco keybinding: Ctrl+S has to save the
  // active tab even when focus is in the file tree or on a tab, and it has to
  // suppress the webview's own save-page handler either way.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      const { activePath, saveTab } = useHearthStore.getState();
      if (activePath) void saveTab(activePath);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Everything the header buttons do, reachable without leaving the keyboard.
  // Deliberately built from the same handlers rather than a parallel registry:
  // a command that drifts from its button is worse than no command.
  const commands = useMemo<PaletteCommand[]>(
    () => [
      { label: "Save file", run: () => {
        const { activePath, saveTab } = useHearthStore.getState();
        if (activePath) void saveTab(activePath);
      } },
      { label: "Open folder…", run: () => void handleOpenFolder() },
      { label: "Toggle terminal", run: () => { setTerminalUsed(true); setTerminalOpen((v) => !v); } },
      { label: "Toggle preview", run: () => setPreviewOpen((v) => !v) },
      { label: "Toggle agent panel", run: () => setChatOpen((v) => !v) },
      { label: "Run dev server", run: () => projectRoot && void useRunner.getState().start(projectRoot) },
      { label: "Stop dev server", run: () => void useRunner.getState().stop() },
      { label: "Back to projects", run: handleBackToProjects },
    ],
    [projectRoot],
  );

  if (!projectRoot) return <Home />;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      <CommandPalette commands={commands} />
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
        <button
          onClick={handleBackToProjects}
          className="rounded px-1.5 py-1 text-[13px] font-medium text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          ← Hearth
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={handleOpenFolder}
            className="rounded bg-neutral-800 px-2.5 py-1 text-[12px] text-neutral-200 hover:bg-neutral-700"
          >
            Open Folder
          </button>
          <button
            onClick={() => setPreviewOpen((v) => !v)}
            className={`rounded px-2.5 py-1 text-[12px] hover:bg-neutral-700 ${
              previewOpen ? "bg-neutral-700 text-white" : "bg-neutral-800 text-neutral-200"
            }`}
          >
            Preview{running && !previewOpen ? " ●" : ""}
          </button>
          <button
            onClick={() => {
              setTerminalUsed(true);
              setTerminalOpen((v) => !v);
            }}
            className={`rounded px-2.5 py-1 text-[12px] hover:bg-neutral-700 ${
              terminalOpen ? "bg-neutral-700 text-white" : "bg-neutral-800 text-neutral-200"
            }`}
          >
            Terminal
          </button>
          <button
            onClick={() => setChatOpen((v) => !v)}
            className={`rounded px-2.5 py-1 text-[12px] hover:bg-neutral-700 ${
              chatOpen ? "bg-neutral-700 text-white" : "bg-neutral-800 text-neutral-200"
            }`}
          >
            Agent
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900">
          <div className="truncate border-b border-neutral-800 px-3 py-2 text-[11px] uppercase tracking-wide text-neutral-500">
            {projectRoot ? projectRoot.split(/[\\/]/).pop() : "Explorer"}
          </div>
          <FileTree />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <div className="min-h-0 flex-1">
            <EditorPane />
          </div>
          {previewOpen && <PreviewPane />}
          {terminalUsed && (
            <div className={`h-64 shrink-0 border-t border-neutral-800 ${terminalOpen ? "" : "hidden"}`}>
              <TerminalPanel root={projectRoot} visible={terminalOpen} />
            </div>
          )}
        </main>

        {chatOpen && (
          <aside className="w-[380px] shrink-0 border-l border-neutral-800">
            <ChatPanel />
          </aside>
        )}
      </div>
    </div>
  );
}

export default App;
