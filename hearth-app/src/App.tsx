import { useHearthStore } from "./lib/store";
import { pickFolder } from "./lib/fs";
import { FileTree } from "./components/FileTree";
import { TabBar } from "./components/TabBar";
import { EditorPane } from "./components/EditorPane";

function App() {
  const projectRoot = useHearthStore((s) => s.projectRoot);
  const openFolder = useHearthStore((s) => s.openFolder);

  async function handleOpenFolder() {
    const folder = await pickFolder();
    if (folder) await openFolder(folder);
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
        <span className="text-[13px] font-medium text-neutral-300">Hearth</span>
        <button
          onClick={handleOpenFolder}
          className="rounded bg-neutral-800 px-2.5 py-1 text-[12px] text-neutral-200 hover:bg-neutral-700"
        >
          Open Folder
        </button>
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
        </main>
      </div>
    </div>
  );
}

export default App;
