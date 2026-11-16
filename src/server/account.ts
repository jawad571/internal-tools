import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { preferences, users } from '../db/schema.ts';
import { LIMITS, LoginBody, SignupBody, UpdateMeBody } from '../shared/contracts.ts';
import type { Deps } from '../shared/deps.ts';
import { isValidTimezone } from '../shared/time.ts';
import {
  endSession,
  getDummyHash,
  hashPassword,
  randomToken,
  requireUser,
  startSession,
  toMe,
  verifyPassword,
} from './auth.ts';
import { clientIp, HttpError, readJson, type AppEnv } from './http.ts';
import { RateLimiter } from './rate-limit.ts';

const DEFAULT_EXTENDED_HOURS = [6, 21];

function assertTimezone(tz: string) {
  if (!isValidTimezone(tz)) throw new HttpError(422, 'invalid_timezone', `Unknown timezone "${tz}"`);
}

export const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
};

export function authRoutes(deps: Deps) {
  const limiter = new RateLimiter(10, 15 * 60_000, deps.now);
  const app = new Hono<AppEnv>();

  app.post('/signup', async (c) => {
    const body = await readJson(c, SignupBody);
    const email = body.email.trim().toLowerCase();
    limiter.hit(`signup|${clientIp(c)}|${email}`);
    assertTimezone(body.timezone);

    const plan = 'free' as const;
    const passwordHash = await hashPassword(body.password);
    let user;
    try {
      user = await deps.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({ email, passwordHash, displayName: body.displayName, timezone: body.timezone, plan, feedToken: randomToken() })
          .returning();
        await tx.insert(preferences).values({
          userId: created!.id,
          voiceId: deps.tts.defaultVoiceId(),
          activeHours: [...LIMITS.plans[plan].defaultActiveHours],
          extendedHours: DEFAULT_EXTENDED_HOURS,
        });
        return created!;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'email_taken', 'An account with this email already exists');
      throw err;
    }
    await startSession(c, deps, user.id);
    return c.json({ me: toMe(user, deps.config) });
  });

  app.post('/login', async (c) => {
    const body = await readJson(c, LoginBody);
    const email = body.email.trim().toLowerCase();
    limiter.hit(`login|${clientIp(c)}|${email}`);
    const [user] = await deps.db.select().from(users).where(eq(users.email, email));
    const ok = await verifyPassword(body.password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password');
    await startSession(c, deps, user.id);
    return c.json({ me: toMe(user, deps.config) });
  });

  app.post('/logout', async (c) => {
    await endSession(c, deps);
    return c.json({ ok: true as const });
  });

  return app;
}

export function meRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use(requireUser(deps));

  app.get('/', (c) => c.json({ me: toMe(c.get('user'), deps.config) }));

  app.patch('/', async (c) => {
    const body = await readJson(c, UpdateMeBody);
    if (body.timezone !== undefined) assertTimezone(body.timezone);
    if (Object.keys(body).length === 0) return c.json({ me: toMe(c.get('user'), deps.config) });
    const [user] = await deps.db.update(users).set(body).where(eq(users.id, c.get('user').id)).returning();
    return c.json({ me: toMe(user!, deps.config) });
  });

  app.post('/rotate-feed-token', async (c) => {
    const [user] = await deps.db
      .update(users)
      .set({ feedToken: randomToken() })
      .where(eq(users.id, c.get('user').id))
      .returning();
    return c.json({ me: toMe(user!, deps.config) });
  });

  return app;
}
