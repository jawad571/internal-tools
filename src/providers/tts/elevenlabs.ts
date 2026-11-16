import type { ToneId, VoiceDto } from '../../shared/contracts.ts';
import { defaultVoiceFor, type SynthesisResult, type TtsProvider } from '../../shared/deps.ts';
import { assertOk, HttpError, mapLimit, withRetry, type RetryOptions } from '../util.ts';
import { chunkText } from './chunk.ts';
import { concatMp3, mp3DurationSeconds } from './mp3.ts';
import { estimateChunkAlignment, joinAlignments, type ChunkAlignment } from './timing.ts';

const API = 'https://api.elevenlabs.io/v1';
const BASE = `${API}/text-to-speech`;
/**
 * Per-request text size, kept under each model's limit. eleven_v4 takes 10,000 characters and stays
 * consistent over long text, so a normal bulletin goes in one request with no chunk seams; older models
 * (5,000 limit) drift in prosody on long requests, so they get smaller chunks.
 */
export function maxCharsFor(model: string): number {
  return /^eleven_v4/.test(model) ? 9500 : 4500;
}

/**
 * Models that take `language_code` on text-to-speech. The API reference says it is not supported
 * for multilingual_v2; the models page documents it for the v3/v4 families (and flash/turbo v2.5
 * have long accepted it). Anything else gets no language_code.
 */
export const supportsLanguageCode = (model: string) => /^eleven_(v3|v4|flash_v2_5|turbo_v2_5)/.test(model);

type ElevenVoice = VoiceDto & {
  /**
   * Set for community Voice Library voices: the sharer's public user id, needed to add the voice
   * to the account (POST /v1/voices/add/{public_user_id}/{voice_id}) if the API refuses to use it
   * by id directly. Library voices need a paid plan; they are not available via the API on the free tier.
   */
  libraryOwnerId?: string;
};

const EN = ['en'];
const UR = ['ur'];

const VOICES: ElevenVoice[] = [
  // Stock "premade" voices from the ElevenLabs default library.
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', description: 'British, authoritative news presenter.', gender: 'male', languages: EN },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', description: 'British, clear and confident.', gender: 'female', languages: EN },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'British, warm and mature.', gender: 'male', languages: EN },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'American, soft and reassuring.', gender: 'female', languages: EN },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', description: 'American, deep and steady.', gender: 'male', languages: EN },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', description: 'British, warm and gentle.', gender: 'female', languages: EN },
  // Native Urdu voices from the Voice Library (professional clones, Urdu verified for eleven_v4).
  {
    id: 'vH5LP38dcYJ3CIbC2rKX',
    name: 'Amjid',
    description: 'Urdu, deep and clear documentary narrator.',
    gender: 'male',
    languages: UR,
    libraryOwnerId: '6706bd0c1eef369d8d0d422a67ec25b2e0028aed02fa5d04594fce3a9d99f19c',
  },
  {
    id: 'UT6USLtoAlXHj5k4sOLY',
    name: 'Reva',
    description: 'Urdu, warm and unhurried narrator.',
    gender: 'female',
    languages: UR,
    libraryOwnerId: '7398804d9eaf2f463899a907587c33a390591775784f87857b6d0e1e4e3e66f6',
  },
  {
    id: 'L1f58R08RFtEqY28c3BT',
    name: 'Naqsh',
    description: 'Urdu, relaxed documentary voice.',
    gender: 'male',
    languages: UR,
    libraryOwnerId: '9807482bc8d64c029eb3e350412fb7e1faab80f063134f688aa16c9f115acbea',
  },
];

const toDto = ({ libraryOwnerId: _, ...dto }: ElevenVoice): VoiceDto => dto;
const DTOS = VOICES.map(toDto);

/** ElevenLabs' answer for a voice id the account can't use (yet). */
const isVoiceNotFound = (e: unknown) =>
  e instanceof HttpError && (e.status === 404 || (e.status === 400 && /voice_not_found/.test(e.message)));

/** Lower stability = more expressive; higher style = more exaggerated delivery. */
const SETTINGS: Record<ToneId, { stability: number; style: number }> = {
  neutral: { stability: 0.6, style: 0 },
  warm: { stability: 0.5, style: 0.25 },
  energetic: { stability: 0.35, style: 0.5 },
  calm: { stability: 0.75, style: 0 },
  witty: { stability: 0.45, style: 0.35 },
  formal: { stability: 0.7, style: 0.05 },
};

/** Response of POST /v1/text-to-speech/{voice_id}/with-timestamps. */
interface TimestampedResponse {
  audio_base64?: unknown;
  alignment?: WireAlignment | null;
  normalized_alignment?: WireAlignment | null;
}
interface WireAlignment {
  characters?: unknown;
  character_start_times_seconds?: unknown;
  character_end_times_seconds?: unknown;
}

function readAlignment(a: WireAlignment | null | undefined): ChunkAlignment | null {
  if (!a || !Array.isArray(a.characters) || !Array.isArray(a.character_start_times_seconds) || !Array.isArray(a.character_end_times_seconds)) {
    return null;
  }
  const n = a.characters.length;
  if (!n || a.character_start_times_seconds.length !== n || a.character_end_times_seconds.length !== n) return null;
  return {
    characters: a.characters.map(String),
    startSeconds: a.character_start_times_seconds.map(Number),
    endSeconds: a.character_end_times_seconds.map(Number),
  };
}

export class ElevenLabsTts implements TtsProvider {
  readonly id = 'elevenlabs';

  constructor(
    private readonly opts: { apiKey: string; model: string; fetch?: typeof fetch; concurrency?: number; retry?: RetryOptions },
  ) {}

  /** Library voice id -> in-flight/finished add to the account (id the account knows it by). */
  private readonly added = new Map<string, Promise<string>>();

  voices() {
    return DTOS;
  }

  defaultVoiceId(language?: string) {
    return defaultVoiceFor(DTOS, language);
  }

  /**
   * Library voices are used by id directly ("you can use voices from the Voice Library directly
   * without saving them to My Voices"). If the API refuses one, it is added to the account once
   * and the request retried; a voice already in the account is unaffected.
   */
  private addLibraryVoice(voice: ElevenVoice & { libraryOwnerId: string }): Promise<string> {
    let pending = this.added.get(voice.id);
    if (!pending) {
      const doFetch = this.opts.fetch ?? fetch;
      pending = (async () => {
        const url = `${API}/voices/add/${encodeURIComponent(voice.libraryOwnerId)}/${encodeURIComponent(voice.id)}`;
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'xi-api-key': this.opts.apiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ new_name: `Newscast ${voice.name}` }),
        });
        await assertOk(res, `ElevenLabs add library voice ${voice.name}`);
        const body = (await res.json().catch(() => ({}))) as { voice_id?: unknown };
        console.info(`[tts] added ElevenLabs library voice ${voice.name} (${voice.id}) to the account`);
        return typeof body.voice_id === 'string' && body.voice_id ? body.voice_id : voice.id;
      })();
      // A failed add may be retried by a later edition.
      pending.catch(() => this.added.delete(voice.id));
      this.added.set(voice.id, pending);
    }
    return pending;
  }

  async synthesize({ text, voiceId, tone, language }: Parameters<TtsProvider['synthesize']>[0]): Promise<SynthesisResult> {
    const doFetch = this.opts.fetch ?? fetch;
    const chunks = chunkText(text, maxCharsFor(this.opts.model));
    const library = VOICES.find((v): v is ElevenVoice & { libraryOwnerId: string } => v.id === voiceId && !!v.libraryOwnerId);
    let resolvedId = (library && (await this.added.get(library.id)?.catch(() => undefined))) || voiceId;
    const languageCode = language && supportsLanguageCode(this.opts.model) ? language : undefined;

    const post = async (chunk: string, i: number) => {
      // The with-timestamps variant returns JSON (base64 audio + per-character timings) at the same price.
      const url = `${BASE}/${encodeURIComponent(resolvedId)}/with-timestamps?output_format=mp3_44100_128`;
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': this.opts.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          text: chunk,
          model_id: this.opts.model,
          ...(languageCode ? { language_code: languageCode } : {}),
          voice_settings: { ...SETTINGS[tone], similarity_boost: 0.75, use_speaker_boost: true },
          // Neighbouring text keeps intonation continuous across chunk boundaries.
          previous_text: chunks[i - 1]?.slice(-500),
          next_text: chunks[i + 1]?.slice(0, 500),
        }),
      });
      await assertOk(res, 'ElevenLabs text-to-speech');
      return res;
    };

    const parts = await mapLimit(chunks, this.opts.concurrency ?? 2, (chunk, i) =>
      withRetry(async () => {
        let res: Response;
        try {
          res = await post(chunk, i);
        } catch (e) {
          if (!library || !isVoiceNotFound(e)) throw e;
          resolvedId = await this.addLibraryVoice(library);
          res = await post(chunk, i);
        }
        const body = (await res.json()) as TimestampedResponse;
        if (typeof body.audio_base64 !== 'string' || !body.audio_base64) throw new Error('ElevenLabs returned no audio');
        const audio = Buffer.from(body.audio_base64, 'base64');
        // `alignment` indexes the text we sent; normalized_alignment (numbers spelled out etc.) is a fallback.
        const native = readAlignment(body.alignment) ?? readAlignment(body.normalized_alignment);
        return { audio, native, chunk };
      }, this.opts.retry),
    );
    const timed = parts.map((p) => {
      const durationSeconds = mp3DurationSeconds(p.audio);
      return { durationSeconds, alignment: p.native ?? estimateChunkAlignment(p.chunk, durationSeconds) };
    });
    const audio = concatMp3(parts.map((p) => p.audio));
    const alignment = joinAlignments(timed, parts.every((p) => p.native));
    return { audio, mime: 'audio/mpeg', durationSeconds: mp3DurationSeconds(audio), alignment };
  }
}
