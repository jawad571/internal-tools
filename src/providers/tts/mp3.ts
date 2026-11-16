/**
 * MPEG audio duration by walking frame headers. Every frame is counted, so CBR, VBR and
 * concatenated streams (which carry stale Xing headers mid-stream) are all measured exactly.
 */

// kbps, indexed [versionGroup][layer][bitrateIndex]; versionGroup 0 = MPEG-1, 1 = MPEG-2/2.5; layer 1..3
const BITRATES: number[][][] = [
  [
    [],
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  [
    [],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
];
// indexed by the 2-bit version field: 0 = MPEG-2.5, 2 = MPEG-2, 3 = MPEG-1
const SAMPLE_RATES: Record<number, number[]> = { 0: [11025, 12000, 8000], 2: [22050, 24000, 16000], 3: [44100, 48000, 32000] };

export interface FrameHeader {
  frameLength: number;
  samples: number;
  sampleRate: number;
  /** Offset of the Xing/Info tag inside the frame, for Layer III. */
  sideInfoEnd: number;
}

export function parseFrameHeader(buf: Buffer, i: number): FrameHeader | null {
  if (i + 4 > buf.length) return null;
  const b1 = buf[i + 1]!;
  const b2 = buf[i + 2]!;
  const b3 = buf[i + 3]!;
  if (buf[i] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3;
  const layerBits = (b1 >> 1) & 3;
  const brIndex = b2 >> 4;
  const srIndex = (b2 >> 2) & 3;
  if (version === 1 || layerBits === 0 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const layer = 4 - layerBits;
  const v1 = version === 3;
  const bitrate = BITRATES[v1 ? 0 : 1]![layer]![brIndex]! * 1000;
  const sampleRate = SAMPLE_RATES[version]![srIndex]!;
  const padding = (b2 >> 1) & 1;
  const mono = b3 >> 6 === 3;
  let frameLength: number;
  let samples: number;
  if (layer === 1) {
    frameLength = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
    samples = 384;
  } else {
    samples = layer === 3 && !v1 ? 576 : 1152;
    frameLength = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  }
  const sideInfoEnd = 4 + (v1 ? (mono ? 17 : 32) : mono ? 9 : 17);
  return { frameLength, samples, sampleRate, sideInfoEnd };
}

/** Byte length of a leading ID3v2 tag (0 if none). */
export function id3v2Length(buf: Buffer): number {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  const footer = buf[5]! & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

function isInfoFrame(buf: Buffer, i: number, h: FrameHeader): boolean {
  const tag = buf.toString('latin1', i + h.sideInfoEnd, i + h.sideInfoEnd + 4);
  return tag === 'Xing' || tag === 'Info' || buf.toString('latin1', i + 36, i + 40) === 'VBRI';
}

export function mp3DurationSeconds(buf: Buffer): number {
  let i = id3v2Length(buf);
  let seconds = 0;
  let synced = false;
  while (i + 4 <= buf.length) {
    const h = parseFrameHeader(buf, i);
    // Before the first frame, require a second valid header right after to avoid false syncs in junk.
    if (!h || (!synced && i + h.frameLength + 4 <= buf.length && !parseFrameHeader(buf, i + h.frameLength))) {
      if (buf.toString('latin1', i, i + 3) === 'TAG' && buf.length - i === 128) break; // ID3v1 trailer
      i++;
      continue;
    }
    synced = true;
    if (i + h.frameLength > buf.length) break; // truncated final frame
    if (!isInfoFrame(buf, i, h)) seconds += h.samples / h.sampleRate;
    i += h.frameLength;
  }
  return seconds;
}

/** Concatenates MP3 chunks, dropping ID3v2 tags from all but the first. */
export const concatMp3 = (chunks: Buffer[]) =>
  Buffer.concat(chunks.map((c, n) => (n === 0 ? c : c.subarray(id3v2Length(c)))));
