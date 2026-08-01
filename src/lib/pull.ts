// Progress accounting for `ollama pull`, kept import-free (like runlog.ts and
// edit.ts) so `npm test` can exercise it on plain node.

export interface PullChunk {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

export interface PullState {
  /** Bytes per layer, keyed by digest. Ollama reports progress per *layer*,
   *  not for the download as a whole, so a percent read straight off a chunk
   *  restarts at zero every time a new layer begins. */
  layers: Record<string, { total: number; completed: number }>;
  status: string;
  done: boolean;
  error?: string;
}

export const EMPTY_PULL: PullState = { layers: {}, status: "", done: false };

export function reducePull(state: PullState, chunk: PullChunk): PullState {
  // A bad model name comes back as an error chunk on a 200 response, not as a
  // failed request — so it has to be read out of the stream.
  if (chunk.error) return { ...state, status: chunk.error, error: chunk.error, done: true };
  return {
    layers:
      chunk.digest && chunk.total
        ? { ...state.layers, [chunk.digest]: { total: chunk.total, completed: chunk.completed ?? 0 } }
        : state.layers,
    status: chunk.status ?? state.status,
    done: chunk.status === "success",
    error: state.error,
  };
}

/**
 * Overall percent across every layer announced so far, or null before any has
 * declared a size.
 *
 * Layers are announced as they start, so early on this is a percentage of less
 * than the full download and can appear to move backwards when a new one joins.
 * That's the same behaviour `ollama pull` shows on the command line, and it
 * beats the alternative of a bar that resets to zero several times.
 */
export function pullPercent(state: PullState): number | null {
  const layers = Object.values(state.layers);
  if (layers.length === 0) return null;
  const total = layers.reduce((n, l) => n + l.total, 0);
  const done = layers.reduce((n, l) => n + l.completed, 0);
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
}
