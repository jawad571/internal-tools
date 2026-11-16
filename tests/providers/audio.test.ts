import { describe, expect, it } from 'vitest';
import { chunkText } from '../../src/providers/tts/chunk.ts';
import { concatMp3, id3v2Length, mp3DurationSeconds, parseFrameHeader } from '../../src/providers/tts/mp3.ts';

/** ID3v2.4 tag with a synchsafe size. */
function id3(payloadBytes: number): Buffer {
  const h = Buffer.alloc(10 + payloadBytes);
  h.write('ID3', 0, 'latin1');
  h[3] = 4;
  h[6] = (payloadBytes >> 21) & 0x7f;
  h[7] = (payloadBytes >> 14) & 0x7f;
  h[8] = (payloadBytes >> 7) & 0x7f;
  h[9] = payloadBytes & 0x7f;
  // Payload deliberately contains a fake sync word that must not be counted.
  h[20] = 0xff;
  h[21] = 0xfb;
  return h;
}

/** One MPEG frame with the given header bytes 1-3; body zeroed (or tagged Xing). */
function frame(b1: number, b2: number, b3: number, xing = false): Buffer {
  const header = Buffer.from([0xff, b1, b2, b3]);
  const h = parseFrameHeader(header, 0)!;
  const f = Buffer.alloc(h.frameLength);
  header.copy(f);
  if (xing) f.write('Xing', h.sideInfoEnd, 'latin1');
  return f;
}

// MPEG-1 Layer III, 44.1 kHz, joint stereo; bitrate index 9 = 128 kbps, 5 = 64 kbps, 14 = 320 kbps
const MP3_128 = () => frame(0xfb, 0x90, 0x44);
const MP3_64 = () => frame(0xfb, 0x50, 0x44);
const MP3_320 = () => frame(0xfb, 0xe2, 0x44); // with padding bit

describe('mp3 duration', () => {
  it('parses frame header fields', () => {
    const h = parseFrameHeader(Buffer.from([0xff, 0xfb, 0x90, 0x44]), 0)!;
    expect(h).toMatchObject({ frameLength: 417, samples: 1152, sampleRate: 44100 });
    expect(parseFrameHeader(Buffer.from([0xff, 0xfb, 0xf0, 0x44]), 0)).toBeNull(); // bad bitrate
    expect(parseFrameHeader(Buffer.from([0xff, 0xfb, 0x9c, 0x44]), 0)).toBeNull(); // reserved sample rate
  });

  it('measures a CBR stream behind an ID3v2 tag', () => {
    const frames = 1000;
    const buf = Buffer.concat([id3(200), ...Array.from({ length: frames }, MP3_128)]);
    expect(id3v2Length(buf)).toBe(210);
    expect(mp3DurationSeconds(buf)).toBeCloseTo((frames * 1152) / 44100, 6); // ~26.12 s
  });

  it('measures VBR by summing frames and ignores the Xing info frame', () => {
    const body = Array.from({ length: 300 }, (_, i) => [MP3_64, MP3_128, MP3_320][i % 3]!());
    const buf = Buffer.concat([frame(0xfb, 0x90, 0x44, true), ...body]);
    expect(mp3DurationSeconds(buf)).toBeCloseTo((300 * 1152) / 44100, 6);
  });

  it('handles MPEG-2 Layer III (576 samples per frame), junk and an ID3v1 trailer', () => {
    // MPEG-2, Layer III, 24 kHz (sr index 1), 64 kbps (index 8)
    const f = () => frame(0xf3, 0x84, 0xc4);
    const tag = Buffer.alloc(128);
    tag.write('TAG', 0, 'latin1');
    const buf = Buffer.concat([Buffer.from('junk!'), ...Array.from({ length: 100 }, f), tag]);
    expect(mp3DurationSeconds(buf)).toBeCloseTo((100 * 576) / 24000, 6);
  });

  it('concatenation drops later ID3 tags and durations add up', () => {
    const a = Buffer.concat([id3(50), ...Array.from({ length: 40 }, MP3_128)]);
    const b = Buffer.concat([id3(50), ...Array.from({ length: 60 }, MP3_128)]);
    const joined = concatMp3([a, b]);
    expect(joined.length).toBe(a.length + b.length - 60);
    expect(mp3DurationSeconds(joined)).toBeCloseTo((100 * 1152) / 44100, 6);
  });

  it('returns 0 for non-audio', () => {
    expect(mp3DurationSeconds(Buffer.from('hello world'))).toBe(0);
  });
});

describe('chunkText', () => {
  const sentences = Array.from({ length: 60 }, (_, i) => `This is sentence number ${i + 1}, which talks about the news.`);
  const text = sentences.join(' ');

  it('never splits a sentence and respects the limit', () => {
    const chunks = chunkText(text, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(300);
      expect(c).toMatch(/^This is sentence number \d+,.*news\.$/);
    }
    expect(chunks.join(' ')).toBe(text);
  });

  it('keeps short text in one chunk and collapses whitespace', () => {
    expect(chunkText('Hello there.\n\n  General Kenobi.', 1000)).toEqual(['Hello there. General Kenobi.']);
    expect(chunkText('   ', 100)).toEqual([]);
  });

  it('breaks an over-long sentence at word boundaries only as a last resort', () => {
    const long = `Word ${'word '.repeat(200).trim()}.`;
    const chunks = chunkText(`Short one. ${long} Short two.`, 100);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks[0]).toBe('Short one.');
    expect(chunks.every((c) => !/wor$|^rd/.test(c))).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(`Short one. ${long} Short two.`);
  });
});
