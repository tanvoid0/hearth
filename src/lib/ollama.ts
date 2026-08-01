import { invoke, Channel } from "@tauri-apps/api/core";
import { EMPTY_PULL, reducePull, type PullState } from "./pull";

export interface ToolCall {
  function: { name: string; arguments: unknown };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ModelInfo {
  name: string;
  sizeGb: number;
}

/** Ollama's own default is 4096; 8192 is the smallest window that comfortably
 *  holds a system prompt, a file read and a few tool results. */
export const DEFAULT_NUM_CTX = 8192;

// The agent panel owns these controls; anything else that needs a one-off model
// call reads the same keys rather than growing a second source of truth.
export const MODEL_KEY = "hearth.model";
export const CTX_KEY = "hearth.numCtx";

export function currentModel(): string {
  return localStorage.getItem(MODEL_KEY) ?? "";
}

export function currentNumCtx(): number {
  return Number(localStorage.getItem(CTX_KEY)) || DEFAULT_NUM_CTX;
}

export async function listModels(): Promise<ModelInfo[]> {
  const data = await invoke<{ models?: Array<{ name: string; size: number }> }>("ollama_models");
  return (data.models ?? [])
    .map((m) => ({ name: m.name, sizeGb: m.size / 1e9 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface LoadedModel {
  name: string;
  sizeGb: number;
  /** Share of the model resident in VRAM. Below 100 means CPU is doing part of
   *  the work, which is the difference between a 20-second step and a 5-minute
   *  one — the 16 GB cliff, visible. */
  gpuPercent: number;
  /** What `num_ctx` actually resolved to, which also moves where a model lands
   *  relative to that cliff: the KV cache comes out of the same VRAM. */
  contextLength: number;
}

/**
 * Download a model, reporting progress as it goes. Resolves when the stream
 * ends — check `error` on the last state, since Ollama answers a bad model name
 * with a 200 and an error in the body rather than a failed request.
 */
export async function pullModel(name: string, onState: (state: PullState) => void): Promise<void> {
  let state = EMPTY_PULL;
  const onChunk = new Channel<string>();
  onChunk.onmessage = (line) => {
    try {
      state = reducePull(state, JSON.parse(line));
    } catch {
      return; // framing is Rust's job; a malformed line shouldn't abort a multi-GB download
    }
    onState(state);
  };
  await invoke("ollama_pull", { model: name, onChunk });
}

/** Free a model's VRAM now instead of waiting out Ollama's idle timeout. */
export async function unloadModel(name: string): Promise<void> {
  await invoke("ollama_unload", { model: name });
}

/** Total VRAM in GB, or null when it can't be determined (no NVIDIA GPU, or
 *  no driver). Capacity only — see the Rust side for why there's no attempt to
 *  predict a model's footprint from its size on disk. */
export async function totalVramGb(): Promise<number | null> {
  return invoke<number | null>("gpu_total_vram_gb").catch(() => null);
}

/** How busy the GPU is right now, 0–100, or null when it can't be determined.
 *  Not the same number as `LoadedModel.gpuPercent`, which is how much of the
 *  model sits in VRAM — a model can be 100% resident and the card idle. */
export async function gpuUtilizationPct(): Promise<number | null> {
  return invoke<number | null>("gpu_utilization_pct").catch(() => null);
}

/** The loaded model matching `name`, or null if Ollama has nothing loaded for
 *  it — models unload on their own after a few idle minutes. */
export async function loadedModel(name: string): Promise<LoadedModel | null> {
  const data = await invoke<{
    models?: Array<{ name: string; size: number; size_vram: number; context_length?: number }>;
  }>("ollama_ps");
  const m = (data.models ?? []).find((x) => x.name === name);
  if (!m) return null;
  return {
    name: m.name,
    sizeGb: m.size / 1e9,
    gpuPercent: m.size > 0 ? Math.round((m.size_vram / m.size) * 100) : 0,
    contextLength: m.context_length ?? 0,
  };
}

interface ChunkPayload {
  message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] };
  error?: string;
  done?: boolean;
}

/**
 * One streamed model turn. Text arrives via `onToken` as it's generated — a
 * model too big for VRAM falls back to CPU and takes minutes, so partial
 * output is the only signal the app isn't hung. Resolves with the assembled
 * assistant message.
 */
export async function chat(
  model: string,
  messages: ChatMessage[],
  tools: readonly unknown[],
  onToken: (text: string) => void,
  numCtx = DEFAULT_NUM_CTX,
  /** Names this call so `cancelChat` can abort it. Empty means uncancellable,
   *  which is only right for a caller that has no Stop button. */
  cancelId = ""
): Promise<ChatMessage> {
  let content = "";
  const toolCalls: ToolCall[] = [];
  let streamError: string | undefined;

  const onChunk = new Channel<string>();
  onChunk.onmessage = (line) => {
    let chunk: ChunkPayload;
    try {
      chunk = JSON.parse(line);
    } catch {
      return; // framing is Rust's job; a malformed line is not worth aborting a multi-minute turn
    }
    if (chunk.error) {
      streamError = chunk.error;
      return;
    }
    const piece = chunk.message?.content ?? "";
    if (piece) {
      content += piece;
      onToken(piece);
    }
    if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
  };

  await invoke("ollama_chat", {
    id: cancelId,
    body: { model, messages, tools, stream: true, options: { num_ctx: numCtx } },
    onChunk,
  });

  if (streamError) throw new Error(streamError);
  return { role: "assistant", content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) };
}

/** What a cancelled call rejects with — matched, not displayed, so a deliberate
 *  Stop doesn't surface as a model failure. Must match `CANCELLED` in lib.rs. */
export const CANCELLED = "cancelled";

/**
 * Abort an in-flight call by the id it was started with.
 *
 * The Stop button used to only take effect between steps, which is no help at
 * all in the case it exists for: a model that spilled to CPU spends minutes
 * inside one call. This drops the request itself, so Ollama stops generating
 * rather than generating into a void.
 */
export async function cancelChat(cancelId: string): Promise<void> {
  await invoke("ollama_cancel", { id: cancelId }).catch(() => {
    // Nothing in flight under that id — already finished, or never started.
  });
}
