import { describe, expect, it } from 'vitest';
import { segmentTimeline } from '../../src/pipeline/timeline.ts';
import { chunkText } from '../../src/providers/tts/chunk.ts';
import { estimateChunkAlignment, joinAlignments } from '../../src/providers/tts/timing.ts';
import { joinSegments, type ScriptSegment, type SpeechAlignment } from '../../src/shared/deps.ts';

const segs: ScriptSegment[] = [
  { articleId: null, text: 'Hello Ada.' }, // 9 non-space chars
  { articleId: 'a1', text: 'First story here.' }, // 15
  { articleId: 'a2', text: 'Second  story,\nlonger.' }, // 19
  { articleId: null, text: 'Bye.' }, // 4
];

/** Alignment over `text` with one char per `step` seconds, plus `pauses` (seconds) inserted before given char indices. */
function alignmentFor(text: string, step: number, pauses: Record<number, number> = {}): SpeechAlignment {
  const characters = Array.from(text);
  let t = 0;
  const startSeconds: number[] = [];
  const endSeconds: number[] = [];
  characters.forEach((_, i) => {
    t += pauses[i] ?? 0;
    startSeconds.push(t);
    t += step;
    endSeconds.push(t);
  });
  return { characters, startSeconds, endSeconds, measured: true };
}

describe('segmentTimeline', () => {
  it('uses measured character timings: each segment starts at its first spoken character', () => {
    // What the TTS provider actually received: whitespace collapsed by chunkText.
    const spoken = chunkText(joinSegments(segs), 10_000).join(' ');
    expect(spoken).toBe('Hello Ada. First story here. Second story, longer. Bye.');
    const firstOf = (s: string) => spoken.indexOf(s);
    // A 0.8 s pause before "First" and 0.5 s before "Bye".
    const al = alignmentFor(spoken, 0.1, { [firstOf('First')]: 0.8, [firstOf('Bye')]: 0.5 });
    const duration = al.endSeconds.at(-1)! + 0.3;
    const tl = segmentTimeline(segs, al, duration);

    expect(tl.map((s) => s.articleId)).toEqual([null, 'a1', 'a2', null]);
    expect(tl[0]!.start).toBe(0);
    expect(tl[1]!.start).toBeCloseTo(al.startSeconds[firstOf('First')]!, 3);
    expect(tl[2]!.start).toBeCloseTo(al.startSeconds[firstOf('Second')]!, 3);
    expect(tl[3]!.start).toBeCloseTo(al.startSeconds[firstOf('Bye')]!, 3);
    // Contiguous, covering the whole audio; the pause before a story belongs to the previous one.
    for (let i = 1; i < tl.length; i++) expect(tl[i]!.start).toBe(tl[i - 1]!.end);
    expect(tl.at(-1)!.end).toBeCloseTo(duration, 3);
    expect(tl[0]!.end).toBeGreaterThan(al.endSeconds[firstOf('Ada.') + 3]! + 0.7);
  });

  it('falls back to proportional-by-characters over the duration with no alignment', () => {
    const tl = segmentTimeline(segs, undefined, 47);
    // 9 + 15 + 19 + 4 = 47 non-space chars → 1 s per char.
    expect(tl).toEqual([
      { articleId: null, start: 0, end: 9 },
      { articleId: 'a1', start: 9, end: 24 },
      { articleId: 'a2', start: 24, end: 43 },
      { articleId: null, start: 43, end: 47 },
    ]);
  });

  it('maps proportionally onto the alignment when the provider normalised the text', () => {
    // Provider spelled things out: twice as many characters as the script, evenly spaced over 10 s.
    const al = alignmentFor('x'.repeat(94), 10 / 94);
    const tl = segmentTimeline(segs, al, 10);
    expect(tl[1]!.start).toBeCloseTo((10 * 9) / 47, 1);
    expect(tl[3]!.start).toBeCloseTo((10 * 43) / 47, 1);
    expect(tl.at(-1)!.end).toBe(10);
  });

  it('offsets multi-chunk estimates by each chunk’s measured duration', () => {
    // Chunk 1 ("Hello Ada. First story here.") ran 6 s; chunk 2 ran 2 s.
    const chunks = ['Hello Ada. First story here.', 'Second story, longer. Bye.'];
    const al = joinAlignments(
      [
        { alignment: estimateChunkAlignment(chunks[0]!, 6), durationSeconds: 6 },
        { alignment: estimateChunkAlignment(chunks[1]!, 2), durationSeconds: 2 },
      ],
      false,
    );
    expect(al.measured).toBe(false);
    const tl = segmentTimeline(segs, al, 8);
    // "Second" is the first char of chunk 2, so it starts exactly at the 6 s chunk boundary...
    expect(tl[2]!.start).toBe(6);
    // ...and inside a chunk the estimate is proportional to character position.
    expect(tl[1]!.start).toBeCloseTo((6 * chunks[0]!.indexOf('First')) / chunks[0]!.length, 3);
    expect(tl[3]!.start).toBeCloseTo(6 + (2 * chunks[1]!.indexOf('Bye')) / chunks[1]!.length, 3);
    expect(tl.at(-1)!.end).toBe(8);
  });

  it('handles a single segment and empty input', () => {
    expect(segmentTimeline([{ articleId: null, text: 'Hi.' }], undefined, 3.21)).toEqual([{ articleId: null, start: 0, end: 3.21 }]);
    expect(segmentTimeline([], undefined, 3)).toEqual([]);
  });
});

describe('segmentTimeline with Urdu', () => {
  // Real-world Urdu: zer/pesh diacritics (بِلکُل), precomposed آ and ئ, a zero-width non-joiner
  // (U+200C) inside a word, Urdu punctuation (، ۔), and a Latin source name mid-sentence.
  const ZWNJ = '‌';
  const urdu: ScriptSegment[] = [
    { articleId: null, text: 'السلام علیکم عائشہ، آج کی خبریں۔' },
    { articleId: 'a1', text: `پہلی خبر، BBC کے مطابق شہر میں بِلکُل نئی ٹرین${ZWNJ}سروس شروع ہو گئی ہے۔` },
    { articleId: 'a2', text: 'اب اگلی خبر: آئندہ ہفتے بارش کا امکان ہے۔' },
    { articleId: null, text: 'اللہ حافظ۔' },
  ];
  const spoken = chunkText(joinSegments(urdu), 10_000).join(' ');
  /** Code-point index of the first occurrence of `s` in the spoken text. */
  const firstOf = (s: string) => Array.from(spoken.slice(0, spoken.indexOf(s))).length;

  /** One alignment entry per element of `entries`, with a pause before the given entry indices. */
  function alignmentOver(entries: string[], pauses: Record<number, number> = {}): SpeechAlignment {
    let t = 0;
    const startSeconds: number[] = [];
    const endSeconds: number[] = [];
    entries.forEach((_, i) => {
      t += pauses[i] ?? 0;
      startSeconds.push(t);
      t += 0.05;
      endSeconds.push(t);
    });
    return { characters: entries, startSeconds, endSeconds, measured: true };
  }

  const expectStartsAt = (tl: ReturnType<typeof segmentTimeline>, al: SpeechAlignment, entryIdx: number[]) => {
    expect(tl.map((s) => s.articleId)).toEqual([null, 'a1', 'a2', null]);
    expect(tl[0]!.start).toBe(0);
    entryIdx.forEach((idx, k) => expect(tl[k + 1]!.start).toBeCloseTo(al.startSeconds[idx]!, 3));
    for (let i = 1; i < tl.length; i++) expect(tl[i]!.start).toBe(tl[i - 1]!.end);
  };

  it('chunks on Urdu full stops', () => {
    expect(chunkText(joinSegments(urdu), 60).every((c) => c.endsWith('۔') || c.length >= 55)).toBe(true);
    expect(chunkText(joinSegments(urdu), 60).length).toBeGreaterThan(2);
  });

  it('is exact with one alignment entry per code point (marks and ZWNJ as their own entries)', () => {
    const chars = Array.from(spoken);
    const starts = [firstOf('پہلی'), firstOf('اب اگلی'), firstOf('اللہ حافظ')];
    const al = alignmentOver(chars, { [starts[0]!]: 0.6, [starts[2]!]: 0.4 });
    const tl = segmentTimeline(urdu, al, al.endSeconds.at(-1)! + 0.2);
    expectStartsAt(tl, al, starts);
    expect(tl.at(-1)!.end).toBeCloseTo(al.endSeconds.at(-1)! + 0.2, 3);
  });

  it('is exact when the provider merges marks into graphemes and drops the ZWNJ', () => {
    // e.g. ["بِ", "ل", ...]: grapheme clusters, no format characters.
    const graphemes = [...new Intl.Segmenter('ur', { granularity: 'grapheme' }).segment(spoken.replaceAll(ZWNJ, ''))].map((g) => g.segment);
    const idxOf = (s: string) => graphemes.findIndex((_, i) => graphemes.slice(i).join('').startsWith(s));
    const starts = [idxOf('پہلی'), idxOf('اب اگلی'), idxOf('اللہ حافظ')];
    expect(starts.every((i) => i > 0)).toBe(true);
    const al = alignmentOver(graphemes);
    const tl = segmentTimeline(urdu, al, al.endSeconds.at(-1)!);
    expectStartsAt(tl, al, starts);
  });

  it('is exact when the provider strips diacritics and decomposes precomposed letters', () => {
    // آ -> ا + U+0653, ئ -> ی-like base + U+0654; zer/pesh removed; one entry per code point.
    const normalised = Array.from(spoken.normalize('NFD').replace(/[ً-ْ]/g, ''));
    const at = (s: string) => {
      const prefix = spoken.slice(0, spoken.indexOf(s));
      return Array.from(prefix.normalize('NFD').replace(/[ً-ْ]/g, '')).length;
    };
    const starts = [at('پہلی'), at('اب اگلی'), at('اللہ حافظ')];
    const al = alignmentOver(normalised);
    const tl = segmentTimeline(urdu, al, al.endSeconds.at(-1)!);
    expectStartsAt(tl, al, starts);
  });

  describe('hamza forms, shadda and presentation forms', () => {
    // ۂ (U+06C2), أ (U+0623), ئ (U+0626) all decompose under NFD into a base letter + hamza above;
    // ّ (shadda, U+0651) and ٰ (superscript alef, U+0670) are combining marks; ﻻ (U+FEFB) and
    // ﷲ (U+FDF2) are presentation-form ligatures.
    const tricky: ScriptSegment[] = [
      { articleId: null, text: 'السلام علیکم، خبرنامۂ شام۔' },
      { articleId: 'a1', text: 'أمریکہ میں مسئلۂ تجارت پر بحث، شدّت سے جاری ہے۔ ﻻہور میں ﷲ کا شکر۔' },
      { articleId: 'a2', text: 'رحمٰن نے کہا کہ آئندہ ہفتے فیصلہ ہوگا۔' },
      { articleId: null, text: 'اللہ حافظ۔' },
    ];
    const text = chunkText(joinSegments(tricky), 10_000).join(' ');
    /** Alignment entries for `entries`, where entry index i is the i-th element; returns entry index of `s` too. */
    const build = (entries: string[]) => {
      const joined = (k: number) => entries.slice(k).join('');
      const idxOf = (s: string) => entries.findIndex((_, k) => joined(k).startsWith(s));
      return { al: alignmentOver(entries), idxOf };
    };
    const expectStarts = (entries: string[], first: [string, string, string]) => {
      const { al, idxOf } = build(entries);
      const starts = first.map(idxOf);
      expect(starts.every((i) => i > 0)).toBe(true);
      const tl = segmentTimeline(tricky, al, al.endSeconds.at(-1)!);
      expect(tl.map((s) => s.articleId)).toEqual([null, 'a1', 'a2', null]);
      starts.forEach((idx, k) => expect(tl[k + 1]!.start).toBeCloseTo(al.startSeconds[idx]!, 3));
    };

    it('is exact with precomposed code points as sent', () => {
      expectStarts(Array.from(text), ['أمریکہ', 'رحمٰن', 'اللہ حافظ']);
    });

    it('is exact when the provider decomposes hamza forms (NFD), one entry per code point', () => {
      const nfd = text.normalize('NFD');
      expect(nfd.length).toBeGreaterThan(text.length); // the hamza forms really do split
      expectStarts(Array.from(nfd), ['أمریکہ'.normalize('NFD'), 'رحمٰن'.normalize('NFD'), 'اللہ حافظ']);
    });

    it('is exact when the provider expands presentation-form ligatures (NFKC)', () => {
      const nfkc = text.normalize('NFKC');
      expect(nfkc).not.toContain('ﻻ');
      expectStarts(Array.from(nfkc), ['أمریکہ', 'رحمٰن', 'اللہ حافظ']);
    });

    it('a one-character mismatch moves boundaries by at most a character, not a whole story', () => {
      // The provider dropped one base letter, so counts differ by one and the proportional mapping is used.
      const chars = Array.from(text);
      const drop = chars.indexOf('ش');
      const entries = [...chars.slice(0, drop), ...chars.slice(drop + 1)];
      const { al, idxOf } = build(entries);
      const tl = segmentTimeline(tricky, al, al.endSeconds.at(-1)!);
      [idxOf('أمریکہ'), idxOf('رحمٰن'), idxOf('اللہ حافظ')].forEach((idx, k) =>
        expect(Math.abs(tl[k + 1]!.start - al.startSeconds[idx]!)).toBeLessThanOrEqual(0.05 + 1e-9),
      );
    });
  });

  it('stays contiguous and ordered when the provider rewrote the text (proportional fallback)', () => {
    const al = alignmentOver(Array.from('ا'.repeat(500)));
    const tl = segmentTimeline(urdu, al, 25);
    expect(tl.map((s) => s.articleId)).toEqual([null, 'a1', 'a2', null]);
    for (let i = 1; i < tl.length; i++) {
      expect(tl[i]!.start).toBe(tl[i - 1]!.end);
      expect(tl[i]!.start).toBeGreaterThan(tl[i - 1]!.start);
    }
    expect(tl.at(-1)!.end).toBe(25);
  });
});
