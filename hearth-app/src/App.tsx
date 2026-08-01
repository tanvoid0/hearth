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
import { ProblemsPanel } from "./components/ProblemsPanel";
import { SearchPanel } from "./components/SearchPanel";
import { OutlinePanel } from "./components/OutlinePanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { ProjectPanel } from "./components/ProjectPanel";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { useRunner } from "./lib/runner";
import { useLsp } from "./lib/lsp";
import { committedVersion } from "./lib/git";

/** The bottom dock holds one thing at a time (build plan §3). */
type Dock = "terminal" | "problems" | "search" | "outline" | "history" | "project" | null;

const DOCK_TABS: Array<{ key: Exclude<Dock, null>; label: string }> = [
  { key: "problems", label: "Problems" },
  { key: "search", label: "Search" },
  { key: "outline", label: "Outline" },
  { key: "history", label: "History" },
  { key: "project", label: "Project" },
  { key: "terminal", label: "Terminal" },
];

function App() {
  const projectRoot = useHearthStore((s) => s.projectRoot);
  const openFolder = useHearthStore((s) => s.openFolder);
  const closeProject = useHearthStore((s) => s.closeProject);
  const [chatOpen, setChatOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dock, setDock] = useState<Dock>(null);
  // Once opened the terminal stays mounted and is hidden instead: unmounting
  // would kill the shell, so switching away would silently discard your cwd,
  // your history, and anything still running in it.
  const [terminalUsed, setTerminalUsed] = useState(false);
  // Only to mark the collapsed Preview button when a server is up behind it.
  const running = useRunner((s) => s.running);
  // A type error with the dock collapsed is otherwise invisible until you open
  // the file — the same argument as the preview's console badge.
  const problemCount = useLsp((s) => s.problems.length);
  const references = useLsp((s) => s.references);

  // Shift+F12 in the editor puts its answer in a panel that may not be open —
  // and a keystroke that appears to do nothing is one nobody presses twice.
  useEffect(() => {
    if (references) setDock("outline");
  }, [references]);

  function toggleDock(which: Exclude<Dock, null>) {
    if (which === "terminal") setTerminalUsed(true);
    setDock((current) => (current === which ? null : which));
  }

  async function handleOpenFolder() {
    const folder = await pickFolder();
    if (folder) await openFolder(folder);
  }

  // The diff half of P1's deferred split/diff view, against the thing there's
  // actually a question about: has this file changed since the agent's last
  // turn, and how. Compares the editor buffer, not the file on disk, so it
  // answers that before you save as well as after.
  async function compareWithCheckpoint() {
    const { activePath, tabs, openDiff } = useHearthStore.getState();
    const tab = tabs.find((t) => t.path === activePath);
    if (!tab || !projectRoot) return;
    const base = projectRoot.replace(/\\/g, "/");
    const rel = tab.path.replace(/\\/g, "/").slice(base.length + 1);
    openDiff({
      path: rel,
      label: "last checkpoint → now",
      original: await committedVersion(projectRoot, rel),
      modified: tab.content,
      // Not one commit's change, so there are no hunks of a commit to reject.
      sha: null,
    });
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
      if (!(e.ctrlKey || e.metaKey)) return;
      // Ctrl+Shift+F is project-wide search; Monaco keeps Ctrl+F for the file.
      if (e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setDock("search");
        return;
      }
      if (e.key.toLowerCase() !== "s") return;
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
      { label: "Compare with last checkpoint", run: () => void compareWithCheckpoint() },
      ...DOCK_TABS.map((tab) => ({ label: `Toggle ${tab.label.toLowerCase()}`, run: () => toggleDock(tab.key) })),
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
          {DOCK_TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => toggleDock(key)}
              className={`rounded px-2.5 py-1 text-[12px] hover:bg-neutral-700 ${
                dock === key ? "bg-neutral-700 text-white" : "bg-neutral-800 text-neutral-200"
              }`}
            >
              {/* The outline tab answers whichever question was asked last. */}
              {key === "outline" && references ? "References" : label}
              {key === "problems" && problemCount > 0 && <span className="ml-1.5 text-red-400">{problemCount}</span>}
            </button>
          ))}
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
          {(terminalUsed || dock !== null) && (
            <div className={`relative h-64 shrink-0 border-t border-neutral-800 ${dock ? "" : "hidden"}`}>
              {terminalUsed && (
                <div className={`absolute inset-0 ${dock === "terminal" ? "" : "hidden"}`}>
                  <TerminalPanel root={projectRoot} visible={dock === "terminal"} />
                </div>
              )}
              {dock === "problems" && (
                <div className="absolute inset-0">
                  <ProblemsPanel root={projectRoot} />
                </div>
              )}
              {dock === "search" && (
                <div className="absolute inset-0">
                  <SearchPanel root={projectRoot} />
                </div>
              )}
              {dock === "outline" && (
                <div className="absolute inset-0">
                  <OutlinePanel root={projectRoot} />
                </div>
              )}
              {dock === "history" && (
                <div className="absolute inset-0">
                  <HistoryPanel root={projectRoot} />
                </div>
              )}
              {dock === "project" && (
                <div className="absolute inset-0">
                  <ProjectPanel root={projectRoot} />
                </div>
              )}
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
