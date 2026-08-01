import { invoke, Channel } from "@tauri-apps/api/core";

/**
 * Session ids are names, not handles, and user tabs are namespaced so the
 * manager stays open to sessions that aren't the user's. Plan §4.3 wants the
 * agent isolated from this shell — `run_command` does that with a separate
 * piped process instead of a PTY, because a model reading test output wants
 * plain text rather than colour and progress-bar escapes.
 */
export const userPty = (n: number) => `user:${n}`;

export interface CommandResult {
  exit_code: number;
  output: string;
  timed_out: boolean;
}

/** Run one program in `cwd`. The allowlist that governs what's permitted lives
 *  in Rust, so a frontend mistake can't widen it. */
export function runCommand(cwd: string, command: string, timeoutSecs: number): Promise<CommandResult> {
  return invoke("run_command", { cwd, command, timeoutSecs });
}

export async function ptyOpen(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  onData: (chunk: string) => void,
): Promise<void> {
  const channel = new Channel<string>();
  channel.onmessage = onData;
  await invoke("pty_open", { id, cwd, cols, rows, onData: channel });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export function ptyClose(id: string): Promise<void> {
  return invoke("pty_close", { id });
}
