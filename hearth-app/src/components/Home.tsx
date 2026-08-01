import { useEffect, useState } from "react";
import { useHearthStore } from "../lib/store";
import { pickFolder } from "../lib/fs";
import { defaultWorkspaceDir, scanProjects, type ProjectInfo } from "../lib/projects";
import { TEMPLATES, type TemplateKind } from "../lib/workspace";

function ProjectCard({ project }: { project: ProjectInfo }) {
  const openFolder = useHearthStore((s) => s.openFolder);
  return (
    <button
      onClick={() => void openFolder(project.path)}
      className="flex w-full flex-col gap-1 rounded border border-neutral-800 bg-neutral-900 p-3 text-left hover:border-neutral-700 hover:bg-neutral-800"
    >
      <span className="truncate text-[13px] text-neutral-100">{project.name}</span>
      <span className="line-clamp-2 text-[11px] text-neutral-500">{project.prompt ?? project.path}</span>
    </button>
  );
}

export function Home() {
  const workspaceDir = useHearthStore((s) => s.workspaceDir);
  const setWorkspaceDir = useHearthStore((s) => s.setWorkspaceDir);
  const openFolder = useHearthStore((s) => s.openFolder);
  const newProject = useHearthStore((s) => s.newProject);

  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<TemplateKind>("react");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve the default workspace on first run so the path is visible before
  // anything is created in it.
  useEffect(() => {
    if (!workspaceDir) void defaultWorkspaceDir().then(setWorkspaceDir);
  }, [workspaceDir, setWorkspaceDir]);

  useEffect(() => {
    if (workspaceDir) void scanProjects(workspaceDir).then(setProjects);
  }, [workspaceDir]);

  async function create() {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await newProject(text, kind);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function changeWorkspace() {
    const dir = await pickFolder();
    if (dir) setWorkspaceDir(dir);
  }

  async function openExisting() {
    const dir = await pickFolder();
    if (dir) await openFolder(dir);
  }

  const groups = [...new Set(projects.map((p) => p.group))].sort((a, b) =>
    a === null ? -1 : b === null ? 1 : a.localeCompare(b),
  );

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-neutral-950 text-neutral-100">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-16">
        <div>
          <h1 className="text-[22px] font-medium">Hearth</h1>
          <p className="mt-1 text-[13px] text-neutral-500">Describe what you want to build.</p>
        </div>

        <div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void create();
              }
            }}
            rows={4}
            autoFocus
            placeholder="A todo app with dark mode…"
            className="w-full resize-none rounded border border-neutral-800 bg-neutral-900 p-3 text-[14px] text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-700"
          />
          <div className="mt-2 flex items-center gap-1.5">
            {TEMPLATES.map((t) => (
              <button
                key={t.kind}
                onClick={() => setKind(t.kind)}
                title={t.hint}
                className={`rounded px-2 py-0.5 text-[11px] ${
                  kind === t.kind ? "bg-neutral-700 text-neutral-100" : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {t.label}
              </button>
            ))}
            <span className="ml-auto mr-2 text-[11px] text-neutral-600">Enter to create</span>
            <button
              onClick={() => void create()}
              disabled={!prompt.trim() || busy}
              className="rounded bg-neutral-700 px-3 py-1.5 text-[12px] text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create project"}
            </button>
          </div>
          {error && (
            <div className="mt-2 rounded border border-red-900 bg-red-950/40 p-2 text-[12px] text-red-300">{error}</div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-wide text-neutral-500">Projects</span>
            <button onClick={() => void openExisting()} className="text-[11px] text-neutral-500 hover:text-neutral-300">
              Open a folder…
            </button>
          </div>

          {projects.length === 0 && (
            <p className="text-[13px] text-neutral-600">
              No projects yet. Anything you create lands in the workspace below.
            </p>
          )}

          {groups.map((group) => (
            <div key={group ?? "__root"} className="flex flex-col gap-2">
              {group && <span className="text-[11px] text-neutral-500">{group}</span>}
              <div className="grid grid-cols-2 gap-2">
                {projects
                  .filter((p) => p.group === group)
                  .map((p) => (
                    <ProjectCard key={p.path} project={p} />
                  ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-neutral-900 pt-4 text-[11px] text-neutral-600">
          <span className="truncate">Workspace: {workspaceDir ?? "…"}</span>
          <button onClick={() => void changeWorkspace()} className="shrink-0 hover:text-neutral-300">
            change
          </button>
        </div>
      </div>
    </div>
  );
}
