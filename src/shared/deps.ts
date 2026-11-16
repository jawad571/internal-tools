/**
 * Ports between the HTTP server and the generation pipeline. The server depends only on these
 * interfaces; `src/providers/index.ts` builds the real implementations from Config.
 */
import type { Readable } from 'node:stream';
import type { Db } from '../db/client.ts';
import type { Config } from './config.ts';
import type { ToneId, VoiceDto } from './contracts.ts';

export interface StoryInput {
  articleId: string;
  title: string;
  sourceTitle: string;
  summary: string;
  publishedAt: Date;
  /** 1-3, the user's priority for the source. */
  weight: number;
}

export interface ScriptRequest {
  listenerName: string;
  /** e.g. "Monday 16 November, 6 AM" in the listener's zone, phrased in `language`. */
  slotLabel: string;
  kind: 'standard' | 'extended';
  /** Word budget; the script should land within ±10%. */
  targetWords: number;
  tone: ToneId;
  toneNote: string;
  /** SUPPORTED_LANGUAGES code the script is spoken in. Story inputs are usually English. */
  language: string;
  /** Ranked, de-duplicated candidates. The writer may drop the weakest to fit the budget. */
  stories: StoryInput[];
  /** Headlines from the listener's previous editions today, so follow-ups are framed as updates. */
  previouslyCovered: string[];
}

export interface ScriptSegment {
  /** The story this passage reads, or null for the greeting, sign-off and other links. */
  articleId: string | null;
  text: string;
}

export interface ScriptResult {
  /** In the spoken language. */
  title: string;
  /** English version of `title`, when the spoken language isn't English (video cards stay English). */
  titleEn?: string;
  /** Plain spoken text: no markdown, no stage directions, no URLs. Equals joinSegments(segments). */
  script: string;
  /** The script in spoken order, split by story. */
  segments: ScriptSegment[];
  /** Subset of the input stories actually used, in spoken order. */
  usedArticleIds: string[];
}

/** The canonical spoken script for a list of segments (paragraph per segment). */
export const joinSegments = (segments: ScriptSegment[]) =>
  segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join('\n\n');

export interface ScriptWriter {
  write(req: ScriptRequest): Promise<ScriptResult>;
}

/**
 * When each character of the synthesized text is spoken. Indices line up with the text the
 * provider was given (after its own whitespace normalisation); whitespace may be absent.
 * Providers without native timestamps estimate per chunk (see providers/tts/timing.ts).
 */
export interface SpeechAlignment {
  characters: string[];
  startSeconds: number[];
  endSeconds: number[];
  /** True when the times are measured by the provider rather than estimated. */
  measured: boolean;
}

export interface SynthesisResult {
  audio: Buffer;
  /** e.g. audio/mpeg */
  mime: string;
  durationSeconds: number;
  alignment?: SpeechAlignment;
}

export interface TtsProvider {
  readonly id: string;
  voices(): VoiceDto[];
  /** First voice for `language` (default English); falls back to the first voice overall. */
  defaultVoiceId(language?: string): string;
  /**
   * Handles arbitrarily long text (chunks and concatenates internally). `language` is the
   * SUPPORTED_LANGUAGES code of the text, for providers that can be told it.
   */
  synthesize(input: { text: string; voiceId: string; tone: ToneId; toneNote?: string; language?: string }): Promise<SynthesisResult>;
}

export interface BlobStore {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  /** Inclusive byte range. Returns null if the object is missing. */
  get(key: string, range?: { start: number; end: number }): Promise<{ stream: Readable; size: number } | null>;
  delete(key: string): Promise<void>;
}

export interface VideoStory {
  articleId: string;
  title: string;
  sourceTitle: string;
  /** Untrusted third-party URL; renderers must fetch it safely and fall back on failure. */
  imageUrl: string | null;
}

export interface VideoRequest {
  audio: Buffer;
  audioMime: string;
  durationSeconds: number;
  /** Edition title, shown on the intro/outro cards. Always English (drawtext can't shape Urdu). */
  title: string;
  /** e.g. "Monday 16 November, 9 AM". Always English. */
  slotLabel: string;
  /** Contiguous timeline covering [0, durationSeconds]; story null = intro/outro/link. */
  segments: Array<{ story: VideoStory | null; start: number; end: number }>;
  /** Every story in the edition, in spoken order (for the ticker). */
  stories: VideoStory[];
}

export interface VideoResult {
  video: Buffer;
  /** video/mp4 */
  mime: string;
}

export interface VideoRenderer {
  readonly id: string;
  render(req: VideoRequest): Promise<VideoResult>;
}

export interface ProbedFeed {
  /** Normalised, post-redirect feed URL. */
  url: string;
  title: string;
  siteUrl: string | null;
}

export interface FeedProber {
  /**
   * Fetch and validate a user-supplied feed URL. Must refuse non-http(s) schemes and private /
   * loopback / link-local addresses (SSRF). Throws FeedProbeError with a user-presentable message.
   */
  probe(url: string): Promise<ProbedFeed>;
}

export class FeedProbeError extends Error {}

/** Shared implementation of TtsProvider.defaultVoiceId. */
export function defaultVoiceFor(voices: VoiceDto[], language = 'en'): string {
  const voice = voices.find((v) => v.languages.includes(language)) ?? voices[0];
  if (!voice) throw new Error('TTS provider has no voices');
  return voice.id;
}

export interface Deps {
  config: Config;
  db: Db;
  scriptWriter: ScriptWriter;
  tts: TtsProvider;
  video: VideoRenderer;
  blobs: BlobStore;
  feeds: FeedProber;
  now(): Date;
}
