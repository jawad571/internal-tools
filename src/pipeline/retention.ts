import { and, eq, inArray, lt, notExists, sql } from 'drizzle-orm';
import { articles, editionArticles, editions, sessions } from '../db/schema.ts';
import type { Deps } from '../shared/deps.ts';

const BATCH = 500;
const ARTICLE_MAX_AGE_DAYS = 7;

export interface RetentionSummary {
  editions: number;
  articles: number;
  sessions: number;
}

export async function runRetention(deps: Deps): Promise<RetentionSummary> {
  const { db, config } = deps;
  const now = deps.now().getTime();
  const editionCutoff = new Date(now - config.RETENTION_DAYS * 86_400_000);

  let editionCount = 0;
  for (;;) {
    const old = await db
      .select({ id: editions.id, audioKey: editions.audioKey, videoKey: editions.videoKey })
      .from(editions)
      .where(lt(editions.slotAt, editionCutoff))
      .limit(BATCH);
    if (!old.length) break;
    // Blob first: if a delete fails the row survives and is retried next run, so nothing is orphaned.
    const deletable: string[] = [];
    for (const e of old) {
      try {
        if (e.audioKey) await deps.blobs.delete(e.audioKey);
        if (e.videoKey) await deps.blobs.delete(e.videoKey);
        deletable.push(e.id);
      } catch (err) {
        console.error('[retention] blob delete failed', e.audioKey, e.videoKey, err);
      }
    }
    if (deletable.length) await db.delete(editions).where(inArray(editions.id, deletable));
    editionCount += deletable.length;
    if (deletable.length < old.length || old.length < BATCH) break;
  }

  const prunedArticles = await db
    .delete(articles)
    .where(
      and(
        lt(articles.publishedAt, new Date(now - ARTICLE_MAX_AGE_DAYS * 86_400_000)),
        notExists(db.select({ one: sql`1` }).from(editionArticles).where(eq(editionArticles.articleId, articles.id))),
      ),
    )
    .returning({ id: articles.id });

  const expired = await db.delete(sessions).where(lt(sessions.expiresAt, new Date(now))).returning({ id: sessions.id });

  return { editions: editionCount, articles: prunedArticles.length, sessions: expired.length };
}
