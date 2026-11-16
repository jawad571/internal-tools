import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createTestDb, type Db, type DbHandle } from '../../src/db/client.ts';
import { editions, sources, userSources } from '../../src/db/schema.ts';
import { MockVideoRenderer } from '../../src/providers/video/mock.ts';
import { createApp } from '../../src/server/app.ts';
import { loadConfig } from '../../src/shared/config.ts';
import type { VoiceDto } from '../../src/shared/contracts.ts';
import { defaultVoiceFor, FeedProbeError, type BlobStore, type Deps, type FeedProber, type TtsProvider } from '../../src/shared/deps.ts';

export const PUBLIC_URL = 'https://newscast.test';

const VOICES: VoiceDto[] = [
  { id: 'ava', name: 'Ava', description: 'Bright', gender: 'female', languages: ['en'] },
  { id: 'max', name: 'Max', description: 'Deep', gender: 'male', languages: ['en'] },
  { id: 'noor', name: 'Noor', description: 'Urdu', gender: 'female', languages: ['ur'] },
];

export class FakeTts implements TtsProvider {
  readonly id = 'fake';
  calls: Array<{ text: string; voiceId: string; language?: string }> = [];
  voices = () => VOICES;
  defaultVoiceId = (language?: string) => defaultVoiceFor(VOICES, language);
  async synthesize(input: { text: string; voiceId: string; language?: string }) {
    this.calls.push(input);
    return { audio: Buffer.from('FAKEAUDIO'), mime: 'audio/mpeg', durationSeconds: 1 };
  }
}

export class MemoryBlobs implements BlobStore {
  objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.objects.set(key, data);
  }
  async get(key: string, range?: { start: number; end: number }) {
    const data = this.objects.get(key);
    if (!data) return null;
    const slice = range ? data.subarray(range.start, range.end + 1) : data;
    return { stream: Readable.from([slice]), size: data.length };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

/** Accepts https://ok.example/... URLs; anything else fails like the real prober would. */
export class FakeFeeds implements FeedProber {
  async probe(url: string) {
    const u = new URL(url);
    if (u.hostname !== 'ok.example') throw new FeedProbeError('That address did not return an RSS or Atom feed');
    return { url: url.replace(/\/$/, ''), title: `Feed at ${u.pathname}`, siteUrl: 'https://ok.example' };
  }
}

async function setup(db: Db) {
  const clock = { now: new Date('2026-11-16T09:20:00Z') };
  const deps: Deps = {
    config: loadConfig({ NODE_ENV: 'test', PUBLIC_URL }),
    db,
    scriptWriter: { write: async () => ({ title: 't', script: 's', segments: [{ articleId: null, text: 's' }], usedArticleIds: [] }) },
    tts: new FakeTts(),
    video: new MockVideoRenderer(),
    blobs: new MemoryBlobs(),
    feeds: new FakeFeeds(),
    now: () => clock.now,
  };
  const app = createApp(deps);
  return { app, deps, db, clock, ...client(app) };
}

export type Ctx = Awaited<ReturnType<typeof setup>>;

/**
 * One PGlite per test file (startup dominates test time), truncated before each test; a fresh app
 * per test so in-memory rate limiters start empty. Use the returned getter inside tests.
 */
export function useCtx(): () => Ctx {
  let handle: DbHandle;
  let ctx: Ctx;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(() => handle.close());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate users, sources cascade`);
    ctx = await setup(handle.db);
  });
  return () => ctx;
}

function client(app: Hono) {
  const call = (method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.body !== undefined) headers['content-type'] ??= 'application/json';
    return app.request(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  };

  /** Signs up and returns the `name=value` session cookie plus the Me payload. */
  const signup = async (email = 'ada@example.com', extra: Record<string, unknown> = {}) => {
    const res = await call('POST', '/api/auth/signup', {
      body: { email, password: 'correct horse battery', displayName: 'Ada', timezone: 'Europe/London', ...extra },
    });
    if (res.status !== 200) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const { me } = (await res.json()) as { me: { id: string; podcastFeedUrl: string } };
    return { cookie, me, feedToken: me.podcastFeedUrl.split('/feed/')[1]!.replace('.xml', '') };
  };

  return { call, signup };
}

export async function addSource(ctx: Ctx, userId: string, url = `https://src.example/${Math.random()}`) {
  const [s] = await ctx.db.insert(sources).values({ url, title: 'Src', isCurated: true }).returning();
  await ctx.db.insert(userSources).values({ userId, sourceId: s!.id });
  return s!;
}

export async function insertReadyEdition(ctx: Ctx, userId: string, overrides: Partial<typeof editions.$inferInsert> = {}) {
  const audio = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes
  const key = `audio/${userId}/${Math.random()}.mp3`;
  await ctx.deps.blobs.put(key, audio, 'audio/mpeg');
  const [e] = await ctx.db
    .insert(editions)
    .values({
      userId,
      slotAt: new Date('2026-11-16T09:00:00Z'),
      localHour: 9,
      kind: 'standard',
      status: 'ready',
      targetSeconds: 420,
      voiceId: 'ava',
      tone: 'neutral',
      title: 'Morning bulletin',
      script: 'Hello.',
      audioKey: key,
      audioMime: 'audio/mpeg',
      audioBytes: audio.length,
      durationSeconds: 425,
      readyAt: new Date('2026-11-16T08:58:00Z'),
      ...overrides,
    })
    .returning();
  return e!;
}
