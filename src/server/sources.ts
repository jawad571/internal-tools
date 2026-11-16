import { and, asc, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { sources, userSources, type Source } from '../db/schema.ts';
import { AddSourceBody, LIMITS, UpdateSourceBody, type MySourceDto, type SourceDto } from '../shared/contracts.ts';
import { FeedProbeError, type Deps } from '../shared/deps.ts';
import { requireUser } from './auth.ts';
import { HttpError, notFound, readJson, uuidParam, type AppEnv } from './http.ts';

const UNHEALTHY_FAIL_COUNT = 5;

const toSourceDto = (s: Source): SourceDto => ({
  id: s.id,
  title: s.title,
  url: s.url,
  siteUrl: s.siteUrl,
  category: s.category,
  isCurated: s.isCurated,
});

const toMySourceDto = (s: Source, weight: number): MySourceDto => ({
  ...toSourceDto(s),
  weight,
  unhealthy: s.failCount >= UNHEALTHY_FAIL_COUNT,
});

export function sourceRoutes(deps: Deps) {
  const { db } = deps;
  const app = new Hono<AppEnv>();
  app.use(requireUser(deps));

  const mySource = async (userId: string, sourceId: string) => {
    const [row] = await db
      .select({ source: sources, weight: userSources.weight })
      .from(userSources)
      .innerJoin(sources, eq(sources.id, userSources.sourceId))
      .where(and(eq(userSources.userId, userId), eq(userSources.sourceId, sourceId)));
    return row ? toMySourceDto(row.source, row.weight) : null;
  };

  /** Finds or creates the shared `sources` row for a user-supplied feed URL. */
  const resolveCustomFeed = async (url: string): Promise<Source> => {
    const [known] = await db.select().from(sources).where(eq(sources.url, url));
    if (known) return known;
    let probed;
    try {
      probed = await deps.feeds.probe(url);
    } catch (err) {
      if (err instanceof FeedProbeError) throw new HttpError(422, 'feed_unusable', err.message);
      throw err;
    }
    await db
      .insert(sources)
      .values({ url: probed.url, title: probed.title, siteUrl: probed.siteUrl, category: 'custom', isCurated: false })
      .onConflictDoNothing({ target: sources.url });
    const [row] = await db.select().from(sources).where(eq(sources.url, probed.url));
    return row!;
  };

  app.get('/catalog', async (c) => {
    const rows = await db
      .select()
      .from(sources)
      .where(eq(sources.isCurated, true))
      .orderBy(asc(sources.category), asc(sources.title));
    return c.json({ sources: rows.map(toSourceDto) });
  });

  app.get('/', async (c) => {
    const rows = await db
      .select({ source: sources, weight: userSources.weight })
      .from(userSources)
      .innerJoin(sources, eq(sources.id, userSources.sourceId))
      .where(eq(userSources.userId, c.get('user').id))
      .orderBy(asc(userSources.createdAt), asc(sources.title));
    return c.json({ sources: rows.map((r) => toMySourceDto(r.source, r.weight)) });
  });

  app.post('/', async (c) => {
    const user = c.get('user');
    const body = await readJson(c, AddSourceBody);

    let source: Source;
    if ('sourceId' in body) {
      const [row] = await db
        .select()
        .from(sources)
        .where(and(eq(sources.id, body.sourceId), eq(sources.isCurated, true)));
      if (!row) throw notFound('No such catalog source');
      source = row;
    } else {
      source = await resolveCustomFeed(body.url);
    }

    const existing = await mySource(user.id, source.id);
    if (existing) return c.json({ source: existing });

    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(userSources)
      .where(eq(userSources.userId, user.id));
    const { maxSources } = LIMITS.plans[user.plan];
    if (n >= maxSources) {
      throw new HttpError(403, 'plan_limit', `Your plan allows up to ${maxSources} sources`);
    }

    await db.insert(userSources).values({ userId: user.id, sourceId: source.id }).onConflictDoNothing();
    return c.json({ source: (await mySource(user.id, source.id))! });
  });

  app.patch('/:id', async (c) => {
    const user = c.get('user');
    const sourceId = uuidParam(c);
    const { weight } = await readJson(c, UpdateSourceBody);
    const updated = await db
      .update(userSources)
      .set({ weight })
      .where(and(eq(userSources.userId, user.id), eq(userSources.sourceId, sourceId)))
      .returning();
    if (updated.length === 0) throw notFound('Not subscribed to this source');
    return c.json({ source: (await mySource(user.id, sourceId))! });
  });

  app.delete('/:id', async (c) => {
    const sourceId = uuidParam(c);
    const deleted = await db
      .delete(userSources)
      .where(and(eq(userSources.userId, c.get('user').id), eq(userSources.sourceId, sourceId)))
      .returning();
    if (deleted.length === 0) throw notFound('Not subscribed to this source');
    return c.json({ ok: true as const });
  });

  return app;
}
