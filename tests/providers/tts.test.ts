import { describe, expect, it } from 'vitest';
import { ElevenLabsTts } from '../../src/providers/tts/elevenlabs.ts';
import { MockTts } from '../../src/providers/tts/mock.ts';
import { parseFrameHeader } from '../../src/providers/tts/mp3.ts';
import { OpenAiTts } from '../../src/providers/tts/openai.ts';

/** A tiny valid MP3 body: `n` MPEG-1 L3 128 kbps frames. */
function mp3(n: number): Uint8Array<ArrayBuffer> {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x44]);
  const len = parseFrameHeader(header, 0)!.frameLength;
  return new Uint8Array(Buffer.concat(Array.from({ length: n }, () => Buffer.concat([header, Buffer.alloc(len - 4)]))));
}

const FRAME_S = 1152 / 44100;

function recordingFetch(respond: (body: Record<string, unknown>, n: number) => Response) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    calls.push({ url: String(url), headers: new Headers(init!.headers), body });
    return respond(body, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

const longText = Array.from({ length: 120 }, (_, i) => `Story sentence ${i} has a handful of words in it.`).join(' ');

describe('MockTts', () => {
  it('returns a valid WAV whose duration matches the word count', async () => {
    const tts = new MockTts(150);
    const res = await tts.synthesize({ text: Array(300).fill('word').join(' ') + '.', voiceId: 'mock-ava', tone: 'neutral' });
    expect(res.mime).toBe('audio/wav');
    expect(res.durationSeconds).toBeCloseTo(120, 1);
    expect(res.audio.toString('latin1', 0, 4)).toBe('RIFF');
    expect(res.audio.toString('latin1', 8, 12)).toBe('WAVE');
    expect(res.audio.readUInt32LE(40)).toBe(res.audio.length - 44);
    expect(res.audio.readUInt32LE(24)).toBe(8000);
    expect(tts.voices().length).toBeGreaterThanOrEqual(3);
    expect(tts.voices().map((v) => v.id)).toContain(tts.defaultVoiceId());
  });
});

describe('OpenAiTts', () => {
  it('chunks long text, keeps order, passes instructions, and measures concatenated mp3', async () => {
    const rec = recordingFetch((_b, n) => new Response(mp3(n * 10)));
    const tts = new OpenAiTts({ apiKey: 'sk-test', model: 'gpt-4o-mini-tts', fetch: rec.fn, concurrency: 2 });
    const res = await tts.synthesize({ text: longText.repeat(2), voiceId: 'nova', tone: 'calm', toneNote: 'no puns' });
    expect(rec.calls.length).toBeGreaterThan(1);
    const c = rec.calls[0]!;
    expect(c.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(c.headers.get('authorization')).toBe('Bearer sk-test');
    expect(c.body).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'nova', response_format: 'mp3' });
    expect(String(c.body.instructions)).toMatch(/slowly.*no puns/s);
    for (const call of rec.calls) expect(String(call.body.input).length).toBeLessThanOrEqual(4096);
    expect(rec.calls.map((x) => x.body.input).join(' ')).toBe(longText.repeat(2).replace(/\s+/g, ' ').trim());
    const frames = rec.calls.reduce((s, _x, i) => s + (i + 1) * 10, 0);
    expect(res.mime).toBe('audio/mpeg');
    expect(res.durationSeconds).toBeCloseTo(frames * FRAME_S, 6);
  });

  it('omits instructions for tts-1 models', async () => {
    const rec = recordingFetch(() => new Response(mp3(5)));
    await new OpenAiTts({ apiKey: 'k', model: 'tts-1-hd', fetch: rec.fn }).synthesize({ text: 'Hi.', voiceId: 'alloy', tone: 'warm' });
    expect(rec.calls[0]!.body.instructions).toBeUndefined();
  });

  it('retries 429/5xx then succeeds', async () => {
    const rec = recordingFetch((_b, n) => (n < 3 ? new Response('busy', { status: n === 1 ? 429 : 503 }) : new Response(mp3(3))));
    const tts = new OpenAiTts({ apiKey: 'k', model: 'gpt-4o-mini-tts', fetch: rec.fn, retry: { baseMs: 1 } });
    const res = await tts.synthesize({ text: 'Hello.', voiceId: 'alloy', tone: 'neutral' });
    expect(rec.calls).toHaveLength(3);
    expect(res.durationSeconds).toBeCloseTo(3 * FRAME_S, 6);
  });

  it('surfaces non-retryable errors clearly without retrying', async () => {
    const rec = recordingFetch(() => new Response('{"error":{"message":"bad voice"}}', { status: 400 }));
    const tts = new OpenAiTts({ apiKey: 'k', model: 'gpt-4o-mini-tts', fetch: rec.fn, retry: { baseMs: 1 } });
    await expect(tts.synthesize({ text: 'Hello.', voiceId: 'zzz', tone: 'neutral' })).rejects.toThrow(/OpenAI speech failed: HTTP 400.*bad voice/);
    expect(rec.calls).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    const rec = recordingFetch(() => new Response('down', { status: 500 }));
    const tts = new OpenAiTts({ apiKey: 'k', model: 'gpt-4o-mini-tts', fetch: rec.fn, retry: { baseMs: 1, attempts: 3 } });
    await expect(tts.synthesize({ text: 'Hello.', voiceId: 'alloy', tone: 'neutral' })).rejects.toThrow('HTTP 500');
    expect(rec.calls).toHaveLength(3);
  });
});

describe('ElevenLabsTts', () => {
  it('posts to the voice endpoint with tone-mapped settings and neighbour context', async () => {
    const rec = recordingFetch(() => new Response(mp3(4)));
    const tts = new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_multilingual_v2', fetch: rec.fn });
    const voice = tts.defaultVoiceId();
    const res = await tts.synthesize({ text: longText.repeat(3), voiceId: voice, tone: 'energetic' });
    expect(rec.calls.length).toBeGreaterThan(1);
    const [a, b] = rec.calls;
    expect(a!.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`);
    expect(a!.headers.get('xi-api-key')).toBe('xi');
    expect(a!.body).toMatchObject({ model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.35, style: 0.5 } });
    expect(a!.body.previous_text).toBeUndefined();
    expect(b!.body.previous_text).toBeTruthy();
    expect(res.durationSeconds).toBeCloseTo(rec.calls.length * 4 * FRAME_S, 6);
  });
});
