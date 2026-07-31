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
