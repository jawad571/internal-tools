import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { articles, sources } from '../../src/db/schema.ts';
import { ingestDueSources } from '../../src/pipeline/ingest.ts';
import { FeedFetcher } from '../../src/providers/feeds/fetch.ts';
import { createSource, createUser, fakeFetch, NOW, publicLookup, setup, subscribe, type TestEnv } from './helpers.ts';

const rss = (items: Array<{ guid: string; title: string; date: Date }>) => `<rss version="2.0"><channel><title>Feed</title>
${items.map((i) => `<item><guid>${i.guid}</guid><title>${i.title}</title><pubDate>${i.date.toUTCString()}</pubDate><description>About ${i.title}</description></item>`).join('\n')}
</channel></rss>`;

const min = (m: number) => new Date(NOW.getTime() + m * 60_000);

describe('ingestDueSources', () => {
  let env: TestEnv;
  let routes: Record<string, (req: Request) => Response>;
  let calls: Request[];

  beforeEach(async () => {
    routes = {};
    const f = fakeFetch(new Proxy({}, { get: (_t, url: string) => routes[url] }) as typeof routes);
    calls = f.calls;
    env = await setup({ feeds: new FeedFetcher({ fetch: f.fetch, lookup: publicLookup }) });
  });
  afterEach(() => env.close());

  it('fetches only subscribed sources, dedupes items, skips stale items and stores validators', async () => {
    const user = await createUser(env.db);
    const subscribed = await createSource(env.db, { url: 'https://a.example.com/feed' });
    await createSource(env.db, { url: 'https://unsubscribed.example.com/feed' });
    await subscribe(env.db, user.id, subscribed.id);

    routes['https://a.example.com/feed'] = () =>
      new Response(
        rss([
          { guid: '1', title: 'Fresh one', date: min(-30) },
          { guid: '2', title: 'Fresh two', date: min(-120) },
          { guid: '3', title: 'Too old', date: min(-49 * 60) },
        ]),
        { headers: { etag: '"e1"', 'last-modified': 'Mon, 16 Nov 2026 08:00:00 GMT' } },
      );

    expect(await ingestDueSources(env.deps)).toEqual({ fetched: 1, failed: 0, inserted: 2 });
    expect(calls.map((c) => c.url)).toEqual(['https://a.example.com/feed']);
    const [src] = await env.db.select().from(sources).where(eq(sources.id, subscribed.id));
    expect(src).toMatchObject({ etag: '"e1"', lastModified: 'Mon, 16 Nov 2026 08:00:00 GMT', failCount: 0, lastError: null });
    expect(src!.lastFetchedAt).toEqual(NOW);

    // Not due again until INGEST_STALE_MINUTES have passed.
    expect((await ingestDueSources(env.deps)).fetched).toBe(0);

    // Re-fetch with an overlapping item set: only the new guid is inserted, conditional headers sent.
    env.setNow(min(16));
    routes['https://a.example.com/feed'] = () =>
      new Response(rss([{ guid: '1', title: 'Fresh one', date: min(-30) }, { guid: '4', title: 'Newer', date: min(10) }]));
    expect((await ingestDueSources(env.deps)).inserted).toBe(1);
    expect(calls.at(-1)!.headers.get('if-none-match')).toBe('"e1"');
    expect((await env.db.select().from(articles)).map((a) => a.guid).sort()).toEqual(['1', '2', '4']);
  });

  it('handles 304 by keeping validators', async () => {
    const user = await createUser(env.db);
    const s = await createSource(env.db, { url: 'https://a.example.com/feed' });
    await env.db.update(sources).set({ etag: '"old"' }).where(eq(sources.id, s.id));
    await subscribe(env.db, user.id, s.id);
    routes['https://a.example.com/feed'] = () => new Response(null, { status: 304 });
    expect(await ingestDueSources(env.deps)).toEqual({ fetched: 1, failed: 0, inserted: 0 });
    const [src] = await env.db.select().from(sources);
    expect(src!.etag).toBe('"old"');
  });

  it('records failures, backs off progressively, keeps going, and resets on success', async () => {
    const user = await createUser(env.db);
    const bad = await createSource(env.db, { url: 'https://bad.example.com/feed' });
    const good = await createSource(env.db, { url: 'https://good.example.com/feed' });
    await subscribe(env.db, user.id, bad.id);
    await subscribe(env.db, user.id, good.id);
    routes['https://bad.example.com/feed'] = () => new Response('oops', { status: 500 });
    routes['https://good.example.com/feed'] = () => new Response(rss([{ guid: 'g', title: 'Good', date: min(-5) }]));

    expect(await ingestDueSources(env.deps)).toEqual({ fetched: 1, failed: 1, inserted: 1 });
    let [b] = await env.db.select().from(sources).where(eq(sources.id, bad.id));
    expect(b).toMatchObject({ failCount: 1 });
    expect(b!.lastError).toMatch(/HTTP 500/);

    // failCount 1 -> next retry after 15 × 2 = 30 min (the healthy feed is due after 15).
    env.setNow(min(16));
    const badCalls = () => calls.filter((c) => c.url.startsWith('https://bad')).length;
    await ingestDueSources(env.deps);
    expect(badCalls()).toBe(1);
    env.setNow(min(31));
    await ingestDueSources(env.deps);
    expect(badCalls()).toBe(2);
    [b] = await env.db.select().from(sources).where(eq(sources.id, bad.id));
    expect(b!.failCount).toBe(2);

    // failCount 2 -> 60 min after the last attempt
    env.setNow(min(31 + 59));
    await ingestDueSources(env.deps);
    expect(badCalls()).toBe(2);
    env.setNow(min(31 + 61));
    routes['https://bad.example.com/feed'] = () => new Response(rss([]));
    await ingestDueSources(env.deps);
    [b] = await env.db.select().from(sources).where(eq(sources.id, bad.id));
    expect(b).toMatchObject({ failCount: 0, lastError: null });
  });

  it('treats a non-feed response as a failure', async () => {
    const user = await createUser(env.db);
    const s = await createSource(env.db, { url: 'https://html.example.com/' });
    await subscribe(env.db, user.id, s.id);
    routes['https://html.example.com/'] = () => new Response('<html><body>hi</body></html>');
    expect((await ingestDueSources(env.deps)).failed).toBe(1);
    expect((await env.db.select().from(sources))[0]!.lastError).toMatch(/not an RSS/);
  });
});
