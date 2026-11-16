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
      videoBulletins: false,
      videoAvailable: false,
    });
    const { voices } = await (await ctx.call('GET', '/api/voices', { cookie })).json();
    expect(voices.map((v: { id: string }) => v.id)).toEqual(['ava', 'max', 'noor']);
    expect(voices[2]).toMatchObject({ id: 'noor', languages: ['ur'] });
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

  it('toggles video bulletins; videoAvailable is read-only', async () => {
    const res = await put({ videoBulletins: true });
    expect((await res.json()).preferences).toMatchObject({ videoBulletins: true, videoAvailable: false });
    expect((await put({ videoAvailable: true })).status).toBe(200); // unknown keys are stripped
    const { preferences } = await (await ctx.call('GET', '/api/preferences', { cookie })).json();
    expect(preferences).toMatchObject({ videoBulletins: true, videoAvailable: false });
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

  describe('bulletin language', () => {
    it('switching to Urdu moves an English voice to the first Urdu voice, and back again', async () => {
      const res = await put({ language: 'ur' });
      expect(res.status).toBe(200);
      expect((await res.json()).preferences).toMatchObject({ language: 'ur', voiceId: 'noor' });
      expect((await (await put({ language: 'en' })).json()).preferences).toMatchObject({ language: 'en', voiceId: 'ava' });
    });

    it('keeps a voice chosen in the same request, even one meant for another language', async () => {
      const res = await put({ language: 'ur', voiceId: 'max' });
      expect((await res.json()).preferences).toMatchObject({ language: 'ur', voiceId: 'max' });
      // Unrelated updates later don't override the explicit choice.
      expect((await (await put({ tone: 'calm' })).json()).preferences).toMatchObject({ language: 'ur', voiceId: 'max' });
    });

    it('keeps the current voice when it is meant for the new language', async () => {
      await put({ language: 'ur' });
      await put({ voiceId: 'noor' });
      expect((await (await put({ language: 'ur' })).json()).preferences.voiceId).toBe('noor');
    });

    it('rejects unsupported languages with 422 and a clear message', async () => {
      const res = await put({ language: 'fr' });
      expect(res.status).toBe(422);
      const { error } = await res.json();
      expect(error.code).toBe('unsupported_language');
      expect(error.message).toContain('"fr"');
      expect(error.message).toContain('English (en), Urdu (ur)');
      expect((await put({ language: 'Urdu' })).status).toBe(400); // not a language code at all
      const { preferences } = await (await ctx.call('GET', '/api/preferences', { cookie })).json();
      expect(preferences.language).toBe('en');
    });

    it('preview reads the sample in the requested, else the bulletin, language', async () => {
      const tts = ctx.deps.tts as FakeTts;
      await ctx.call('POST', '/api/preferences/preview', { cookie, body: { voiceId: 'noor', tone: 'warm', language: 'ur' } });
      expect(tts.calls.at(-1)).toMatchObject({ voiceId: 'noor', language: 'ur' });
      expect(tts.calls.at(-1)!.text).toMatch(/[\u0600-\u06FF]/);

      await ctx.call('POST', '/api/preferences/preview', { cookie, body: { voiceId: 'ava', tone: 'warm' } });
      expect(tts.calls.at(-1)).toMatchObject({ language: 'en' });
      expect(tts.calls.at(-1)!.text).toMatch(/^Hello/);

      await put({ language: 'ur' });
      await ctx.call('POST', '/api/preferences/preview', { cookie, body: { voiceId: 'noor', tone: 'calm' } });
      expect(tts.calls.at(-1)).toMatchObject({ language: 'ur' });

      const bad = await ctx.call('POST', '/api/preferences/preview', { cookie, body: { voiceId: 'noor', tone: 'calm', language: 'de' } });
      expect(bad.status).toBe(422);
    });
  });
});
