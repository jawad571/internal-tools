import { and, asc, count, desc, eq, gte, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { articles, editionArticles, editions, sources, userSources, users, type Edition, type User } from '../db/schema.ts';
import { GenerateNowBody, LIMITS, type EditionDetailDto, type EditionDto } from '../shared/contracts.ts';
import type { Deps } from '../shared/deps.ts';
import { localHourOf } from '../shared/time.ts';
import { serveEditionAudio } from './audio.ts';
import { requireUser, sessionUser, touchActivity } from './auth.ts';
import { HttpError, notFound, readJson, uuidParam, type AppEnv } from './http.ts';
import { loadPreferences } from './preferences.ts';
import { RateLimiter } from './rate-limit.ts';

const IN_PROGRESS = ['pending', 'scripting', 'synthesizing'] as const;

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).catch(20).transform((n) => Math.min(n, 50)),
  before: z.iso.datetime({ offset: true }).optional(),
});

const storyCount = sql<number>`(select count(*)::int from ${editionArticles} where ${editionArticles.editionId} = ${editions.id})`;

export const toEditionDto = (e: Edition, stories: number): EditionDto => ({
  id: e.id,
  slotAt: e.slotAt.toISOString(),
  localHour: e.localHour,
  kind: e.kind,
  trigger: e.trigger,
  status: e.status,
  title: e.title,
  durationSeconds: e.durationSeconds,
  audioUrl: e.status === 'ready' ? `/api/editions/${e.id}/audio` : null,
  listened: e.listenedAt !== null,
  storyCount: stories,
});

export function editionRoutes(deps: Deps) {
  const { db } = deps;
  const generateLimiter = new RateLimiter(5, 60_000, deps.now);
  // Not app.use(): the audio route below accepts a feed token instead of a session.
  const auth = requireUser(deps);
  const app = new Hono<AppEnv>();

  const ownEdition = async (userId: string, id: string) => {
    const [row] = await db
      .select()
      .from(editions)
      .where(and(eq(editions.id, id), eq(editions.userId, userId)));
    if (!row) throw notFound('Edition not found');
    return row;
  };

  app.get('/', auth, async (c) => {
    const q = ListQuery.safeParse(c.req.query());
    if (!q.success) throw new HttpError(400, 'invalid_query', '`before` must be an ISO datetime');
    const where: SQL[] = [eq(editions.userId, c.get('user').id), ne(editions.status, 'skipped')];
    if (q.data.before) where.push(lt(editions.slotAt, new Date(q.data.before)));
    const rows = await db
      .select({ edition: editions, storyCount })
      .from(editions)
      .where(and(...where))
      .orderBy(desc(editions.slotAt))
      .limit(q.data.limit);
    return c.json({ editions: rows.map((r) => toEditionDto(r.edition, r.storyCount)) });
  });

  app.post('/generate', auth, async (c) => {
    const user = c.get('user');
    const { kind } = await readJson(c, GenerateNowBody, { allowEmpty: true });
    generateLimiter.hit(user.id);
    const now = deps.now();

    const [{ n: sourceCount } = { n: 0 }] = await db
      .select({ n: count() })
      .from(userSources)
      .where(eq(userSources.userId, user.id));
    if (sourceCount === 0) throw new HttpError(409, 'no_sources', 'Add at least one source first');

    const onDemand = and(eq(editions.userId, user.id), eq(editions.trigger, 'on_demand'));
    const [busy] = await db
      .select({ id: editions.id })
      .from(editions)
      .where(and(onDemand, inArray(editions.status, IN_PROGRESS)))
      .limit(1);
    if (busy) throw new HttpError(409, 'generation_in_progress', 'An edition is already being prepared');

    const [{ n: today } = { n: 0 }] = await db
      .select({ n: count() })
      .from(editions)
      .where(and(onDemand, gte(editions.slotAt, new Date(now.getTime() - 24 * 3600_000))));
    const { onDemandPerDay } = LIMITS.plans[user.plan];
    if (today >= onDemandPerDay) {
      throw new HttpError(429, 'daily_limit', `Your plan allows ${onDemandPerDay} on-demand editions a day`);
    }

    const prefs = await loadPreferences(deps, user.id);
    const minutes = kind === 'extended' ? prefs.extendedMinutes : prefs.standardMinutes;
    // Truncated to the second; slot_at is part of the (user_id, slot_at) unique index.
    const slotAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
    const [edition] = await db
      .insert(editions)
      .values({
        userId: user.id,
        slotAt,
        localHour: localHourOf(slotAt, user.timezone),
        kind,
        trigger: 'on_demand',
        status: 'pending',
        targetSeconds: minutes * 60,
        voiceId: prefs.voiceId,
        tone: prefs.tone,
      })
      .onConflictDoNothing()
      .returning();
    if (!edition) throw new HttpError(409, 'slot_taken', 'An edition for this moment already exists; try again');
    return c.json({ edition: toEditionDto(edition, 0) }, 202);
  });

  app.get('/:id', auth, async (c) => {
    const edition = await ownEdition(c.get('user').id, uuidParam(c));
    const stories = await db
      .select({
        title: articles.title,
        url: articles.url,
        sourceTitle: sources.title,
        publishedAt: articles.publishedAt,
      })
      .from(editionArticles)
      .innerJoin(articles, eq(articles.id, editionArticles.articleId))
      .innerJoin(sources, eq(sources.id, articles.sourceId))
      .where(eq(editionArticles.editionId, edition.id))
      .orderBy(asc(editionArticles.position));
    const detail: EditionDetailDto = {
      ...toEditionDto(edition, stories.length),
      script: edition.script,
      error: edition.error,
      stories: stories.map((s) => ({ ...s, publishedAt: s.publishedAt.toISOString() })),
    };
    return c.json({ edition: detail });
  });

  app.post('/:id/listened', auth, async (c) => {
    const updated = await db
      .update(editions)
      .set({ listenedAt: deps.now() })
      .where(and(eq(editions.id, uuidParam(c)), eq(editions.userId, c.get('user').id)))
      .returning({ id: editions.id });
    if (updated.length === 0) throw notFound('Edition not found');
    return c.json({ ok: true as const });
  });

  app.get('/:id/audio', async (c) => {
    const id = uuidParam(c);
    const token = c.req.query('token');
    let user: User | null;
    if (token !== undefined) {
      // Podcast apps can't send cookies; the feed token is the credential. Any mismatch is a 404.
      [user = null] = await db.select().from(users).where(eq(users.feedToken, token));
      if (!user) throw notFound('Edition not found');
    } else {
      user = await sessionUser(c, deps);
      if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in required');
    }
    const edition = await ownEdition(user.id, id);
    await touchActivity(deps, user);
    return serveEditionAudio(c, deps, edition);
  });

  return app;
}
