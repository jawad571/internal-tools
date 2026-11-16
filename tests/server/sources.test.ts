import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { sources, users } from '../../src/db/schema.ts';
import { CATALOG, seedCatalog } from '../../src/server/catalog.ts';
import { LIMITS } from '../../src/shared/contracts.ts';
import { useCtx, type Ctx } from './helpers.ts';

const getCtx = useCtx();
let ctx: Ctx;
beforeEach(async () => {
  ctx = getCtx();
  await seedCatalog(ctx.db);
});

const catalog = async (cookie: string) =>
  (await (await ctx.call('GET', '/api/sources/catalog', { cookie })).json()).sources as Array<{ id: string; url: string }>;

describe('catalog', () => {
  it('seeds idempotently and preserves fetch state', async () => {
    const [first] = await ctx.db.select().from(sources).where(eq(sources.url, CATALOG[0]!.url));
    await ctx.db.update(sources).set({ failCount: 3 }).where(eq(sources.id, first!.id));
    await seedCatalog(ctx.db);
    const all = await ctx.db.select().from(sources);
    expect(all).toHaveLength(CATALOG.length);
    expect(new Set(CATALOG.map((f) => f.url)).size).toBe(CATALOG.length);
    expect(all.find((s) => s.id === first!.id)!.failCount).toBe(3);
  });

  it('lists only curated sources and requires auth', async () => {
    expect((await ctx.call('GET', '/api/sources/catalog')).status).toBe(401);
    const { cookie } = await ctx.signup();
    await ctx.db.insert(sources).values({ url: 'https://custom.example/feed', title: 'Custom', isCurated: false });
    const list = await catalog(cookie);
    expect(list).toHaveLength(CATALOG.length);
    expect(list.some((s) => s.url === 'https://custom.example/feed')).toBe(false);
  });
});

describe('subscriptions', () => {
  it('subscribe by catalog id, update weight, unsubscribe', async () => {
    const { cookie } = await ctx.signup();
    const [first] = await catalog(cookie);
    const add = await ctx.call('POST', '/api/sources', { cookie, body: { sourceId: first!.id } });
    expect(add.status).toBe(200);
    expect((await add.json()).source).toMatchObject({ id: first!.id, weight: 1, unhealthy: false, isCurated: true });

    // idempotent
    expect((await ctx.call('POST', '/api/sources', { cookie, body: { sourceId: first!.id } })).status).toBe(200);

    const patch = await ctx.call('PATCH', `/api/sources/${first!.id}`, { cookie, body: { weight: 3 } });
    expect((await patch.json()).source.weight).toBe(3);
    expect((await ctx.call('PATCH', `/api/sources/${first!.id}`, { cookie, body: { weight: 4 } })).status).toBe(400);

    await ctx.db.update(sources).set({ failCount: 5 }).where(eq(sources.id, first!.id));
    const mine = (await (await ctx.call('GET', '/api/sources', { cookie })).json()).sources;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ weight: 3, unhealthy: true });

    expect(await (await ctx.call('DELETE', `/api/sources/${first!.id}`, { cookie })).json()).toEqual({ ok: true });
    expect((await (await ctx.call('GET', '/api/sources', { cookie })).json()).sources).toEqual([]);
    expect((await ctx.call('DELETE', `/api/sources/${first!.id}`, { cookie })).status).toBe(404);
  });

  it('unknown catalog id and non-uuid ids are 404', async () => {
    const { cookie } = await ctx.signup();
    const res = await ctx.call('POST', '/api/sources', { cookie, body: { sourceId: '00000000-0000-4000-8000-000000000000' } });
    expect(res.status).toBe(404);
    expect((await ctx.call('PATCH', '/api/sources/not-a-uuid', { cookie, body: { weight: 2 } })).status).toBe(404);
  });

  it('isolates users from each other', async () => {
    const a = await ctx.signup('a@example.com');
    const b = await ctx.signup('b@example.com');
    const [first] = await catalog(a.cookie);
    await ctx.call('POST', '/api/sources', { cookie: a.cookie, body: { sourceId: first!.id } });

    expect((await (await ctx.call('GET', '/api/sources', { cookie: b.cookie })).json()).sources).toEqual([]);
    expect((await ctx.call('PATCH', `/api/sources/${first!.id}`, { cookie: b.cookie, body: { weight: 2 } })).status).toBe(404);
    expect((await ctx.call('DELETE', `/api/sources/${first!.id}`, { cookie: b.cookie })).status).toBe(404);
    // A's subscription untouched
    const mine = (await (await ctx.call('GET', '/api/sources', { cookie: a.cookie })).json()).sources;
    expect(mine).toMatchObject([{ id: first!.id, weight: 1 }]);
  });

  it('enforces the plan source limit', async () => {
    const { cookie, me } = await ctx.signup();
    const list = await catalog(cookie);
    const max = LIMITS.plans.free.maxSources;
    for (const s of list.slice(0, max)) {
      expect((await ctx.call('POST', '/api/sources', { cookie, body: { sourceId: s.id } })).status).toBe(200);
    }
    const over = await ctx.call('POST', '/api/sources', { cookie, body: { sourceId: list[max]!.id } });
    expect(over.status).toBe(403);
    expect((await over.json()).error.code).toBe('plan_limit');

    await ctx.db.update(users).set({ plan: 'pro' }).where(eq(users.id, me.id));
    expect((await ctx.call('POST', '/api/sources', { cookie, body: { sourceId: list[max]!.id } })).status).toBe(200);
  });

  it('adds a custom feed by url, reusing the shared row', async () => {
    const a = await ctx.signup('a@example.com');
    const b = await ctx.signup('b@example.com');
    const res = await ctx.call('POST', '/api/sources', { cookie: a.cookie, body: { url: 'https://ok.example/rss/' } });
    expect(res.status).toBe(200);
    const { source } = await res.json();
    expect(source).toMatchObject({ url: 'https://ok.example/rss', category: 'custom', isCurated: false, title: 'Feed at /rss/' });

    const again = await ctx.call('POST', '/api/sources', { cookie: b.cookie, body: { url: 'https://ok.example/rss' } });
    expect((await again.json()).source.id).toBe(source.id);
    expect(await ctx.db.select().from(sources).where(eq(sources.url, 'https://ok.example/rss'))).toHaveLength(1);
    // custom feeds don't leak into the catalog
    expect((await catalog(a.cookie)).some((s) => s.id === source.id)).toBe(false);
  });

  it('maps FeedProbeError to 422 with its message', async () => {
    const { cookie } = await ctx.signup();
    const res = await ctx.call('POST', '/api/sources', { cookie, body: { url: 'http://127.0.0.1/feed' } });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toEqual({ code: 'feed_unusable', message: 'That address did not return an RSS or Atom feed' });
    expect((await ctx.call('POST', '/api/sources', { cookie, body: { url: 'not a url' } })).status).toBe(400);
  });
});
