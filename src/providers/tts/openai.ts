import type { VoiceDto } from '../../shared/contracts.ts';
import type { SynthesisResult, TtsProvider } from '../../shared/deps.ts';
import { assertOk, mapLimit, withRetry, type RetryOptions } from '../util.ts';
import { chunkText } from './chunk.ts';
import { concatMp3, mp3DurationSeconds } from './mp3.ts';
import { deliveryInstructions } from './tone.ts';

const ENDPOINT = 'https://api.openai.com/v1/audio/speech';
/** The endpoint caps `input` at 4096 characters. */
const MAX_CHARS = 4000;

// Voices available on every OpenAI TTS model (tts-1, tts-1-hd, gpt-4o-mini-tts).
const VOICES: VoiceDto[] = [
  { id: 'alloy', name: 'Alloy', description: 'Balanced and versatile.', gender: 'neutral' },
  { id: 'ash', name: 'Ash', description: 'Clear and direct.', gender: 'male' },
  { id: 'coral', name: 'Coral', description: 'Warm and friendly.', gender: 'female' },
  { id: 'echo', name: 'Echo', description: 'Smooth and resonant.', gender: 'male' },
  { id: 'fable', name: 'Fable', description: 'Expressive, storyteller quality.', gender: 'neutral' },
  { id: 'nova', name: 'Nova', description: 'Bright and energetic.', gender: 'female' },
  { id: 'onyx', name: 'Onyx', description: 'Deep and authoritative.', gender: 'male' },
  { id: 'sage', name: 'Sage', description: 'Calm and measured.', gender: 'female' },
  { id: 'shimmer', name: 'Shimmer', description: 'Light and clear.', gender: 'female' },
];

export class OpenAiTts implements TtsProvider {
  readonly id = 'openai';

  constructor(
    private readonly opts: { apiKey: string; model: string; fetch?: typeof fetch; concurrency?: number; retry?: RetryOptions },
  ) {}

  voices() {
    return VOICES;
  }

  defaultVoiceId() {
    return 'alloy';
  }

  async synthesize({ text, voiceId, tone, toneNote }: Parameters<TtsProvider['synthesize']>[0]): Promise<SynthesisResult> {
    const doFetch = this.opts.fetch ?? fetch;
    // tts-1 / tts-1-hd ignore or reject `instructions`; the gpt-4o-*-tts models take them.
    const instructions = /^tts-1/.test(this.opts.model) ? undefined : deliveryInstructions(tone, toneNote);
    const parts = await mapLimit(chunkText(text, MAX_CHARS), this.opts.concurrency ?? 3, (input) =>
      withRetry(async () => {
        const res = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.opts.model, voice: voiceId, input, response_format: 'mp3', instructions }),
        });
        await assertOk(res, 'OpenAI speech');
        return Buffer.from(await res.arrayBuffer());
      }, this.opts.retry),
    );
    const audio = concatMp3(parts);
    return { audio, mime: 'audio/mpeg', durationSeconds: mp3DurationSeconds(audio) };
  }
}
