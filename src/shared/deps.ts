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
  /** e.g. "Monday 16 November, 6 AM" in the listener's zone. */
  slotLabel: string;
  kind: 'standard' | 'extended';
  /** Word budget; the script should land within ±10%. */
  targetWords: number;
  tone: ToneId;
  toneNote: string;
  language: string;
  /** Ranked, de-duplicated candidates. The writer may drop the weakest to fit the budget. */
  stories: StoryInput[];
  /** Headlines from the listener's previous editions today, so follow-ups are framed as updates. */
  previouslyCovered: string[];
}

export interface ScriptResult {
  title: string;
  /** Plain spoken text: no markdown, no stage directions, no URLs. */
  script: string;
  /** Subset of the input stories actually used, in spoken order. */
  usedArticleIds: string[];
}

export interface ScriptWriter {
  write(req: ScriptRequest): Promise<ScriptResult>;
}

export interface SynthesisResult {
  audio: Buffer;
  /** e.g. audio/mpeg */
  mime: string;
  durationSeconds: number;
}

export interface TtsProvider {
  readonly id: string;
  voices(): VoiceDto[];
  defaultVoiceId(): string;
  /** Handles arbitrarily long text (chunks and concatenates internally). */
  synthesize(input: { text: string; voiceId: string; tone: ToneId; toneNote?: string }): Promise<SynthesisResult>;
}

export interface BlobStore {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  /** Inclusive byte range. Returns null if the object is missing. */
  get(key: string, range?: { start: number; end: number }): Promise<{ stream: Readable; size: number } | null>;
  delete(key: string): Promise<void>;
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

export interface Deps {
  config: Config;
  db: Db;
  scriptWriter: ScriptWriter;
  tts: TtsProvider;
  blobs: BlobStore;
  feeds: FeedProber;
  now(): Date;
}
