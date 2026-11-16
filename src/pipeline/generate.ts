import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { editionArticles, editions, preferences, users } from '../db/schema.ts';
import { ToneId } from '../shared/contracts.ts';
import type { Deps } from '../shared/deps.ts';
import { spokenSlotLabel } from '../shared/time.ts';
import { errorMessage, truncate } from '../providers/util.ts';
import { ingestDueSources } from './ingest.ts';
import { selectStories } from './select.ts';

export const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 10 * 60_000;
/** A scheduled bulletin this late (worker outage, backlog) is no longer worth making; the next slot supersedes it. */
const MISSED_SLOT_MS = 90 * 60_000;

/**
 * Atomically claims up to `n` editions: pending rows, plus rows whose worker died mid-generation
 * (claimed over 10 minutes ago and never finished). SKIP LOCKED lets any number of workers race safely.
 */
export async function claimEditions(deps: Deps, n: number): Promise<string[]> {
  if (n <= 0) return [];
  const { db } = deps;
  const now = deps.now();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  const inProgress = inArray(editions.status, ['scripting', 'synthesizing']);

  // A row that has crashed its worker MAX_ATTEMPTS times is given up on rather than reclaimed forever.
  await db
    .update(editions)
    .set({ status: 'failed', error: 'Generation timed out repeatedly', claimedAt: null })
    .where(and(inProgress, lt(editions.claimedAt, staleBefore), sql`${editions.attempts} + 1 >= ${MAX_ATTEMPTS}`));

  await db
    .update(editions)
    .set({ status: 'skipped', error: 'Missed its slot' })
    .where(
      and(
        eq(editions.status, 'pending'),
        eq(editions.trigger, 'scheduled'),
        lt(editions.slotAt, new Date(now.getTime() - MISSED_SLOT_MS)),
      ),
    );

  const claimable = db
    .select({ id: editions.id })
    .from(editions)
    .where(or(eq(editions.status, 'pending'), and(inProgress, lt(editions.claimedAt, staleBefore))))
    .orderBy(editions.slotAt)
    .limit(n)
    .for('update', { skipLocked: true });

  const rows = await db
    .update(editions)
    .set({
      status: 'scripting',
      claimedAt: now,
      // SET sees the pre-update row: a reclaimed (crashed) run counts as an attempt.
      attempts: sql`${editions.attempts} + case when ${editions.status} = 'pending' then 0 else 1 end`,
    })
    .where(inArray(editions.id, claimable))
    .returning({ id: editions.id });
  return rows.map((r) => r.id);
}

const extFor = (mime: string) => ({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/aac': 'aac' })[mime] ?? 'bin';

export type GenerateOutcome = 'ready' | 'skipped' | 'pending' | 'failed' | 'missing';

/** Runs one edition end to end. Never throws for generation errors: they are recorded on the row. */
export async function generateEdition(deps: Deps, editionId: string): Promise<GenerateOutcome> {
  const { db, config } = deps;
  const [row] = await db
    .select({ edition: editions, user: users, prefs: preferences })
    .from(editions)
    .innerJoin(users, eq(users.id, editions.userId))
    .leftJoin(preferences, eq(preferences.userId, editions.userId))
    .where(eq(editions.id, editionId));
  if (!row) return 'missing';
  const { edition, user, prefs } = row;
  if (edition.status === 'ready' || edition.status === 'skipped' || edition.status === 'failed') return edition.status;

  const touch = (fields: Partial<typeof editions.$inferInsert>) =>
    db.update(editions).set({ claimedAt: deps.now(), ...fields }).where(eq(editions.id, editionId));

  try {
    await touch({ status: 'scripting' });
    if (edition.trigger === 'on_demand') {
      // Typically a new user who subscribed seconds ago: don't make them wait for the ingest loop.
      await ingestDueSources(deps).catch((e) => console.error('[generate] pre-ingest failed:', errorMessage(e)));
    }
    const targetWords = Math.round((edition.targetSeconds / 60) * config.WORDS_PER_MINUTE);
    const { stories, previouslyCovered } = await selectStories(deps, user.id, { kind: edition.kind, slotAt: edition.slotAt, targetWords });
    if (!stories.length) {
      if (edition.trigger === 'on_demand') {
        // The listener asked for this one and is watching it; tell them why nothing arrived.
        await touch({ status: 'failed', claimedAt: null, error: 'No new stories from your sources yet. Try again a little later.' });
        return 'failed';
      }
      await touch({ status: 'skipped', claimedAt: null, error: null });
      return 'skipped';
    }

    const language = prefs?.language ?? 'en';
    const tone = ToneId.catch('neutral').parse(edition.tone);
    const toneNote = prefs?.toneNote ?? '';
    const script = await deps.scriptWriter.write({
      listenerName: user.displayName,
      slotLabel: spokenSlotLabel(edition.slotAt, user.timezone, language),
      kind: edition.kind,
      targetWords,
      tone,
      toneNote,
      language,
      stories,
      previouslyCovered,
    });
    const supplied = new Set(stories.map((s) => s.articleId));
    const usedIds = [...new Set(script.usedArticleIds)].filter((id) => supplied.has(id));

    await touch({ status: 'synthesizing', title: script.title, script: script.script });
    const voiceId = deps.tts.voices().some((v) => v.id === edition.voiceId) ? edition.voiceId : deps.tts.defaultVoiceId();
    const audio = await deps.tts.synthesize({ text: script.script, voiceId, tone, toneNote });

    const audioKey = `editions/${user.id}/${edition.id}.${extFor(audio.mime)}`;
    await deps.blobs.put(audioKey, audio.audio, audio.mime);
    await db.transaction(async (tx) => {
      await tx
        .update(editions)
        .set({
          status: 'ready',
          audioKey,
          audioMime: audio.mime,
          audioBytes: audio.audio.length,
          durationSeconds: Math.round(audio.durationSeconds),
          readyAt: deps.now(),
          error: null,
          claimedAt: null,
        })
        .where(eq(editions.id, editionId));
      if (usedIds.length) {
        await tx
          .insert(editionArticles)
          .values(usedIds.map((articleId, position) => ({ editionId, articleId, position })))
          .onConflictDoNothing();
      }
    });
    return 'ready';
  } catch (e) {
    const attempts = edition.attempts + 1;
    const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    console.error(`[generate] edition ${editionId} attempt ${attempts} failed:`, errorMessage(e));
    await db
      .update(editions)
      .set({ status, attempts, error: truncate(errorMessage(e), 1000), claimedAt: null })
      .where(eq(editions.id, editionId));
    return status;
  }
}
