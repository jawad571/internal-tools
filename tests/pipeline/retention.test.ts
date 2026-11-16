import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { articles, editionArticles, editions, sessions } from '../../src/db/schema.ts';
import { runRetention } from '../../src/pipeline/retention.ts';
import { addArticle, createSource, createUser, hoursAgo, NOW, setup, type TestEnv } from './helpers.ts';

describe('runRetention', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(() => env.close());

  it('deletes old editions and their blobs, unreferenced old articles and expired sessions', async () => {
    const user = await createUser(env.db);
    const src = await createSource(env.db);
    const mk = async (slotAt: Date) => {
      const audioKey = `editions/${user.id}/${randomUUID()}.wav`;
      await env.blobs.put(audioKey, Buffer.from('x'), 'audio/wav');
      const [e] = await env.db
        .insert(editions)
        .values({ userId: user.id, slotAt, localHour: 9, kind: 'standard', status: 'ready', targetSeconds: 420, voiceId: 'v', tone: 'neutral', audioKey })
        .returning();
      return e!;
    };
    const oldEdition = await mk(hoursAgo(8 * 24));
    const recentEdition = await mk(hoursAgo(24));

    const oldOrphan = await addArticle(env.db, src.id, { title: 'Old orphan', publishedAt: hoursAgo(8 * 24) });
    const oldReferenced = await addArticle(env.db, src.id, { title: 'Old but referenced', publishedAt: hoursAgo(8 * 24) });
    const oldViaDeletedEdition = await addArticle(env.db, src.id, { title: 'Old, referenced by expiring edition', publishedAt: hoursAgo(8 * 24) });
    const fresh = await addArticle(env.db, src.id, { title: 'Fresh', publishedAt: hoursAgo(2) });
    await env.db.insert(editionArticles).values([
      { editionId: recentEdition.id, articleId: oldReferenced.id, position: 0 },
      { editionId: oldEdition.id, articleId: oldViaDeletedEdition.id, position: 0 },
    ]);

    await env.db.insert(sessions).values([
      { id: 'expired', userId: user.id, expiresAt: hoursAgo(1) },
      { id: 'live', userId: user.id, expiresAt: new Date(NOW.getTime() + 3600_000) },
    ]);

    expect(await runRetention(env.deps)).toEqual({ editions: 1, articles: 2, sessions: 1 });
    expect((await env.db.select().from(editions)).map((e) => e.id)).toEqual([recentEdition.id]);
    expect(env.blobs.objects.has(oldEdition.audioKey!)).toBe(false);
    expect(env.blobs.objects.has(recentEdition.audioKey!)).toBe(true);
    expect((await env.db.select().from(articles)).map((a) => a.id).sort()).toEqual([oldReferenced.id, fresh.id].sort());
    expect(oldOrphan).toBeTruthy();
    expect((await env.db.select().from(sessions)).map((s) => s.id)).toEqual(['live']);
  });

  it('keeps the edition row if its blob cannot be deleted', async () => {
    const user = await createUser(env.db);
    await env.db
      .insert(editions)
      .values({ userId: user.id, slotAt: hoursAgo(10 * 24), localHour: 9, kind: 'standard', status: 'ready', targetSeconds: 420, voiceId: 'v', tone: 'neutral', audioKey: 'editions/x/y.wav' });
    env.deps.blobs = { ...env.blobs, put: env.blobs.put, get: env.blobs.get, delete: async () => Promise.reject(new Error('S3 down')) };
    expect((await runRetention(env.deps)).editions).toBe(0);
    expect(await env.db.select().from(editions)).toHaveLength(1);
  });
});
