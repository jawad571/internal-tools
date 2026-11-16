import type { EditionSegment } from '../db/schema.ts';
import type { ScriptSegment, SpeechAlignment } from '../shared/deps.ts';

/**
 * Characters that count as spoken units: everything but whitespace, combining marks (Urdu
 * zer/zabar/pesh, hamza above, Hindi matras…) and format characters (zero-width non-joiner/joiner,
 * direction marks). Decomposed first (NFKD), so آ / ئ / ۂ / أ count the same whether the script or
 * the provider's alignment uses the precomposed or the base-plus-mark form, Arabic presentation
 * forms and ligatures (ﻻ, ﷲ) count as the letters they stand for, and a mark counts the same
 * whether the provider reports it as its own entry or together with its letter.
 */
const BASE_EXCLUDED = /[\s\p{M}\p{Cf}]/u;
const baseUnits = (s: string) => Array.from(s.normalize('NFKD')).filter((c) => !BASE_EXCLUDED.test(c)).length;
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Turns script segments + speech alignment into a contiguous timeline covering [0, duration].
 *
 * Matching is on base characters (see baseUnits), because providers normalise whitespace (chunking
 * collapses it, and the paragraph breaks between segments are not spoken) and may split or merge
 * combining marks differently from the script. Each segment starts
 * when its first character is spoken; any pause before it belongs to the previous segment.
 * If the alignment's character count doesn't match the script (a provider normalised the text),
 * positions are mapped proportionally onto the alignment instead; with no alignment at all,
 * proportionally onto the duration.
 */
export function segmentTimeline(segments: ScriptSegment[], alignment: SpeechAlignment | undefined, duration: number): EditionSegment[] {
  if (!segments.length) return [];
  const counts = segments.map((s) => baseUnits(s.text));
  const total = counts.reduce((a, b) => a + b, 0);

  const starts: number[] = [];
  if (alignment) {
    for (let i = 0; i < alignment.characters.length; i++) {
      // An entry may hold a whole grapheme (letter + marks) or a lone mark; count its base units.
      const n = baseUnits(alignment.characters[i]!);
      for (let k = 0; k < n; k++) starts.push(alignment.startSeconds[i]!);
    }
  }

  const timeAt = (charIndex: number): number => {
    if (!total) return 0;
    if (!starts.length) return (duration * charIndex) / total;
    const idx = starts.length === total ? charIndex : Math.round((charIndex * starts.length) / total);
    return idx >= starts.length ? duration : starts[idx]!;
  };

  const bounds = [0];
  let cum = 0;
  for (let i = 1; i < segments.length; i++) {
    cum += counts[i - 1]!;
    const prev = bounds[i - 1]!;
    bounds.push(Math.min(duration, Math.max(prev, timeAt(cum))));
  }
  bounds.push(duration);
  return segments.map((s, i) => ({ articleId: s.articleId, start: round(bounds[i]!), end: round(bounds[i + 1]!) }));
}
