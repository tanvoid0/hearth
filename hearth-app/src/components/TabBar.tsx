import { useHearthStore } from "../lib/store";

export function TabBar() {
  const tabs = useHearthStore((s) => s.tabs);
  const activePath = useHearthStore((s) => s.activePath);
  const setActivePath = useHearthStore((s) => s.setActivePath);
  const closeTab = useHearthStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-neutral-800 bg-neutral-900">
      {tabs.map((tab) => {
        const dirty = tab.content !== tab.savedContent;
        const isActive = tab.path === activePath;
        return (
          <div
            key={tab.path}
            onClick={() => setActivePath(tab.path)}
            className={`group flex cursor-pointer items-center gap-2 border-r border-neutral-800 px-3 text-[13px] ${
              isActive ? "bg-neutral-950 text-white" : "text-neutral-400 hover:bg-neutral-800"
            }`}
          >
            <span className="max-w-[160px] truncate">{tab.name}</span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.path);
              }}
              className="flex h-4 w-4 items-center justify-center rounded text-neutral-500 hover:bg-neutral-700 hover:text-white"
            >
              {dirty ? "●" : "×"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
