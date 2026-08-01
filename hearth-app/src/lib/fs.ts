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

export function readTextFile(path: string): Promise<string> {
  return invoke("read_text_file", { path });
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke("write_text_file", { path, contents });
}

/** Append rather than rewrite — see `transcript.ts` for why the chat log needs
 *  one and the rest of the app doesn't. */
export function appendTextFile(path: string, contents: string): Promise<void> {
  return invoke("append_text_file", { path, contents });
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
