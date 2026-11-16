import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { preferences, sessions, users } from '../../src/db/schema.ts';
import { LIMITS } from '../../src/shared/contracts.ts';
import { PUBLIC_URL, useCtx, type Ctx } from './helpers.ts';

const getCtx = useCtx();
let ctx: Ctx;
beforeEach(() => (ctx = getCtx()));

const creds = { email: 'ada@example.com', password: 'correct horse battery' };

describe('auth', () => {
  it('signup sets a secure-by-default session cookie and creates prefs', async () => {
    const res = await ctx.call('POST', '/api/auth/signup', {
      body: { email: 'Ada@Example.COM', password: creds.password, displayName: 'Ada', timezone: 'Europe/London' },
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^newscast_session=[\w-]{40,};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/); // NODE_ENV=test → cookieSecure false

    const { me } = await res.json();
    expect(me.email).toBe('ada@example.com');
    expect(me.plan).toBe('free');
    expect(me.podcastFeedUrl).toMatch(new RegExp(`^${PUBLIC_URL}/feed/[\\w-]+\\.xml$`));

    const [user] = await ctx.db.select().from(users);
    expect(user!.passwordHash).toMatch(/^scrypt\$/);
    expect(user!.passwordHash).not.toContain(creds.password);
    const [prefs] = await ctx.db.select().from(preferences).where(eq(preferences.userId, user!.id));
    expect(prefs).toMatchObject({ voiceId: 'ava', activeHours: [...LIMITS.plans.free.defaultActiveHours], extendedHours: [6, 21] });

    // only the hash of the token is stored
    const token = cookie.split(';')[0]!.split('=')[1]!;
    const [session] = await ctx.db.select().from(sessions);
    expect(session!.id).not.toBe(token);
    expect(session!.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks the cookie Secure when configured', async () => {
    ctx.deps.config.cookieSecure = true;
    const res = await ctx.call('POST', '/api/auth/signup', {
      body: { ...creds, displayName: 'Ada', timezone: 'UTC' },
    });
    expect(res.headers.get('set-cookie')).toMatch(/Secure/);
  });

  it('rejects bad timezone, duplicate email and malformed bodies', async () => {
    const bad = await ctx.call('POST', '/api/auth/signup', { body: { ...creds, displayName: 'A', timezone: 'Mars/Base' } });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe('invalid_timezone');

    await ctx.signup();
    const dup = await ctx.call('POST', '/api/auth/signup', { body: { ...creds, email: 'ADA@example.com', displayName: 'A', timezone: 'UTC' } });
    expect(dup.status).toBe(409);

    const invalid = await ctx.call('POST', '/api/auth/signup', { body: { email: 'nope', password: 'x' } });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatchObject({ code: 'invalid_body' });
  });

  it('login → me → logout', async () => {
    await ctx.signup();
    const login = await ctx.call('POST', '/api/auth/login', { body: { ...creds, email: 'ADA@example.com' } });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    const me = await ctx.call('GET', '/api/me', { cookie });
    expect(me.status).toBe(200);
    expect((await me.json()).me.displayName).toBe('Ada');

    const logout = await ctx.call('POST', '/api/auth/logout', { cookie });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });
    expect(logout.headers.get('set-cookie')).toMatch(/newscast_session=;.*Max-Age=0/);

    expect((await ctx.call('GET', '/api/me', { cookie })).status).toBe(401);
  });

  it('wrong password and unknown email look identical', async () => {
    await ctx.signup();
    const wrong = await ctx.call('POST', '/api/auth/login', { body: { ...creds, password: 'wrong-password' } });
    const unknown = await ctx.call('POST', '/api/auth/login', { body: { ...creds, email: 'who@example.com' } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(wrong.headers.get('set-cookie')).toBeNull();
  });

  it('rate limits login attempts per ip+email', async () => {
    await ctx.signup();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await ctx.call('POST', '/api/auth/login', { body: { ...creds, password: 'wrong-password' } })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    const limited = await ctx.call('POST', '/api/auth/login', { body: creds });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    // window passes
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 16 * 60_000);
    expect((await ctx.call('POST', '/api/auth/login', { body: creds })).status).toBe(200);
  });

  it('expired sessions are rejected', async () => {
    const { cookie } = await ctx.signup();
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 31 * 24 * 3600_000);
    expect((await ctx.call('GET', '/api/me', { cookie })).status).toBe(401);
  });

  it('PATCH /api/me and rotate-feed-token', async () => {
    const { cookie, me } = await ctx.signup();
    const patched = await ctx.call('PATCH', '/api/me', { cookie, body: { displayName: 'Ada L', timezone: 'Asia/Kolkata' } });
    expect((await patched.json()).me).toMatchObject({ displayName: 'Ada L', timezone: 'Asia/Kolkata' });
    expect((await ctx.call('PATCH', '/api/me', { cookie, body: { timezone: 'Nowhere/Land' } })).status).toBe(422);

    const rotated = await ctx.call('POST', '/api/me/rotate-feed-token', { cookie });
    const next = (await rotated.json()).me;
    expect(next.podcastFeedUrl).not.toBe(me.podcastFeedUrl);
    const oldFeed = me.podcastFeedUrl.replace(PUBLIC_URL, '');
    expect((await ctx.call('GET', oldFeed)).status).toBe(404);
    expect((await ctx.call('GET', next.podcastFeedUrl.replace(PUBLIC_URL, ''))).status).toBe(200);
  });

  it('bumps lastActiveAt at most once per 10 minutes', async () => {
    const { cookie, me } = await ctx.signup();
    const lastActive = async () => (await ctx.db.select().from(users).where(eq(users.id, me.id)))[0]!.lastActiveAt;
    // DB default is real wall-clock now; move the fake clock well past it
    ctx.clock.now = new Date(Date.now() + 3600_000);
    await ctx.call('GET', '/api/me', { cookie });
    const first = await lastActive();
    expect(first.getTime()).toBe(ctx.clock.now.getTime());

    ctx.clock.now = new Date(first.getTime() + 5 * 60_000);
    await ctx.call('GET', '/api/me', { cookie });
    expect((await lastActive()).getTime()).toBe(first.getTime());

    ctx.clock.now = new Date(first.getTime() + 11 * 60_000);
    await ctx.call('GET', '/api/me', { cookie });
    expect((await lastActive()).getTime()).toBe(ctx.clock.now.getTime());
  });
});

describe('csrf', () => {
  it('requires application/json on bodies', async () => {
    const res = await ctx.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a@b.c&password=x',
    });
    expect(res.status).toBe(415);
  });

  it('refuses cross-origin mutating requests but allows same-origin', async () => {
    const { cookie } = await ctx.signup();
    const evil = await ctx.call('POST', '/api/me/rotate-feed-token', { cookie, headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect((await evil.json()).error.code).toBe('cross_origin');
    const ok = await ctx.call('POST', '/api/me/rotate-feed-token', { cookie, headers: { origin: PUBLIC_URL } });
    expect(ok.status).toBe(200);
    // GETs are unaffected
    expect((await ctx.call('GET', '/api/me', { cookie, headers: { origin: 'https://evil.example' } })).status).toBe(200);
  });
});

describe('misc', () => {
  it('healthz and JSON 404s', async () => {
    expect(await (await ctx.call('GET', '/healthz')).json()).toEqual({ ok: true });
    const res = await ctx.call('GET', '/api/nope');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });
});
