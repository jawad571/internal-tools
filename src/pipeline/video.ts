import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { articles, editionArticles, editions, sources, users } from '../db/schema.ts';
import type { Deps, VideoRequest, VideoStory } from '../shared/deps.ts';
import { hasArabicScript } from '../shared/constants.ts';
import { englishSlotLabel } from '../shared/time.ts';
import { errorMessage, truncate } from '../providers/util.ts';

/** A render this old with no result means its worker died. */
const STALE_RENDER_MS = 30 * 60_000;

/**
 * Claims up to `n` editions whose audio is ready and whose video is pending. Same pattern as
 * claimEditions: the row is the queue entry, SKIP LOCKED lets any number of workers share it.
 * Video is best-effort, so a render whose worker died is marked failed rather than retried.
 */
export async function claimVideos(deps: Deps, n: number): Promise<string[]> {
  if (n <= 0) return [];
  const { db } = deps;
  const now = deps.now();
  await db
    .update(editions)
    .set({ videoStatus: 'failed', videoError: 'Video rendering did not finish', videoClaimedAt: null })
    .where(and(eq(editions.videoStatus, 'rendering'), lt(editions.videoClaimedAt, new Date(now.getTime() - STALE_RENDER_MS))));

  const claimable = db
    .select({ id: editions.id })
    .from(editions)
    .where(and(eq(editions.videoStatus, 'pending'), eq(editions.status, 'ready')))
    .orderBy(editions.readyAt)
    .limit(n)
    .for('update', { skipLocked: true });
  const rows = await db
    .update(editions)
    .set({ videoStatus: 'rendering', videoClaimedAt: now })
    .where(inArray(editions.id, claimable))
    .returning({ id: editions.id });
  return rows.map((r) => r.id);
}

async function readBlob(deps: Deps, key: string): Promise<Buffer | null> {
  const blob = await deps.blobs.get(key);
  if (!blob) return null;
  const parts: Buffer[] = [];
  for await (const chunk of blob.stream) parts.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(parts);
}

export type VideoOutcome = 'ready' | 'failed' | 'missing';

/**
 * On-screen text is always English, whatever language the bulletin is spoken in: drawtext can't
 * shape Urdu (or any complex script), and the video is meant to be watchable without the audio.
 * Story headlines and source names come from the feeds as they are.
 */
export function videoTitle(edition: { language: string; title: string | null; titleEn: string | null }, englishSlot: string): string {
  const candidate = edition.language === 'en' ? edition.title : edition.titleEn;
  if (candidate?.trim() && !hasArabicScript(candidate)) return candidate.trim();
  return edition.language === 'en' ? 'Your Newscast' : `Newscast · ${englishSlot}`;
}

/** Renders one claimed edition's video. Never throws, and never touches the audio fields. */
export async function renderEditionVideo(deps: Deps, editionId: string): Promise<VideoOutcome> {
  const { db } = deps;
  const [row] = await db
    .select({ edition: editions, timezone: users.timezone })
    .from(editions)
    .innerJoin(users, eq(users.id, editions.userId))
    .where(eq(editions.id, editionId));
  if (!row) return 'missing';
  const { edition } = row;
  const finish = (fields: Partial<typeof editions.$inferInsert>) =>
    db.update(editions).set({ videoClaimedAt: null, ...fields }).where(eq(editions.id, editionId));

  try {
    if (edition.status !== 'ready' || !edition.audioKey) throw new Error('Audio is not ready');
    const audio = await readBlob(deps, edition.audioKey);
    if (!audio) throw new Error('Audio file is missing');

    const storyRows = await db
      .select({ articleId: articles.id, title: articles.title, sourceTitle: sources.title, imageUrl: articles.imageUrl })
      .from(editionArticles)
      .innerJoin(articles, eq(articles.id, editionArticles.articleId))
      .innerJoin(sources, eq(sources.id, articles.sourceId))
      .where(eq(editionArticles.editionId, editionId))
      .orderBy(asc(editionArticles.position));
    const stories: VideoStory[] = storyRows;
    const byId = new Map(stories.map((s) => [s.articleId, s]));

    const timeline = edition.segments?.length ? edition.segments : [{ articleId: null, start: 0, end: edition.durationSeconds ?? 0 }];
    const durationSeconds = timeline.at(-1)!.end || (edition.durationSeconds ?? 0);
    const slotLabel = englishSlotLabel(edition.slotAt, row.timezone);
    const req: VideoRequest = {
      audio,
      audioMime: edition.audioMime ?? 'audio/mpeg',
      durationSeconds,
      title: videoTitle(edition, slotLabel),
      slotLabel,
      segments: timeline.map((s) => ({ story: (s.articleId && byId.get(s.articleId)) || null, start: s.start, end: s.end })),
      stories,
    };
    const video = await deps.video.render(req);
    const videoKey = `editions/${edition.userId}/${edition.id}.mp4`;
    await deps.blobs.put(videoKey, video.video, video.mime);
    const saved = await finish({ videoStatus: 'ready', videoKey, videoBytes: video.video.length, videoError: null }).returning({
      id: editions.id,
    });
    if (!saved.length) {
      // Retention (or anything else) deleted the edition mid-render: nothing references the file now.
      await deps.blobs.delete(videoKey).catch((err) => console.error('[video] could not delete orphaned video', videoKey, err));
      return 'missing';
    }
    return 'ready';
  } catch (e) {
    console.error(`[video] edition ${editionId} video failed:`, errorMessage(e));
    await finish({ videoStatus: 'failed', videoError: truncate(errorMessage(e), 1000) }).catch((dbErr) =>
      console.error('[video] could not record failure', editionId, dbErr),
    );
    return 'failed';
  }
}
