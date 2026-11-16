import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editionArticles, editions } from '../../src/db/schema.ts';
import { headlineTokens, jaccard, rankStories, selectStories, type Candidate } from '../../src/pipeline/select.ts';
import { addArticle, createSource, createUser, hoursAgo, NOW, setup, subscribe, type TestEnv } from './helpers.ts';

const SLOT = new Date('2026-11-16T09:00:00Z');

describe('headline similarity', () => {
  it('scores rewrites of the same story highly and different stories low', () => {
    const a = headlineTokens('Bank of England raises interest rates to 5.25%');
    const b = headlineTokens('Bank of England raises rates to 5.25 percent');
    const c = headlineTokens('Storm Ciarán batters south coast');
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(0.5);
    expect(jaccard(a, c)).toBe(0);
  });
});

describe('rankStories', () => {
  const cand = (id: string, sourceId: string, title: string, ageH: number, weight = 1): Candidate => ({
    articleId: id,
    sourceId,
    title,
    sourceTitle: sourceId,
    summary: '',
    publishedAt: hoursAgo(ageH),
    weight,
  });

  it('caps any single source share but tops up when sources are scarce', () => {
    const many = Array.from({ length: 10 }, (_, i) => cand(`a${i}`, 'A', `Unique story about topic ${'xyzw'[i % 4]}${i} alpha${i}`, 0.1 * i, 3));
    const few = [cand('b1', 'B', 'Something else entirely', 1), cand('c1', 'C', 'A third distinct item', 1), cand('d1', 'D', 'Fourth unrelated report', 1)];
    const out = rankStories([...many, ...few], { now: NOW, kind: 'standard', count: 5 });
    expect(out).toHaveLength(5);
    expect(out.filter((s) => s.sourceTitle === 'A')).toHaveLength(2);
    const onlyA = rankStories(many, { now: NOW, kind: 'standard', count: 5 });
    expect(onlyA).toHaveLength(5);
  });

  it('boosts stories carried by several sources', () => {
    const out = rankStories(
      [
        cand('solo', 'A', 'Local bakery wins award', 0.5),
        cand('x1', 'B', 'Prime minister announces snap election', 1),
        cand('x2', 'C', 'Prime minister announces snap general election', 1),
        cand('x3', 'D', 'Snap election announced by prime minister', 1),
      ],
      { now: NOW, kind: 'standard', count: 5 },
    );
    expect(out.map((s) => s.articleId)).toHaveLength(2);
    expect(out[0]!.title).toMatch(/election/);
  });
});

describe('selectStories', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(() => env.close());

  it('dedupes across sources keeping the higher-weight source, orders by weight, excludes covered articles', async () => {
    const user = await createUser(env.db);
    const bbc = await createSource(env.db, { title: 'BBC News' });
    const reuters = await createSource(env.db, { title: 'Reuters' });
    const blog = await createSource(env.db, { title: 'Tech Blog' });
    await subscribe(env.db, user.id, bbc.id, 1);
    await subscribe(env.db, user.id, reuters.id, 3);
    await subscribe(env.db, user.id, blog.id, 2);

    await addArticle(env.db, bbc.id, { title: 'Earthquake strikes northern Japan, tsunami warning issued', publishedAt: hoursAgo(1) });
    const r1 = await addArticle(env.db, reuters.id, { title: 'Tsunami warning issued after earthquake strikes northern Japan', publishedAt: hoursAgo(1.5) });
    const b1 = await addArticle(env.db, blog.id, { title: 'New phone review roundup', publishedAt: hoursAgo(0.5) });
    const covered = await addArticle(env.db, blog.id, { title: 'Already covered gadget news', publishedAt: hoursAgo(0.5) });
    const r2 = await addArticle(env.db, reuters.id, { title: 'Oil prices slip on demand worries', publishedAt: hoursAgo(2.5) });

    const [prev] = await env.db
      .insert(editions)
      .values({ userId: user.id, slotAt: hoursAgo(3, SLOT), localHour: 6, kind: 'standard', status: 'ready', targetSeconds: 420, voiceId: 'v', tone: 'neutral' })
      .returning();
    await env.db.insert(editionArticles).values({ editionId: prev!.id, articleId: covered.id, position: 0 });

    const { stories } = await selectStories(env.deps, user.id, { kind: 'standard', slotAt: SLOT });
    const ids = stories.map((s) => s.articleId);
    expect(ids[0]).toBe(r1.id); // cluster of 2 sources, represented by weight-3 Reuters
    expect(ids).not.toContain(covered.id);
    expect(ids).toEqual([r1.id, b1.id, r2.id]);
    expect(stories[0]).toMatchObject({ sourceTitle: 'Reuters', weight: 3 });
  });

  it('uses a lookback since the previous ready edition, clamped to 2-6h; extended uses 14h', async () => {
    const user = await createUser(env.db);
    const src = await createSource(env.db);
    await subscribe(env.db, user.id, src.id);
    const a1 = await addArticle(env.db, src.id, { title: 'Ninety minutes old story alpha', publishedAt: hoursAgo(1.5, SLOT) });
    const a3 = await addArticle(env.db, src.id, { title: 'Three hours old story bravo', publishedAt: hoursAgo(3, SLOT) });
    const a5 = await addArticle(env.db, src.id, { title: 'Five hours old story charlie', publishedAt: hoursAgo(5, SLOT) });
    const a10 = await addArticle(env.db, src.id, { title: 'Ten hours old story delta', publishedAt: hoursAgo(10, SLOT) });
    const a20 = await addArticle(env.db, src.id, { title: 'Twenty hours old story echo', publishedAt: hoursAgo(20, SLOT) });
    const pick = async (kind: 'standard' | 'extended') =>
      new Set((await selectStories(env.deps, user.id, { kind, slotAt: SLOT })).stories.map((s) => s.articleId));

    // No previous edition -> 6h
    expect(await pick('standard')).toEqual(new Set([a1.id, a3.id, a5.id]));
    expect(await pick('extended')).toEqual(new Set([a1.id, a3.id, a5.id, a10.id]));

    // Previous ready edition 1h ago -> clamped up to 2h
    await env.db
      .insert(editions)
      .values({ userId: user.id, slotAt: hoursAgo(1, SLOT), localHour: 8, kind: 'standard', status: 'ready', targetSeconds: 420, voiceId: 'v', tone: 'neutral' });
    expect(await pick('standard')).toEqual(new Set([a1.id]));
    expect(a20).toBeTruthy();
  });

  it('returns previouslyCovered from earlier editions on the same local day only', async () => {
    const user = await createUser(env.db, { timezone: 'America/New_York' }); // 09:00Z = 04:00 local
    const src = await createSource(env.db);
    await subscribe(env.db, user.id, src.id);
    const today = await addArticle(env.db, src.id, { title: 'Covered at 3am local', publishedAt: hoursAgo(2, SLOT) });
    const yesterday = await addArticle(env.db, src.id, { title: 'Covered yesterday evening', publishedAt: hoursAgo(6, SLOT) });
    const mk = async (slotAt: Date, articleId: string) => {
      const [e] = await env.db
        .insert(editions)
        .values({ userId: user.id, slotAt, localHour: 0, kind: 'standard', status: 'ready', targetSeconds: 420, voiceId: 'v', tone: 'neutral' })
        .returning();
      await env.db.insert(editionArticles).values({ editionId: e!.id, articleId, position: 0 });
    };
    await mk(hoursAgo(1, SLOT), today.id); // 03:00 local today
    await mk(hoursAgo(5, SLOT), yesterday.id); // 23:00 local yesterday
    const { previouslyCovered } = await selectStories(env.deps, user.id, { kind: 'standard', slotAt: SLOT });
    expect(previouslyCovered).toEqual(['Covered at 3am local']);
  });

  it('returns about 1.5x as many stories as the budget needs', async () => {
    const user = await createUser(env.db);
    const sources = await Promise.all(Array.from({ length: 6 }, (_, i) => createSource(env.db, { title: `S${i}` })));
    for (const s of sources) await subscribe(env.db, user.id, s.id);
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'.split(' ');
    for (let i = 0; i < 40; i++) {
      await addArticle(env.db, sources[i % 6]!.id, { title: `${words[i % 20]} ${words[(i * 7 + 3) % 20]} report number ${i}`, publishedAt: hoursAgo(0.1 * i) });
    }
    const { stories } = await selectStories(env.deps, user.id, { kind: 'standard', slotAt: SLOT, targetWords: 900 });
    expect(stories).toHaveLength(15); // 900 / 90 × 1.5
  });
});
