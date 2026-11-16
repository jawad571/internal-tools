import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { articles, editionArticles, editions, users } from '../../src/db/schema.ts';
import { addSource, insertReadyEdition, useCtx, type Ctx } from './helpers.ts';

const getCtx = useCtx();
let ctx: Ctx;
beforeEach(() => (ctx = getCtx()));

describe('generate now', () => {
  it('queues a pending on-demand edition from prefs', async () => {
    const { cookie, me } = await ctx.signup('a@example.com', { timezone: 'Asia/Kolkata' });
    await addSource(ctx, me.id);
    ctx.clock.now = new Date('2026-11-16T09:20:00.789Z');

    const res = await ctx.call('POST', '/api/editions/generate', { cookie, body: { kind: 'extended' } });
    expect(res.status).toBe(202);
    const { edition } = await res.json();
    expect(edition).toMatchObject({
      slotAt: '2026-11-16T09:20:00.000Z',
      localHour: 14, // 09:20Z = 14:50 IST
      kind: 'extended',
      trigger: 'on_demand',
      status: 'pending',
      audioUrl: null,
      listened: false,
      storyCount: 0,
    });
    const [row] = await ctx.db.select().from(editions).where(eq(editions.id, edition.id));
    expect(row).toMatchObject({ targetSeconds: 15 * 60, voiceId: 'ava', tone: 'neutral', userId: me.id });
  });

  it('snapshots the bulletin language and voice; the DTO carries the language', async () => {
    const { cookie, me } = await ctx.signup();
    await addSource(ctx, me.id);
    await ctx.call('PUT', '/api/preferences', { cookie, body: { language: 'ur' } });
    const { edition } = await (await ctx.call('POST', '/api/editions/generate', { cookie, body: {} })).json();
    expect(edition.language).toBe('ur');
    const [row] = await ctx.db.select().from(editions).where(eq(editions.id, edition.id));
    expect(row).toMatchObject({ language: 'ur', voiceId: 'noor' });
  });

  it('defaults to standard when the body is omitted', async () => {
    const { cookie, me } = await ctx.signup();
    await addSource(ctx, me.id);
    const res = await ctx.app.request('/api/editions/generate', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(202);
    expect((await res.json()).edition.kind).toBe('standard');
  });

  it('refuses with no sources', async () => {
    const { cookie } = await ctx.signup();
    const res = await ctx.call('POST', '/api/editions/generate', { cookie, body: {} });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('no_sources');
  });

  it('refuses while one is in progress, then enforces the daily limit', async () => {
    const { cookie, me } = await ctx.signup();
    await addSource(ctx, me.id);
    const gen = () => ctx.call('POST', '/api/editions/generate', { cookie, body: {} });
    const finish = () => ctx.db.update(editions).set({ status: 'ready' }).where(eq(editions.userId, me.id));

    expect((await gen()).status).toBe(202);
    const busy = await gen();
    expect(busy.status).toBe(409);
    expect((await busy.json()).error.code).toBe('generation_in_progress');

    await finish();
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
    expect((await gen()).status).toBe(202); // 2nd of 2 (free plan)
    await finish();
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
    const limited = await gen();
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe('daily_limit');

    // the window is a rolling 24h
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 24 * 3600_000);
    expect((await gen()).status).toBe(202);
  });
});

describe('list & detail', () => {
  it('lists newest first, excludes skipped, paginates with before/limit', async () => {
    const { cookie, me } = await ctx.signup();
    for (let h = 1; h <= 5; h++) {
      await insertReadyEdition(ctx, me.id, { slotAt: new Date(`2026-11-16T0${h}:00:00Z`), localHour: h });
    }
    await insertReadyEdition(ctx, me.id, { slotAt: new Date('2026-11-16T06:00:00Z'), status: 'skipped' });

    const all = (await (await ctx.call('GET', '/api/editions', { cookie })).json()).editions;
    expect(all.map((e: { localHour: number }) => e.localHour)).toEqual([5, 4, 3, 2, 1]);
    expect(all[0].audioUrl).toBe(`/api/editions/${all[0].id}/audio`);

    const page = (await (await ctx.call('GET', '/api/editions?limit=2&before=2026-11-16T04:00:00Z', { cookie })).json()).editions;
    expect(page.map((e: { localHour: number }) => e.localHour)).toEqual([3, 2]);
    expect((await ctx.call('GET', '/api/editions?before=yesterday', { cookie })).status).toBe(400);
  });

  it('detail includes script and ordered stories', async () => {
    const { cookie, me } = await ctx.signup();
    const src = await addSource(ctx, me.id);
    const e = await insertReadyEdition(ctx, me.id);
    const [a1, a2] = await ctx.db
      .insert(articles)
      .values([
        { sourceId: src.id, guid: '1', title: 'Second', url: 'https://x/2', imageUrl: 'https://img.example/2.jpg', publishedAt: new Date('2026-11-16T07:00:00Z') },
        { sourceId: src.id, guid: '2', title: 'First', url: null, publishedAt: new Date('2026-11-16T08:00:00Z') },
      ])
      .returning();
    await ctx.db.insert(editionArticles).values([
      { editionId: e.id, articleId: a1!.id, position: 1 },
      { editionId: e.id, articleId: a2!.id, position: 0 },
    ]);
    await ctx.db
      .update(editions)
      .set({
        segments: [
          { articleId: null, start: 0, end: 4.5 },
          { articleId: a2!.id, start: 4.5, end: 200 },
          { articleId: a1!.id, start: 200, end: 420 },
          { articleId: null, start: 420, end: 425 },
        ],
      })
      .where(eq(editions.id, e.id));

    const { edition } = await (await ctx.call('GET', `/api/editions/${e.id}`, { cookie })).json();
    expect(edition).toMatchObject({ script: 'Hello.', error: null, storyCount: 2, durationSeconds: 425 });
    expect(edition.stories).toEqual([
      { title: 'First', url: null, sourceTitle: 'Src', publishedAt: '2026-11-16T08:00:00.000Z', imageUrl: null, startSeconds: 4.5 },
      {
        title: 'Second',
        url: 'https://x/2',
        sourceTitle: 'Src',
        publishedAt: '2026-11-16T07:00:00.000Z',
        imageUrl: 'https://img.example/2.jpg',
        startSeconds: 200,
      },
    ]);
    expect(edition).toMatchObject({ videoStatus: 'none', videoUrl: null });
    const list = (await (await ctx.call('GET', '/api/editions', { cookie })).json()).editions;
    expect(list[0].storyCount).toBe(2);
  });

  it('marks listened', async () => {
    const { cookie, me } = await ctx.signup();
    const e = await insertReadyEdition(ctx, me.id);
    expect(await (await ctx.call('POST', `/api/editions/${e.id}/listened`, { cookie })).json()).toEqual({ ok: true });
    expect((await (await ctx.call('GET', `/api/editions/${e.id}`, { cookie })).json()).edition.listened).toBe(true);
  });

  it("isolates one user's editions from another", async () => {
    const a = await ctx.signup('a@example.com');
    const b = await ctx.signup('b@example.com');
    const e = await insertReadyEdition(ctx, a.me.id);

    expect((await ctx.call('GET', `/api/editions/${e.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await ctx.call('POST', `/api/editions/${e.id}/listened`, { cookie: b.cookie })).status).toBe(404);
    expect((await ctx.call('GET', `/api/editions/${e.id}/audio`, { cookie: b.cookie })).status).toBe(404);
    expect((await ctx.call('GET', `/api/editions/${e.id}/audio?token=${b.feedToken}`)).status).toBe(404);
    expect((await (await ctx.call('GET', '/api/editions', { cookie: b.cookie })).json()).editions).toEqual([]);
    const [row] = await ctx.db.select().from(editions).where(eq(editions.id, e.id));
    expect(row!.listenedAt).toBeNull();
  });
});

describe('audio', () => {
  let cookie: string;
  let feedToken: string;
  let url: string;
  let userId: string;
  beforeEach(async () => {
    ({ cookie, feedToken, me: { id: userId } } = await ctx.signup());
    url = `/api/editions/${(await insertReadyEdition(ctx, userId)).id}/audio`;
  });

  const get = (range?: string, path = url, withCookie = true) =>
    ctx.call('GET', path, { cookie: withCookie ? cookie : undefined, headers: range ? { range } : {} });

  it('serves the full file', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('20');
    expect(await res.text()).toBe('0123456789ABCDEFGHIJ');
  });

  it.each([
    ['bytes=0-9', '0123456789', 'bytes 0-9/20'],
    ['bytes=5-', '56789ABCDEFGHIJ', 'bytes 5-19/20'],
    ['bytes=-4', 'GHIJ', 'bytes 16-19/20'],
    ['bytes=15-99', 'FGHIJ', 'bytes 15-19/20'],
  ])('serves %s as 206', async (range, body, contentRange) => {
    const res = await get(range);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(contentRange);
    expect(res.headers.get('content-length')).toBe(String(body.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe(body);
  });

  it('returns 416 for unsatisfiable ranges', async () => {
    for (const range of ['bytes=20-', 'bytes=50-60', 'bytes=-0']) {
      const res = await get(range);
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe('bytes */20');
    }
  });

  it('ignores malformed ranges', async () => {
    expect((await get('items=0-3')).status).toBe(200);
    expect((await get('bytes=0-1,4-5')).status).toBe(200);
  });

  it('HEAD reports length without a body', async () => {
    const res = await ctx.app.request(url, { method: 'HEAD', headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('20');
  });

  it('authenticates by feed token, and bumps activity', async () => {
    ctx.clock.now = new Date(Date.now() + 3600_000);
    const res = await get('bytes=-4', `${url}?token=${feedToken}`, false);
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('GHIJ');
    const [u] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(u!.lastActiveAt.getTime()).toBe(ctx.clock.now.getTime());
  });

  it('wrong token is 404, no credentials is 401', async () => {
    expect((await get(undefined, `${url}?token=nope`, false)).status).toBe(404);
    const anon = await get(undefined, url, false);
    expect(anon.status).toBe(401);
    expect((await anon.json()).error.code).toBe('unauthenticated');
  });

  it('404s for editions that are not ready', async () => {
    const pending = await insertReadyEdition(ctx, userId, { slotAt: new Date('2026-11-16T10:00:00Z'), status: 'pending' });
    expect((await get(undefined, `/api/editions/${pending.id}/audio`)).status).toBe(404);
  });
});

describe('video', () => {
  const MP4 = Buffer.from('ftypisomVIDEOBYTES0123456789'); // 28 bytes

  async function withVideo(userId: string, over: Partial<typeof editions.$inferInsert> = {}) {
    const key = `editions/${userId}/${Math.random()}.mp4`;
    await ctx.deps.blobs.put(key, MP4, 'video/mp4');
    return insertReadyEdition(ctx, userId, { videoStatus: 'ready', videoKey: key, videoBytes: MP4.length, ...over });
  }

  it('lists videoUrl only when the video is ready, and serves it with Range', async () => {
    const { cookie, me } = await ctx.signup();
    const e = await withVideo(me.id);
    const pending = await insertReadyEdition(ctx, me.id, { slotAt: new Date('2026-11-16T08:00:00Z'), videoStatus: 'pending' });
    const list = (await (await ctx.call('GET', '/api/editions', { cookie })).json()).editions;
    const byId = Object.fromEntries(list.map((x: { id: string }) => [x.id, x]));
    expect(byId[e.id]).toMatchObject({ videoStatus: 'ready', videoUrl: `/api/editions/${e.id}/video` });
    // VIDEO_ENABLED is off in this server: a stranded pending render is reported as none.
    expect(byId[pending.id]).toMatchObject({ videoStatus: 'none', videoUrl: null });

    const full = await ctx.call('GET', `/api/editions/${e.id}/video`, { cookie });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer()).equals(MP4)).toBe(true);

    const part = await ctx.call('GET', `/api/editions/${e.id}/video`, { cookie, headers: { range: 'bytes=0-7' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 0-7/28');
    expect(await part.text()).toBe('ftypisom');
  });

  it('accepts the feed token, isolates users, and 404s without a ready video', async () => {
    const a = await ctx.signup('a@example.com');
    const b = await ctx.signup('b@example.com');
    const e = await withVideo(a.me.id);
    expect((await ctx.call('GET', `/api/editions/${e.id}/video?token=${a.feedToken}`)).status).toBe(200);
    expect((await ctx.call('GET', `/api/editions/${e.id}/video?token=${b.feedToken}`)).status).toBe(404);
    expect((await ctx.call('GET', `/api/editions/${e.id}/video`, { cookie: b.cookie })).status).toBe(404);
    expect((await ctx.call('GET', `/api/editions/${e.id}/video`)).status).toBe(401);
    const failed = await withVideo(a.me.id, { slotAt: new Date('2026-11-16T07:00:00Z'), videoStatus: 'failed' });
    expect((await ctx.call('GET', `/api/editions/${failed.id}/video`, { cookie: a.cookie })).status).toBe(404);
    const audioOnly = await insertReadyEdition(ctx, a.me.id, { slotAt: new Date('2026-11-16T06:00:00Z') });
    expect((await ctx.call('GET', `/api/editions/${audioOnly.id}/video`, { cookie: a.cookie })).status).toBe(404);
  });
});
