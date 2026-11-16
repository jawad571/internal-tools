import { and, desc, eq, gte, lt, max, notExists, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { articles, editionArticles, editions, preferences, sources, userSources, users } from '../db/schema.ts';
import type { Deps, StoryInput } from '../shared/deps.ts';

const HOUR = 3600_000;
const MAX_CANDIDATES = 400;
const SIMILARITY = 0.5;
export const WORDS_PER_STORY = { standard: 90, extended: 130 } as const;

const STOPWORDS = new Set(
  'the a an and or but of to in on at for with by from as is are was were be been has have had it its this that these those after over into amid says said will would could new about than more up out not no who what why how'.split(' '),
);

export function headlineTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t && !STOPWORDS.has(t) && (t.length > 2 || /\d/.test(t))),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface Candidate extends StoryInput {
  sourceId: string;
}

interface Cluster {
  members: Candidate[];
  tokens: Set<string>[];
}

/** Single-link clustering of near-duplicate headlines. */
export function clusterCandidates(cands: Candidate[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const c of cands) {
    const toks = headlineTokens(c.title);
    const home = clusters.find((cl) => cl.tokens.some((t) => jaccard(t, toks) >= SIMILARITY));
    if (home) {
      home.members.push(c);
      home.tokens.push(toks);
    } else clusters.push({ members: [c], tokens: [toks] });
  }
  return clusters;
}

/** Recency decay × source weight × coverage boost; picks one representative per cluster and caps any one source's share. */
export function rankStories(cands: Candidate[], opts: { now: Date; kind: 'standard' | 'extended'; count: number }): StoryInput[] {
  const halfLifeH = opts.kind === 'extended' ? 8 : 3;
  const scored = clusterCandidates(cands).map(({ members }) => {
    const rep = [...members].sort((a, b) => b.weight - a.weight || b.publishedAt.getTime() - a.publishedAt.getTime())[0]!;
    const newest = Math.max(...members.map((m) => m.publishedAt.getTime()));
    const ageH = Math.max(0, (opts.now.getTime() - newest) / HOUR);
    const sourcesCarrying = new Set(members.map((m) => m.sourceId)).size;
    const score = 0.5 ** (ageH / halfLifeH) * rep.weight * Math.min(3, 1 + 0.5 * (sourcesCarrying - 1));
    return { rep, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const cap = Math.max(2, Math.ceil(opts.count * 0.4));
  const perSource = new Map<string, number>();
  const picked: Candidate[] = [];
  const overflow: Candidate[] = [];
  for (const { rep } of scored) {
    if (picked.length >= opts.count) break;
    const n = perSource.get(rep.sourceId) ?? 0;
    if (n >= cap) overflow.push(rep);
    else {
      picked.push(rep);
      perSource.set(rep.sourceId, n + 1);
    }
  }
  // Too few sources to satisfy the cap: top up rather than starve the bulletin.
  picked.push(...overflow.slice(0, opts.count - picked.length));
  return picked.map(({ sourceId: _sourceId, ...story }) => story);
}

export interface Selection {
  stories: StoryInput[];
  previouslyCovered: string[];
}

export async function selectStories(
  deps: Deps,
  userId: string,
  opts: { kind: 'standard' | 'extended'; slotAt: Date; targetWords?: number },
): Promise<Selection> {
  const { db, config } = deps;
  const now = deps.now();
  const [user] = await db
    .select({ timezone: users.timezone, standardMinutes: preferences.standardMinutes, extendedMinutes: preferences.extendedMinutes })
    .from(users)
    .leftJoin(preferences, eq(preferences.userId, users.id))
    .where(eq(users.id, userId));
  if (!user) return { stories: [], previouslyCovered: [] };

  let windowMs: number;
  if (opts.kind === 'extended') windowMs = 14 * HOUR;
  else {
    const [prev] = await db
      .select({ at: max(editions.slotAt) })
      .from(editions)
      .where(and(eq(editions.userId, userId), eq(editions.status, 'ready'), lt(editions.slotAt, opts.slotAt)));
    const since = prev?.at ? opts.slotAt.getTime() - prev.at.getTime() : Infinity;
    windowMs = Math.min(6 * HOUR, Math.max(2 * HOUR, since));
  }

  const minutes = opts.kind === 'extended' ? (user.extendedMinutes ?? 15) : (user.standardMinutes ?? 7);
  const targetWords = opts.targetWords ?? minutes * config.WORDS_PER_MINUTE;
  const count = Math.max(3, Math.ceil((1.5 * targetWords) / WORDS_PER_STORY[opts.kind]));

  const covered = db
    .select({ one: sql`1` })
    .from(editionArticles)
    .innerJoin(editions, eq(editions.id, editionArticles.editionId))
    .where(and(eq(editions.userId, userId), eq(editionArticles.articleId, articles.id)));
  const rows = await db
    .select({
      articleId: articles.id,
      title: articles.title,
      summary: articles.summary,
      publishedAt: articles.publishedAt,
      sourceId: sources.id,
      sourceTitle: sources.title,
      weight: userSources.weight,
    })
    .from(articles)
    .innerJoin(userSources, and(eq(userSources.sourceId, articles.sourceId), eq(userSources.userId, userId)))
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .where(and(gte(articles.publishedAt, new Date(opts.slotAt.getTime() - windowMs)), notExists(covered)))
    .orderBy(desc(articles.publishedAt))
    .limit(MAX_CANDIDATES);

  const stories = rankStories(rows, { now, kind: opts.kind, count });

  const dayStart = DateTime.fromJSDate(opts.slotAt, { zone: user.timezone }).startOf('day').toJSDate();
  const earlier = await db
    .select({ title: articles.title })
    .from(editionArticles)
    .innerJoin(editions, eq(editions.id, editionArticles.editionId))
    .innerJoin(articles, eq(articles.id, editionArticles.articleId))
    .where(and(eq(editions.userId, userId), eq(editions.status, 'ready'), gte(editions.slotAt, dayStart), lt(editions.slotAt, opts.slotAt)))
    .orderBy(editions.slotAt, editionArticles.position);

  return { stories, previouslyCovered: [...new Set(earlier.map((r) => r.title))] };
}
