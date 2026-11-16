import type { ToneId, VoiceDto } from '../../shared/contracts.ts';
import type { SynthesisResult, TtsProvider } from '../../shared/deps.ts';
import { assertOk, mapLimit, withRetry, type RetryOptions } from '../util.ts';
import { chunkText } from './chunk.ts';
import { concatMp3, mp3DurationSeconds } from './mp3.ts';

const BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
/** Well under the per-request character limit of the multilingual models; long requests also drift in prosody. */
const MAX_CHARS = 4500;

// Stock "premade" voices from the ElevenLabs default library.
const VOICES: VoiceDto[] = [
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', description: 'British, authoritative news presenter.', gender: 'male' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', description: 'British, clear and confident.', gender: 'female' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'British, warm and mature.', gender: 'male' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'American, soft and reassuring.', gender: 'female' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', description: 'American, deep and steady.', gender: 'male' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', description: 'British, warm and gentle.', gender: 'female' },
];

/** Lower stability = more expressive; higher style = more exaggerated delivery. */
const SETTINGS: Record<ToneId, { stability: number; style: number }> = {
  neutral: { stability: 0.6, style: 0 },
  warm: { stability: 0.5, style: 0.25 },
  energetic: { stability: 0.35, style: 0.5 },
  calm: { stability: 0.75, style: 0 },
  witty: { stability: 0.45, style: 0.35 },
  formal: { stability: 0.7, style: 0.05 },
};

export class ElevenLabsTts implements TtsProvider {
  readonly id = 'elevenlabs';

  constructor(
    private readonly opts: { apiKey: string; model: string; fetch?: typeof fetch; concurrency?: number; retry?: RetryOptions },
  ) {}

  voices() {
    return VOICES;
  }

  defaultVoiceId() {
    return VOICES[0]!.id;
  }

  async synthesize({ text, voiceId, tone }: Parameters<TtsProvider['synthesize']>[0]): Promise<SynthesisResult> {
    const doFetch = this.opts.fetch ?? fetch;
    const chunks = chunkText(text, MAX_CHARS);
    const url = `${BASE}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
    const parts = await mapLimit(chunks, this.opts.concurrency ?? 2, (chunk, i) =>
      withRetry(async () => {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'xi-api-key': this.opts.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({
            text: chunk,
            model_id: this.opts.model,
            voice_settings: { ...SETTINGS[tone], similarity_boost: 0.75, use_speaker_boost: true },
            // Neighbouring text keeps intonation continuous across chunk boundaries.
            previous_text: chunks[i - 1]?.slice(-500),
            next_text: chunks[i + 1]?.slice(0, 500),
          }),
        });
        await assertOk(res, 'ElevenLabs text-to-speech');
        return Buffer.from(await res.arrayBuffer());
      }, this.opts.retry),
    );
    const audio = concatMp3(parts);
    return { audio, mime: 'audio/mpeg', durationSeconds: mp3DurationSeconds(audio) };
  }
}
