import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** web = HTTP only, worker = ingest + generation only, all = both in one process (dev default). */
  ROLE: z.enum(['web', 'worker', 'all']).default('all'),
  PORT: z.coerce.number().int().default(8787),
  /** Public origin used in podcast feed URLs. */
  PUBLIC_URL: z.string().default('http://localhost:8787'),
  /** postgres://… in production. Anything else is treated as a PGlite data directory. */
  DATABASE_URL: z.string().default('.data/pg'),
  COOKIE_SECURE: bool.optional(),

  // --- script writing (LLM) ---
  ANTHROPIC_API_KEY: z.string().optional(),
  SCRIPT_MODEL: z.string().default('claude-sonnet-5-5'),

  // --- text to speech ---
  /** Defaults to openai/elevenlabs if their key is set, else mock. */
  TTS_PROVIDER: z.enum(['openai', 'elevenlabs', 'mock']).optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODEL: z.string().default('eleven_multilingual_v2'),

  // --- audio storage ---
  STORAGE: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('.data/audio'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),

  // --- pipeline tuning ---
  /** Re-fetch a subscribed feed when it is older than this. */
  INGEST_STALE_MINUTES: z.coerce.number().default(15),
  /** Start generating this many minutes before the top of the hour so audio is ready on time. */
  SCHEDULE_LEAD_MINUTES: z.coerce.number().default(12),
  /** Editions generated concurrently per worker process. */
  WORKER_CONCURRENCY: z.coerce.number().int().default(4),
  /** Users with no activity for this long stop getting scheduled editions (they can still generate on demand). */
  IDLE_PAUSE_DAYS: z.coerce.number().default(7),
  /** Audio older than this is deleted. */
  RETENTION_DAYS: z.coerce.number().default(7),
  /** Spoken words per minute used to turn a target duration into a word budget. */
  WORDS_PER_MINUTE: z.coerce.number().default(150),
});

export type Config = z.infer<typeof Env> & { ttsProvider: 'openai' | 'elevenlabs' | 'mock'; cookieSecure: boolean };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = Env.parse(env);
  const ttsProvider = e.TTS_PROVIDER ?? (e.OPENAI_API_KEY ? 'openai' : e.ELEVENLABS_API_KEY ? 'elevenlabs' : 'mock');
  return { ...e, ttsProvider, cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production' };
}
