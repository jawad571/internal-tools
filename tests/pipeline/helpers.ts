import { randomUUID } from 'node:crypto';
import { createTestDb, type Db } from '../../src/db/client.ts';
import { articles, preferences, sources, userSources, users } from '../../src/db/schema.ts';
import { MemoryBlobStore } from '../../src/providers/blobs/memory.ts';
import { FeedFetcher, type LookupFn } from '../../src/providers/feeds/fetch.ts';
import { MockScriptWriter } from '../../src/providers/script/mock.ts';
import { MockTts } from '../../src/providers/tts/mock.ts';
import { MockVideoRenderer } from '../../src/providers/video/mock.ts';
import { loadConfig, type Config } from '../../src/shared/config.ts';
import type { Deps } from '../../src/shared/deps.ts';

export const NOW = new Date('2026-11-16T08:50:00Z');

export const testConfig = (over: Partial<Config> = {}): Config => ({ ...loadConfig({ NODE_ENV: 'test' }), ...over });

export const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

/** A fake HTTP origin: url → handler. Records requests. */
export function fakeFetch(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const calls: Request[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req);
    const handler = routes[req.url];
    return handler ? handler(req) : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export interface TestEnv {
  deps: Deps;
  db: Db;
  blobs: MemoryBlobStore;
  setNow(d: Date): void;
  close(): Promise<void>;
}

export async function setup(over: Partial<Deps> = {}, config: Partial<Config> = {}): Promise<TestEnv> {
  const { db, close } = await createTestDb();
  let now = NOW;
  const blobs = new MemoryBlobStore();
  const cfg = testConfig(config);
  const deps: Deps = {
    config: cfg,
    db,
    scriptWriter: new MockScriptWriter(),
    tts: new MockTts(cfg.WORDS_PER_MINUTE),
    video: new MockVideoRenderer(),
    blobs,
    feeds: new FeedFetcher({ fetch: fakeFetch({}).fetch, lookup: publicLookup }),
    now: () => now,
    ...over,
  };
  return { deps, db, blobs, setNow: (d) => (now = d), close };
}

export async function createUser(
  db: Db,
  opts: { timezone?: string; lastActiveAt?: Date; paused?: boolean; activeHours?: number[]; extendedHours?: number[]; displayName?: string } = {},
) {
  const [u] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.com`,
      passwordHash: 'x',
      displayName: opts.displayName ?? 'Sam',
      timezone: opts.timezone ?? 'UTC',
      feedToken: randomUUID(),
      lastActiveAt: opts.lastActiveAt ?? NOW,
    })
    .returning();
  await db.insert(preferences).values({
    userId: u!.id,
    voiceId: 'mock-ben',
    tone: 'warm',
    paused: opts.paused ?? false,
    ...(opts.activeHours && { activeHours: opts.activeHours }),
    ...(opts.extendedHours && { extendedHours: opts.extendedHours }),
  });
  return u!;
}

export async function createSource(db: Db, opts: { url?: string; title?: string; failCount?: number; lastFetchedAt?: Date | null } = {}) {
  const [s] = await db
    .insert(sources)
    .values({
      url: opts.url ?? `https://feeds.example.com/${randomUUID()}.xml`,
      title: opts.title ?? 'Example News',
      failCount: opts.failCount ?? 0,
      lastFetchedAt: opts.lastFetchedAt ?? null,
    })
    .returning();
  return s!;
}

export const subscribe = (db: Db, userId: string, sourceId: string, weight = 1) =>
  db.insert(userSources).values({ userId, sourceId, weight });

export async function addArticle(
  db: Db,
  sourceId: string,
  opts: { title: string; publishedAt?: Date; summary?: string; guid?: string; imageUrl?: string | null },
) {
  const [a] = await db
    .insert(articles)
    .values({
      sourceId,
      guid: opts.guid ?? randomUUID(),
      title: opts.title,
      summary: opts.summary ?? `${opts.title}. More detail about this story follows here for the listener.`,
      publishedAt: opts.publishedAt ?? new Date(NOW.getTime() - 3600_000),
      imageUrl: opts.imageUrl ?? null,
    })
    .returning();
  return a!;
}

export const hoursAgo = (h: number, from = NOW) => new Date(from.getTime() - h * 3600_000);
