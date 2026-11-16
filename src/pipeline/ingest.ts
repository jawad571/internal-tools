import { and, eq, exists, isNull, lt, or, sql } from 'drizzle-orm';
import { articles, sources, userSources } from '../db/schema.ts';
import type { Deps } from '../shared/deps.ts';
import { asFeedReader } from '../providers/feeds/fetch.ts';
import { errorMessage, mapLimit, truncate } from '../providers/util.ts';

const MAX_ITEM_AGE_MS = 48 * 3600_000;
const CONCURRENCY = 8;
/** Backoff doubles per consecutive failure up to 2^6 = 64× the stale interval (16 h at the default 15 min). */
const MAX_BACKOFF_EXP = 6;

export interface IngestSummary {
  fetched: number;
  failed: number;
  inserted: number;
}

export async function ingestDueSources(deps: Deps): Promise<IngestSummary> {
  const { db, config } = deps;
  const reader = asFeedReader(deps.feeds);
  const now = deps.now();
  const staleMs = config.INGEST_STALE_MINUTES * 60_000;
  const due = await db
    .select({ id: sources.id, url: sources.url, etag: sources.etag, lastModified: sources.lastModified })
    .from(sources)
    .where(
      and(
        exists(db.select({ one: sql`1` }).from(userSources).where(eq(userSources.sourceId, sources.id))),
        or(
          isNull(sources.lastFetchedAt),
          lt(
            sources.lastFetchedAt,
            sql`${now.toISOString()}::timestamptz - make_interval(secs => ${staleMs / 1000} * power(2, least(${sources.failCount}, ${MAX_BACKOFF_EXP})))`,
          ),
        ),
      ),
    )
    .orderBy(sql`${sources.lastFetchedAt} asc nulls first`);

  const summary: IngestSummary = { fetched: 0, failed: 0, inserted: 0 };
  await mapLimit(due, CONCURRENCY, async (src) => {
    try {
      const res = await reader.fetchFeed(src.url, { etag: src.etag, lastModified: src.lastModified, now });
      if (!res.notModified && !res.feed) throw new Error('Response is not an RSS or Atom feed');
      const fresh = (res.feed?.items ?? []).filter((it) => now.getTime() - it.publishedAt.getTime() <= MAX_ITEM_AGE_MS);
      if (fresh.length) {
        const rows = await db
          .insert(articles)
          .values(fresh.map((it) => ({ sourceId: src.id, guid: it.guid, url: it.url, title: it.title, summary: it.summary, imageUrl: it.imageUrl, publishedAt: it.publishedAt, fetchedAt: now })))
          .onConflictDoNothing({ target: [articles.sourceId, articles.guid] })
          .returning({ id: articles.id });
        summary.inserted += rows.length;
      }
      await db
        .update(sources)
        .set({
          lastFetchedAt: now,
          failCount: 0,
          lastError: null,
          // A 304 may omit validators; keep the ones we sent.
          etag: res.etag ?? (res.notModified ? src.etag : null),
          lastModified: res.lastModified ?? (res.notModified ? src.lastModified : null),
        })
        .where(eq(sources.id, src.id));
      summary.fetched++;
    } catch (e) {
      summary.failed++;
      await db
        .update(sources)
        .set({ lastFetchedAt: now, failCount: sql`${sources.failCount} + 1`, lastError: truncate(errorMessage(e), 500) })
        .where(eq(sources.id, src.id))
        .catch((dbErr) => console.error('[ingest] could not record failure', src.url, dbErr));
    }
  });
  return summary;
}
