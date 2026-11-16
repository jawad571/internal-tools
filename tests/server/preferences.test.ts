import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema.ts';
import { FakeTts, useCtx, type Ctx } from './helpers.ts';

const getCtx = useCtx();
let ctx: Ctx;
let cookie: string;
beforeEach(async () => {
  ctx = getCtx();
  ({ cookie } = await ctx.signup());
});

const put = (body: unknown) => ctx.call('PUT', '/api/preferences', { cookie, body });

describe('preferences', () => {
  it('GET returns signup defaults; voices are listed', async () => {
    const { preferences } = await (await ctx.call('GET', '/api/preferences', { cookie })).json();
    expect(preferences).toEqual({
      voiceId: 'ava',
      tone: 'neutral',
      toneNote: '',
      language: 'en',
      standardMinutes: 7,
      extendedMinutes: 15,
      activeHours: [6, 9, 12, 15, 18, 21],
      extendedHours: [6, 21],
      paused: false,
    });
    const { voices } = await (await ctx.call('GET', '/api/voices', { cookie })).json();
    expect(voices.map((v: { id: string }) => v.id)).toEqual(['ava', 'max']);
  });

  it('updates fields and normalises hours', async () => {
    const res = await put({ voiceId: 'max', tone: 'witty', toneNote: '  no puns  ', activeHours: [21, 7, 7, 8], extendedHours: [21] });
    expect(res.status).toBe(200);
    expect((await res.json()).preferences).toMatchObject({
      voiceId: 'max',
      tone: 'witty',
      toneNote: 'no puns',
      activeHours: [7, 8, 21],
      extendedHours: [21],
    });
  });

  it('rejects an unknown voice', async () => {
    const res = await put({ voiceId: 'nobody' });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('invalid_voice');
  });

  it('enforces maxActiveHours per plan', async () => {
    const seven = [1, 2, 3, 4, 5, 6, 7];
    const res = await put({ activeHours: seven });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('plan_limit');

    const [user] = await ctx.db.select().from(users);
    await ctx.db.update(users).set({ plan: 'pro' }).where(eq(users.id, user!.id));
    expect((await put({ activeHours: seven })).status).toBe(200);
  });

  it('rejects extended hours outside active hours', async () => {
    const res = await put({ extendedHours: [6, 7] });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('invalid_extended_hours');
    expect((await put({ activeHours: [8, 9], extendedHours: [6] })).status).toBe(422);
  });

  it('silently drops extended hours that are no longer active', async () => {
    const res = await put({ activeHours: [6, 12] });
    expect((await res.json()).preferences).toMatchObject({ activeHours: [6, 12], extendedHours: [6] });
  });

  it('rejects schema violations', async () => {
    expect((await put({ standardMinutes: 30 })).status).toBe(400);
    expect((await put({ tone: 'sarcastic' })).status).toBe(400);
    expect((await put({ activeHours: [24] })).status).toBe(400);
  });

  it('preview returns provider audio and is rate limited', async () => {
    const res = await ctx.call('POST', '/api/preferences/preview', { cookie, body: { voiceId: 'max', tone: 'calm' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('FAKEAUDIO');
    const call = (ctx.deps.tts as FakeTts).calls[0]!;
    expect(call.voiceId).toBe('max');
    expect(call.text.split(/\s+/).length).toBeGreaterThanOrEqual(15);

    expect((await ctx.call('POST', '/api/preferences/preview', { cookie, body: { voiceId: 'zzz', tone: 'calm' } })).status).toBe(422);

    let last = 0;
    for (let i = 0; i < 20; i++) {
      last = (await ctx.call('POST', '/api/preferences/preview', { cookie, body: { voiceId: 'ava', tone: 'calm' } })).status;
    }
    expect(last).toBe(429);
  });
});
