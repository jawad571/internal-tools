import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editions, preferences } from '../../src/db/schema.ts';
import { scheduleDueEditions } from '../../src/pipeline/scheduler.ts';
import { createSource, createUser, setup, subscribe, type TestEnv } from './helpers.ts';

describe('scheduleDueEditions', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(() => env.close());

  const userWithSource = async (opts: Parameters<typeof createUser>[1] = {}) => {
    const u = await createUser(env.db, opts);
    const s = await createSource(env.db);
    await subscribe(env.db, u.id, s.id);
    return u;
  };

  it('computes the local top-of-hour for a :30-offset zone (Asia/Kolkata)', async () => {
    // 03:20Z = 08:50 IST; next slot 09:00 IST = 03:30Z, 10 minutes away (< 12 min lead)
    env.setNow(new Date('2026-11-16T03:20:00Z'));
    const u = await userWithSource({ timezone: 'Asia/Kolkata' });
    expect(await scheduleDueEditions(env.deps)).toBe(1);
    const [e] = await env.db.select().from(editions).where(eq(editions.userId, u.id));
    expect(e!.slotAt.toISOString()).toBe('2026-11-16T03:30:00.000Z');
    expect(e).toMatchObject({ localHour: 9, kind: 'standard', status: 'pending', targetSeconds: 7 * 60, voiceId: 'mock-ben', tone: 'warm', trigger: 'scheduled' });
  });

  it('waits until the slot is within the lead window', async () => {
    env.setNow(new Date('2026-11-16T08:40:00Z')); // 20 min before 09:00 UTC
    await userWithSource();
    expect(await scheduleDueEditions(env.deps)).toBe(0);
    env.setNow(new Date('2026-11-16T08:50:00Z'));
    expect(await scheduleDueEditions(env.deps)).toBe(1);
  });

  it('is idempotent', async () => {
    await userWithSource();
    expect(await scheduleDueEditions(env.deps)).toBe(1);
    expect(await scheduleDueEditions(env.deps)).toBe(0);
    expect(await env.db.select().from(editions)).toHaveLength(1);
  });

  it('makes an extended edition at extended hours with the extended length', async () => {
    env.setNow(new Date('2026-11-16T05:50:00Z')); // next slot 06:00 UTC
    await userWithSource({ extendedHours: [6, 21] });
    await scheduleDueEditions(env.deps);
    const [e] = await env.db.select().from(editions);
    expect(e).toMatchObject({ kind: 'extended', localHour: 6, targetSeconds: 15 * 60 });
  });

  it('respects activeHours, paused, idle and no-sources', async () => {
    const offHours = await userWithSource({ activeHours: [6, 12] }); // slot hour is 9
    const paused = await userWithSource({ paused: true });
    const idle = await userWithSource({ lastActiveAt: new Date('2026-11-01T00:00:00Z') });
    const noSources = await createUser(env.db);
    const ok = await userWithSource();
    expect(await scheduleDueEditions(env.deps)).toBe(1);
    const rows = await env.db.select({ userId: editions.userId }).from(editions);
    expect(rows.map((r) => r.userId)).toEqual([ok.id]);
    expect([offHours.id, paused.id, idle.id, noSources.id]).not.toContain(rows[0]!.userId);
  });

  it('snapshots the voice, tone and language at scheduling time', async () => {
    const u = await userWithSource();
    await env.db.update(preferences).set({ voiceId: 'mock-zara', tone: 'formal', language: 'ur' }).where(eq(preferences.userId, u.id));
    await scheduleDueEditions(env.deps);
    const [e] = await env.db.select().from(editions);
    expect(e).toMatchObject({ voiceId: 'mock-zara', tone: 'formal', language: 'ur' });
  });

  it('handles many users in a single pass', async () => {
    for (let i = 0; i < 50; i++) await userWithSource({ timezone: i % 2 ? 'Europe/London' : 'UTC' });
    expect(await scheduleDueEditions(env.deps)).toBe(50);
  });
});
