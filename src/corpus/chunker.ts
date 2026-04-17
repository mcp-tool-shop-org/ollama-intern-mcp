/**
 * Deterministic fixed-window chunker with overlap.
 *
 * Keep it simple and boring for v1 — paragraph-aware splitting is a
 * future win; for now, character windows are predictable, easy to test,
 * and fine for memory-sized corpora.
 */

export interface Chunk {
  index: number;
  char_start: number;
  char_end: number;
  text: string;
}

export interface ChunkOptions {
  chunk_chars: number;
  chunk_overlap: number;
}

export const DEFAULT_CHUNK: ChunkOptions = {
  chunk_chars: 800,
  chunk_overlap: 100,
};

export function chunk(text: string, opts: ChunkOptions = DEFAULT_CHUNK): Chunk[] {
  const size = Math.max(100, opts.chunk_chars);
  const overlap = Math.min(opts.chunk_overlap, Math.floor(size / 2));
  if (text.length === 0) return [];
  if (text.length <= size) {
    return [{ index: 0, char_start: 0, char_end: text.length, text }];
  }
  const out: Chunk[] = [];
  const step = size - overlap;
  let cursor = 0;
  let i = 0;
  while (cursor < text.length) {
    const end = Math.min(cursor + size, text.length);
    out.push({
      index: i,
      char_start: cursor,
      char_end: end,
      text: text.slice(cursor, end),
    });
    if (end === text.length) break;
    cursor += step;
    i += 1;
  }
  return out;
}
