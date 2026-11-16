import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editionArticles, editions, preferences } from '../../src/db/schema.ts';
import { claimEditions, generateEdition, MAX_ATTEMPTS } from '../../src/pipeline/generate.ts';
import { MockScriptWriter } from '../../src/providers/script/mock.ts';
import type { ScriptRequest, ScriptWriter } from '../../src/shared/deps.ts';
import { FeedFetcher } from '../../src/providers/feeds/fetch.ts';
import { addArticle, createSource, createUser, fakeFetch, hoursAgo, NOW, publicLookup, setup, subscribe, type TestEnv } from './helpers.ts';

const SLOT = new Date('2026-11-16T09:00:00Z');

async function pendingEdition(env: TestEnv, userId: string, over: Partial<typeof editions.$inferInsert> = {}) {
  const [e] = await env.db
    .insert(editions)
    .values({ userId, slotAt: SLOT, localHour: 9, kind: 'standard', targetSeconds: 120, voiceId: 'mock-ben', tone: 'calm', ...over })
    .returning();
  return e!;
}

const reload = async (env: TestEnv, id: string) => (await env.db.select().from(editions).where(eq(editions.id, id)))[0]!;

describe('generateEdition', () => {
  let env: TestEnv;
  let requests: ScriptRequest[];
  beforeEach(async () => {
    requests = [];
    const mock = new MockScriptWriter();
    env = await setup({ scriptWriter: { write: (r) => (requests.push(r), mock.write(r)) } });
  });
  afterEach(() => env.close());

  async function userWithNews(n = 3) {
    const user = await createUser(env.db, { displayName: 'Ada', timezone: 'Europe/London' });
    const src = await createSource(env.db, { title: 'Daily Planet' });
    await subscribe(env.db, user.id, src.id, 2);
    const arts = [];
    const topics = ['harbour bridge reopens', 'city marathon record', 'library expansion approved', 'tram strike averted', 'museum heist solved'];
    for (let i = 0; i < n; i++) arts.push(await addArticle(env.db, src.id, { title: `Story ${topics[i]}`, publishedAt: hoursAgo(i + 0.5) }));
    return { user, arts };
  }

  it('pending -> ready: blob stored, fields set, edition_articles written in order', async () => {
    const { user } = await userWithNews(3);
    await env.db.update(preferences).set({ language: 'en', toneNote: 'gentle please' }).where(eq(preferences.userId, user.id));
    const e = await pendingEdition(env, user.id);

    expect(await generateEdition(env.deps, e.id)).toBe('ready');
    const done = await reload(env, e.id);
    expect(done).toMatchObject({ status: 'ready', audioMime: 'audio/wav', audioKey: `editions/${user.id}/${e.id}.wav`, error: null, claimedAt: null });
    expect(done.title).toBeTruthy();
    expect(done.script).toContain('Ada');
    expect(done.readyAt).toEqual(NOW);
    const blob = env.blobs.objects.get(done.audioKey!)!;
    expect(blob.data.length).toBe(done.audioBytes);
    const words = done.script!.split(/\s+/).length;
    expect(done.durationSeconds).toBe(Math.round((words / 150) * 60));

    const req = requests[0]!;
    expect(req).toMatchObject({ listenerName: 'Ada', kind: 'standard', targetWords: 300, tone: 'calm', toneNote: 'gentle please', language: 'en' });
    expect(req.slotLabel).toBe('Monday 16 November, 9 AM');

    const links = await env.db.select().from(editionArticles).where(eq(editionArticles.editionId, e.id)).orderBy(editionArticles.position);
    const used = (await new MockScriptWriter().write(req)).usedArticleIds;
    expect(links.map((l) => l.articleId)).toEqual(used);
    expect(links.map((l) => l.position)).toEqual(used.map((_, i) => i));
  });

  it('only records the article ids the writer actually used and that were supplied', async () => {
    const { user, arts } = await userWithNews(3);
    env.deps.scriptWriter = {
      write: async () => ({ title: 'T', script: 'Hello there. News.', usedArticleIds: [arts[2]!.id, 'not-supplied', arts[2]!.id] }),
    };
    const e = await pendingEdition(env, user.id);
    await generateEdition(env.deps, e.id);
    const links = await env.db.select().from(editionArticles);
    expect(links.map((l) => l.articleId)).toEqual([arts[2]!.id]);
  });

  it('no stories -> skipped, no blob', async () => {
    const user = await createUser(env.db);
    await subscribe(env.db, user.id, (await createSource(env.db)).id);
    const e = await pendingEdition(env, user.id);
    expect(await generateEdition(env.deps, e.id)).toBe('skipped');
    expect((await reload(env, e.id)).status).toBe('skipped');
    expect(env.blobs.objects.size).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it('writer throws -> retried as pending, then failed after max attempts', async () => {
    const { user } = await userWithNews(2);
    env.deps.scriptWriter = { write: async () => Promise.reject(new Error(`model overloaded ${'x'.repeat(5000)}`)) } satisfies ScriptWriter;
    const e = await pendingEdition(env, user.id);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await claimEditions(env.deps, 5)).toEqual([e.id]);
      expect(await generateEdition(env.deps, e.id)).toBe('pending');
      expect(await reload(env, e.id)).toMatchObject({ status: 'pending', attempts: i, claimedAt: null });
    }
    expect(await claimEditions(env.deps, 5)).toEqual([e.id]);
    expect(await generateEdition(env.deps, e.id)).toBe('failed');
    const failed = await reload(env, e.id);
    expect(failed).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(failed.error!.startsWith('model overloaded')).toBe(true);
    expect(failed.error!.length).toBeLessThanOrEqual(1000);
    expect(await claimEditions(env.deps, 5)).toEqual([]);
  });

  it('falls back to the default voice when the snapshotted voice no longer exists', async () => {
    const { user } = await userWithNews(1);
    const voices: string[] = [];
    const tts = env.deps.tts;
    env.deps.tts = { ...tts, id: tts.id, voices: () => tts.voices(), defaultVoiceId: () => tts.defaultVoiceId(), synthesize: (i) => (voices.push(i.voiceId), tts.synthesize(i)) };
    const e = await pendingEdition(env, user.id, { voiceId: 'retired-voice' });
    await generateEdition(env.deps, e.id);
    expect(voices).toEqual([tts.defaultVoiceId()]);
  });

  it('uses the extended word budget and kind', async () => {
    const { user } = await userWithNews(5);
    const e = await pendingEdition(env, user.id, { kind: 'extended', targetSeconds: 900 });
    await generateEdition(env.deps, e.id);
    expect(requests[0]).toMatchObject({ kind: 'extended', targetWords: 2250 });
  });
});

describe('claimEditions', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(() => env.close());

  it('is exclusive under concurrent claims (FOR UPDATE SKIP LOCKED)', async () => {
    const user = await createUser(env.db);
    for (let i = 0; i < 20; i++) await pendingEdition(env, user.id, { slotAt: new Date(SLOT.getTime() + i * 3600_000) });
    const results = await Promise.all(Array.from({ length: 6 }, () => claimEditions(env.deps, 4)));
    const all = results.flat();
    expect(all).toHaveLength(20);
    expect(new Set(all).size).toBe(20);
    const rows = await env.db.select().from(editions);
    expect(rows.every((r) => r.status === 'scripting' && r.claimedAt?.getTime() === NOW.getTime())).toBe(true);
  });

  it('reclaims stale in-progress rows (counting an attempt) but not fresh ones', async () => {
    const user = await createUser(env.db);
    const stale = await pendingEdition(env, user.id, { status: 'synthesizing', claimedAt: new Date(NOW.getTime() - 11 * 60_000) });
    await pendingEdition(env, user.id, { slotAt: new Date(SLOT.getTime() + 3600_000), status: 'scripting', claimedAt: new Date(NOW.getTime() - 60_000) });
    const dead = await pendingEdition(env, user.id, {
      slotAt: new Date(SLOT.getTime() + 7200_000),
      status: 'scripting',
      attempts: MAX_ATTEMPTS - 1,
      claimedAt: new Date(NOW.getTime() - 3600_000),
    });
    expect(await claimEditions(env.deps, 10)).toEqual([stale.id]);
    expect(await reload(env, stale.id)).toMatchObject({ status: 'scripting', attempts: 1 });
    expect((await reload(env, dead.id)).status).toBe('failed');
  });

  it('claims earliest slots first and respects n', async () => {
    const user = await createUser(env.db);
    const late = await pendingEdition(env, user.id, { slotAt: new Date(SLOT.getTime() + 3600_000) });
    const early = await pendingEdition(env, user.id);
    expect(await claimEditions(env.deps, 1)).toEqual([early.id]);
    expect(await claimEditions(env.deps, 0)).toEqual([]);
    expect(await claimEditions(env.deps, 5)).toEqual([late.id]);
  });
});

describe('on-demand and missed editions', () => {
  const FEED_URL = 'https://feeds.example.com/fresh.xml';
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fresh</title>
    <item><guid>a1</guid><title>Harbour bridge reopens after repairs</title><description>The bridge is open again.</description><pubDate>${hoursAgo(1).toUTCString()}</pubDate></item>
    </channel></rss>`;

  it('on-demand ingests never-fetched sources first, so a brand-new subscriber gets a bulletin', async () => {
    const feeds = new FeedFetcher({ fetch: fakeFetch({ [FEED_URL]: () => new Response(rss) }).fetch, lookup: publicLookup });
    const env = await setup({ feeds });
    const user = await createUser(env.db);
    await subscribe(env.db, user.id, (await createSource(env.db, { url: FEED_URL })).id);
    const e = await pendingEdition(env, user.id, { trigger: 'on_demand', slotAt: NOW });
    expect(await generateEdition(env.deps, e.id)).toBe('ready');
    await env.close();
  });

  it('on-demand with nothing new fails with a listener-facing reason instead of vanishing as skipped', async () => {
    const env = await setup();
    const user = await createUser(env.db);
    await subscribe(env.db, user.id, (await createSource(env.db, { lastFetchedAt: NOW })).id);
    const e = await pendingEdition(env, user.id, { trigger: 'on_demand', slotAt: NOW });
    expect(await generateEdition(env.deps, e.id)).toBe('failed');
    expect((await reload(env, e.id)).error).toMatch(/No new stories/);
    await env.close();
  });

  it('scheduled editions that missed their slot by over 90 minutes are skipped, not generated late', async () => {
    const env = await setup();
    const user = await createUser(env.db);
    const late = await pendingEdition(env, user.id, { slotAt: hoursAgo(2) });
    const onDemand = await pendingEdition(env, user.id, { slotAt: hoursAgo(3), trigger: 'on_demand' });
    const due = await pendingEdition(env, user.id);
    expect((await claimEditions(env.deps, 10)).sort()).toEqual([onDemand.id, due.id].sort());
    expect((await reload(env, late.id)).status).toBe('skipped');
    await env.close();
  });
});
