import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface DirEntryInfo {
  name: string;
  path: string;
  is_dir: boolean;
}

export async function pickFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return null;
  return selected;
}

export function listDir(path: string): Promise<DirEntryInfo[]> {
  return invoke("list_dir", { path });
}

/** `root` re-checks in Rust that the path is inside the project, following
 *  symlinks — passed by the agent's tools, whose paths come from a model, and
 *  omitted by the UI, which legitimately reads outside the open project (the
 *  workspace scan looks for markers in folders that aren't projects yet). */
export function readTextFile(path: string, root?: string): Promise<string> {
  return invoke("read_text_file", { path, root });
}

export function writeTextFile(path: string, contents: string, root?: string): Promise<void> {
  return invoke("write_text_file", { path, contents, root });
}

/** Anything at this path — file or directory. Not "does a read succeed": that
 *  reports every binary file in the project as absent. */
export function pathExists(path: string): Promise<boolean> {
  return invoke("path_exists", { path });
}

export interface SearchHit {
  /** Relative to the project root, forward slashes. */
  path: string;
  line: number;
  text: string;
}

/** Literal, case-insensitive search across the project. The walk and the skip
 *  list live in Rust; see `search_files` there for why this isn't ripgrep. */
export function searchFiles(root: string, query: string, max: number): Promise<SearchHit[]> {
  return invoke("search_files", { root, query, max });
}
