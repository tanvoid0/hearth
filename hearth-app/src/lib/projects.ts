import { homeDir } from "@tauri-apps/api/path";
import { listDir, readTextFile, writeTextFile } from "./fs";
import { resolveInProject } from "./edit";
import { MARKER, slugify, template, uniqueName, type TemplateKind } from "./workspace";

export interface ProjectInfo {
  name: string;
  path: string;
  /** Name of the containing folder when the project is nested one level. */
  group: string | null;
  prompt?: string;
  created?: string;
}

/** Default home for projects. One setting, no config file. */
export async function defaultWorkspaceDir(): Promise<string> {
  return resolveInProject(await homeDir(), "Hearth");
}

async function readMeta(dir: string): Promise<{ prompt?: string; created?: string } | null> {
  try {
    return JSON.parse(await readTextFile(resolveInProject(dir, MARKER)));
  } catch {
    return null; // no marker, or hand-edited into invalid JSON — either way, not a project
  }
}

/**
 * Projects under the workspace, plus those one level down inside group
 * folders. Two levels is the whole hierarchy: deeper nesting is a file tree,
 * not a switcher.
 */
export async function scanProjects(workspaceDir: string): Promise<ProjectInfo[]> {
  const top = await listDir(workspaceDir).catch(() => []);
  const found: ProjectInfo[] = [];

  for (const entry of top.filter((e) => e.is_dir)) {
    const meta = await readMeta(entry.path);
    if (meta) {
      found.push({ name: entry.name, path: entry.path, group: null, ...meta });
      continue;
    }
    const children = await listDir(entry.path).catch(() => []);
    for (const child of children.filter((e) => e.is_dir)) {
      const childMeta = await readMeta(child.path);
      if (childMeta) found.push({ name: child.name, path: child.path, group: entry.name, ...childMeta });
    }
  }

  return found;
}

/**
 * Create the project directory, write the starter scaffold and the marker,
 * and return the new root. `write_text_file` creates missing parents, so this
 * needs no mkdir on either side of the IPC boundary.
 */
export async function createProject(
  workspaceDir: string,
  prompt: string,
  kind: TemplateKind = "react",
): Promise<string> {
  const siblings = await listDir(workspaceDir).catch(() => []);
  const name = uniqueName(slugify(prompt), siblings.map((e) => e.name));
  const root = resolveInProject(workspaceDir, name);

  for (const [rel, content] of Object.entries(template(name, kind))) {
    await writeTextFile(resolveInProject(root, rel), content);
  }
  await writeTextFile(
    resolveInProject(root, MARKER),
    JSON.stringify({ name, prompt, template: kind, created: new Date().toISOString() }, null, 2) + "\n",
  );

  return root;
}
