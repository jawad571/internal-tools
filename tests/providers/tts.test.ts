import { describe, expect, it } from 'vitest';
import { ElevenLabsTts, maxCharsFor } from '../../src/providers/tts/elevenlabs.ts';
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
    expect(res.alignment!.endSeconds.at(-1)).toBeCloseTo(res.durationSeconds, 6);
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
    // No timestamps from OpenAI: estimated per chunk, anchored on each chunk's measured duration.
    const al = res.alignment!;
    expect(al.measured).toBe(false);
    const firstOfChunk2 = Array.from(String(rec.calls[0]!.body.input)).length;
    expect(al.startSeconds[firstOfChunk2]).toBeCloseTo(10 * FRAME_S, 6);
    expect(al.endSeconds.at(-1)).toBeCloseTo(res.durationSeconds, 6);
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

/** A with-timestamps JSON body: `frames` MP3 frames, characters spoken back to back, `lead` seconds of silence first. */
function elevenBody(text: string, frames: number, opts: { lead?: number; alignment?: boolean; normalized?: boolean } = {}) {
  const chars = Array.from(text);
  const lead = opts.lead ?? 0;
  const step = (frames * FRAME_S - lead) / chars.length;
  const alignment = {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => lead + i * step),
    character_end_times_seconds: chars.map((_, i) => lead + (i + 1) * step),
  };
  return Response.json({
    audio_base64: Buffer.from(mp3(frames)).toString('base64'),
    alignment: opts.alignment === false ? null : alignment,
    normalized_alignment: opts.normalized ? alignment : null,
  });
}

describe('ElevenLabsTts', () => {
  it('posts to the with-timestamps endpoint with tone-mapped settings and neighbour context', async () => {
    const rec = recordingFetch((body) => elevenBody(String(body.text), 4));
    const tts = new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_multilingual_v2', fetch: rec.fn });
    const voice = tts.defaultVoiceId();
    const res = await tts.synthesize({ text: longText.repeat(3), voiceId: voice, tone: 'energetic' });
    expect(rec.calls.length).toBeGreaterThan(1);
    const [a, b] = rec.calls;
    expect(a!.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`);
    expect(a!.headers.get('xi-api-key')).toBe('xi');
    expect(a!.headers.get('accept')).toBe('application/json');
    expect(a!.body).toMatchObject({ model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.35, style: 0.5 } });
    expect(a!.body.previous_text).toBeUndefined();
    expect(b!.body.previous_text).toBeTruthy();
    expect(res.mime).toBe('audio/mpeg');
    expect(res.durationSeconds).toBeCloseTo(rec.calls.length * 4 * FRAME_S, 6);
  });

  it('decodes base64 audio and offsets each chunk’s character timings by the chunks before it', async () => {
    // Chunk n is (n+1)*3 frames long and starts with 0.01 s of silence.
    const rec = recordingFetch((body, n) => elevenBody(String(body.text), n * 3, { lead: 0.01 }));
    const tts = new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_multilingual_v2', fetch: rec.fn, concurrency: 1 });
    const res = await tts.synthesize({ text: longText.repeat(3), voiceId: 'v', tone: 'neutral' });
    const texts = rec.calls.map((c) => String(c.body.text));
    expect(texts.length).toBeGreaterThan(2);
    const al = res.alignment!;
    expect(al.measured).toBe(true);
    expect(al.characters.join('')).toBe(texts.join(''));

    let index = 0;
    let offset = 0;
    texts.forEach((t, n) => {
      expect(al.startSeconds[index]).toBeCloseTo(offset + 0.01, 6);
      index += Array.from(t).length;
      offset += (n + 1) * 3 * FRAME_S;
    });
    expect(al.endSeconds.at(-1)).toBeCloseTo(res.durationSeconds, 6);
    expect(res.audio.length).toBe(rec.calls.reduce((sum, _c, n) => sum + mp3((n + 1) * 3).length, 0));
  });

  it('uses normalized_alignment, then an estimate, when alignment is missing', async () => {
    const norm = recordingFetch((body) => elevenBody(String(body.text), 5, { alignment: false, normalized: true }));
    const a = await new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4', fetch: norm.fn }).synthesize({ text: 'Hello there.', voiceId: 'v', tone: 'calm' });
    expect(a.alignment!.measured).toBe(true);

    const none = recordingFetch((body) => elevenBody(String(body.text), 5, { alignment: false }));
    const b = await new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4', fetch: none.fn }).synthesize({ text: 'Hello there.', voiceId: 'v', tone: 'calm' });
    expect(b.alignment!.measured).toBe(false);
    expect(b.alignment!.characters.join('')).toBe('Hello there.');
    expect(b.alignment!.endSeconds.at(-1)).toBeCloseTo(5 * FRAME_S, 6);
  });

  it('rejects a response with no audio', async () => {
    const rec = recordingFetch(() => Response.json({ alignment: null }));
    const tts = new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4', fetch: rec.fn, retry: { attempts: 1 } });
    await expect(tts.synthesize({ text: 'Hi.', voiceId: 'v', tone: 'neutral' })).rejects.toThrow('no audio');
  });

  it('sends a full-length bulletin to eleven_v4 in a single request', async () => {
    const rec = recordingFetch((body) => elevenBody(String(body.text), 4));
    const tts = new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4', fetch: rec.fn });
    const bulletin = 'A sentence of roughly sixty characters for the news test. '.repeat(150);
    expect(bulletin.length).toBeGreaterThan(4500);
    expect(bulletin.length).toBeLessThan(maxCharsFor('eleven_v4'));
    await tts.synthesize({ text: bulletin, voiceId: tts.defaultVoiceId(), tone: 'neutral' });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.body).toMatchObject({ model_id: 'eleven_v4' });
  });
});

describe('voices by language', () => {
  const urduSample = 'السلام علیکم۔ یہ ہے آپ کا نیوزکاسٹ۔';

  it('every provider tags voices with languages; defaults follow the language', () => {
    const el = new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4' });
    const urdu = el.voices().filter((v) => v.languages.includes('ur'));
    expect(urdu.length).toBeGreaterThanOrEqual(2);
    expect(new Set(urdu.map((v) => v.gender))).toEqual(new Set(['male', 'female']));
    expect(el.voices().every((v) => v.languages.length > 0)).toBe(true);
    expect(el.voices().some((v) => 'libraryOwnerId' in v)).toBe(false); // internal only
    expect(el.defaultVoiceId()).toBe('onwK4e9ZLuTAKqWW03F9');
    expect(el.defaultVoiceId('en')).toBe('onwK4e9ZLuTAKqWW03F9');
    expect(el.defaultVoiceId('ur')).toBe(urdu[0]!.id);

    const oa = new OpenAiTts({ apiKey: 'k', model: 'gpt-4o-mini-tts' });
    expect(oa.voices().every((v) => v.languages.includes('en') && v.languages.includes('ur'))).toBe(true);
    expect(oa.defaultVoiceId('ur')).toBe('alloy');

    const mock = new MockTts(150);
    expect(mock.defaultVoiceId('ur')).toBe('mock-zara');
    expect(mock.defaultVoiceId('en')).toBe('mock-ava');
  });

  it('ElevenLabs sends language_code only to models that take it', async () => {
    const send = async (model: string, language?: string) => {
      const rec = recordingFetch((body) => elevenBody(String(body.text), 4));
      await new ElevenLabsTts({ apiKey: 'xi', model, fetch: rec.fn }).synthesize({ text: urduSample, voiceId: 'v', tone: 'neutral', language });
      return rec.calls[0]!.body;
    };
    expect((await send('eleven_v4', 'ur')).language_code).toBe('ur');
    expect((await send('eleven_v3', 'ur')).language_code).toBe('ur');
    expect((await send('eleven_flash_v2_5', 'ur')).language_code).toBe('ur');
    expect(await send('eleven_multilingual_v2', 'ur')).not.toHaveProperty('language_code');
    expect(await send('eleven_v4')).not.toHaveProperty('language_code');
  });

  it('ElevenLabs adds a Voice Library voice to the account once if the API refuses it, then retries', async () => {
    const urdu = new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4' }).voices().find((v) => v.languages.includes('ur'))!;
    let added = false;
    const rec = recordingFetch((body) => {
      if (!('text' in body)) {
        added = true;
        return Response.json({ voice_id: urdu.id });
      }
      return added ? elevenBody(String(body.text), 4) : Response.json({ detail: { status: 'voice_not_found' } }, { status: 404 });
    });
    const el = new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4', fetch: rec.fn, retry: { baseMs: 1 } });
    const res = await el.synthesize({ text: urduSample, voiceId: urdu.id, tone: 'neutral', language: 'ur' });
    expect(res.audio.length).toBeGreaterThan(0);
    expect(rec.calls.map((c) => c.url.replace('https://api.elevenlabs.io/v1', ''))).toEqual([
      `/text-to-speech/${urdu.id}/with-timestamps?output_format=mp3_44100_128`,
      expect.stringMatching(new RegExp(`^/voices/add/[0-9a-f]{64}/${urdu.id}$`)),
      `/text-to-speech/${urdu.id}/with-timestamps?output_format=mp3_44100_128`,
    ]);
    expect(rec.calls[1]!.body).toEqual({ new_name: `Newscast ${urdu.name}` });

    // Later requests go straight through: no second add.
    await el.synthesize({ text: urduSample, voiceId: urdu.id, tone: 'neutral', language: 'ur' });
    expect(rec.calls.filter((c) => c.url.includes('/voices/add/'))).toHaveLength(1);
  });

  it('ElevenLabs does not try to add stock voices, and surfaces a failed add', async () => {
    const stock = recordingFetch(() => Response.json({ detail: { status: 'voice_not_found' } }, { status: 404 }));
    await expect(
      new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4', fetch: stock.fn, retry: { attempts: 1 } }).synthesize({ text: 'Hi.', voiceId: 'onwK4e9ZLuTAKqWW03F9', tone: 'neutral' }),
    ).rejects.toThrow('HTTP 404');
    expect(stock.calls).toHaveLength(1);

    const urduId = new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4' }).defaultVoiceId('ur');
    const denied = recordingFetch((body) =>
      'text' in body ? Response.json({ detail: { status: 'voice_not_found' } }, { status: 404 }) : Response.json({ detail: { status: 'missing_permissions' } }, { status: 401 }),
    );
    await expect(
      new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4', fetch: denied.fn, retry: { attempts: 1 } }).synthesize({ text: urduSample, voiceId: urduId, tone: 'neutral' }),
    ).rejects.toThrow(/add library voice .*HTTP 401/);
  });

  it('ElevenLabs only adds on "voice not found", and retries once (no loop) if the voice is still refused', async () => {
    const urduId = new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4' }).defaultVoiceId('ur');
    const adds = (calls: Array<{ url: string }>) => calls.filter((c) => c.url.includes('/voices/add/')).length;

    // Other client errors (bad key, quota, validation) are surfaced without touching the account.
    for (const [status, detail] of [
      [401, 'invalid_api_key'],
      [402, 'payment_required'],
      [422, 'invalid_text'],
      [400, 'quota_exceeded'],
    ] as const) {
      const rec = recordingFetch(() => Response.json({ detail: { status: detail } }, { status }));
      await expect(
        new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4', fetch: rec.fn, retry: { attempts: 1 } }).synthesize({ text: urduSample, voiceId: urduId, tone: 'neutral' }),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(adds(rec.calls)).toBe(0);
    }

    // 400 voice_not_found counts too; a voice still refused after the add fails after one retry.
    const stuck = recordingFetch((body) =>
      'text' in body ? Response.json({ detail: { status: 'voice_not_found' } }, { status: 400 }) : Response.json({ voice_id: urduId }),
    );
    const el = new ElevenLabsTts({ apiKey: 'xi', model: 'eleven_v4', fetch: stuck.fn, retry: { baseMs: 1 } });
    await expect(el.synthesize({ text: urduSample, voiceId: urduId, tone: 'neutral' })).rejects.toThrow('HTTP 400');
    expect(stuck.calls).toHaveLength(3); // tts, add, tts
    // The (successful) add is remembered: a later edition tries once more without re-adding.
    await expect(el.synthesize({ text: urduSample, voiceId: urduId, tone: 'neutral' })).rejects.toThrow('HTTP 400');
    expect(adds(stuck.calls)).toBe(1);
  });

  it('MockTts paces Urdu at its own words-per-minute', async () => {
    const tts = new MockTts(150);
    const text = Array(160).fill('خبر').join(' ') + '۔';
    expect((await tts.synthesize({ text, voiceId: 'mock-zara', tone: 'neutral', language: 'ur' })).durationSeconds).toBeCloseTo(60, 1);
    expect((await tts.synthesize({ text, voiceId: 'mock-ava', tone: 'neutral' })).durationSeconds).toBeCloseTo(64, 1);
  });
});
