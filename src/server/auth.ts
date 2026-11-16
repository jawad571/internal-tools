import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sessions, users, type User } from '../db/schema.ts';
import type { Config } from '../shared/config.ts';
import type { Me } from '../shared/contracts.ts';
import type { Deps } from '../shared/deps.ts';
import { HttpError, publicBase, type AppEnv } from './http.ts';

export const SESSION_COOKIE = 'newscast_session';
const SESSION_TTL_MS = 30 * 24 * 3600_000;
const ACTIVITY_THROTTLE_MS = 10 * 60_000;

// ---------- passwords ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const scryptAsync = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** Format: scrypt$N$r$p$<salt b64>$<hash b64>, so parameters can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scryptAsync(password, salt, keylen, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(key, expected);
}

/** Verified against when the email is unknown, so login timing doesn't reveal which emails exist. */
let dummyHash: Promise<string> | undefined;
export const getDummyHash = () => (dummyHash ??= hashPassword('not-a-real-password'));

// ---------- tokens & sessions ----------

export const randomToken = () => randomBytes(32).toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function startSession(c: Context, deps: Deps, userId: string): Promise<void> {
  const token = randomToken();
  const expiresAt = new Date(deps.now().getTime() + SESSION_TTL_MS);
  await deps.db.insert(sessions).values({ id: sha256(token), userId, expiresAt });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: deps.config.cookieSecure,
    path: '/',
    expires: expiresAt,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function endSession(c: Context, deps: Deps): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await deps.db.delete(sessions).where(eq(sessions.id, sha256(token)));
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: deps.config.cookieSecure });
}

export async function sessionUser(c: Context, deps: Deps): Promise<User | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const [row] = await deps.db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, deps.now())));
  return row?.user ?? null;
}

/** Bumps lastActiveAt, but writes at most once per throttle window per user. */
export async function touchActivity(deps: Deps, user: User): Promise<void> {
  const now = deps.now();
  if (now.getTime() - user.lastActiveAt.getTime() < ACTIVITY_THROTTLE_MS) return;
  await deps.db.update(users).set({ lastActiveAt: now }).where(eq(users.id, user.id));
  user.lastActiveAt = now;
}

export const requireUser =
  (deps: Deps): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const user = await sessionUser(c, deps);
    if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in required');
    await touchActivity(deps, user);
    c.set('user', user);
    await next();
  };

export const toMe = (user: User, config: Config): Me => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  timezone: user.timezone,
  plan: user.plan,
  podcastFeedUrl: `${publicBase(config.PUBLIC_URL)}/feed/${user.feedToken}.xml`,
});
