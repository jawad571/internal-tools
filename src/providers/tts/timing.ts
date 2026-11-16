import type { SpeechAlignment } from '../../shared/deps.ts';

/** Native character timings for one synthesized chunk, relative to the chunk's own start. */
export interface ChunkAlignment {
  characters: string[];
  startSeconds: number[];
  endSeconds: number[];
}

/**
 * Even per-character timings across a chunk, for providers without timestamps. Crude per
 * character, but accurate at chunk boundaries (each chunk's duration is measured), which is
 * what bounds the error for a multi-chunk bulletin.
 */
export function estimateChunkAlignment(text: string, durationSeconds: number): ChunkAlignment {
  const characters = Array.from(text);
  const n = Math.max(1, characters.length);
  const step = durationSeconds / n;
  return {
    characters,
    startSeconds: characters.map((_, i) => i * step),
    endSeconds: characters.map((_, i) => (i + 1) * step),
  };
}

/** Joins per-chunk alignments into one timeline, offsetting each chunk by the durations before it. */
export function joinAlignments(
  parts: Array<{ alignment: ChunkAlignment; durationSeconds: number }>,
  measured: boolean,
): SpeechAlignment {
  const out: SpeechAlignment = { characters: [], startSeconds: [], endSeconds: [], measured };
  let offset = 0;
  for (const { alignment: a, durationSeconds } of parts) {
    const n = Math.min(a.characters.length, a.startSeconds.length, a.endSeconds.length);
    for (let i = 0; i < n; i++) {
      out.characters.push(a.characters[i]!);
      out.startSeconds.push(offset + a.startSeconds[i]!);
      out.endSeconds.push(offset + a.endSeconds[i]!);
    }
    offset += durationSeconds;
  }
  return out;
}
