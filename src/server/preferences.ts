import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { preferences, type Preferences } from '../db/schema.ts';
import {
  LIMITS,
  UpdatePreferencesBody,
  VoicePreviewBody,
  type PreferencesDto,
  type ToneId,
} from '../shared/contracts.ts';
import type { Deps } from '../shared/deps.ts';
import { requireUser } from './auth.ts';
import { HttpError, readJson, type AppEnv } from './http.ts';
import { RateLimiter } from './rate-limit.ts';

const PREVIEW_SAMPLES: Record<ToneId, string> = {
  neutral: 'Good morning. Here is your Newscast: the top stories from your chosen sources, summarised clearly and without fuss.',
  warm: "Hello, and thanks for tuning in. It's lovely to have you here, so let's catch up on today's news together.",
  energetic: "Good morning and welcome to your Newscast! We've got a packed bulletin today, so let's jump straight in!",
  calm: "Good evening. Settle in, take a breath, and let's go gently through the stories that mattered most today.",
  witty: "Welcome back to your Newscast, where the news is real, the jokes are brief, and nobody mentions the weather. Mostly.",
  formal: 'Good evening. This is your Newscast. The headlines at the top of the hour, read in full from your selected sources.',
};

export const toPreferencesDto = (p: Preferences): PreferencesDto => ({
  voiceId: p.voiceId,
  tone: p.tone as ToneId,
  toneNote: p.toneNote,
  language: p.language,
  standardMinutes: p.standardMinutes,
  extendedMinutes: p.extendedMinutes,
  activeHours: p.activeHours,
  extendedHours: p.extendedHours,
  paused: p.paused,
});

export async function loadPreferences(deps: Deps, userId: string): Promise<Preferences> {
  const [row] = await deps.db.select().from(preferences).where(eq(preferences.userId, userId));
  if (!row) throw new Error(`preferences row missing for user ${userId}`); // created at signup
  return row;
}

export function preferenceRoutes(deps: Deps) {
  const previewLimiter = new RateLimiter(20, 60 * 60_000, deps.now);
  const app = new Hono<AppEnv>();
  app.use(requireUser(deps));

  const assertVoice = (voiceId: string) => {
    if (!deps.tts.voices().some((v) => v.id === voiceId)) {
      throw new HttpError(422, 'invalid_voice', `Unknown voice "${voiceId}"`);
    }
  };

  app.get('/', async (c) => {
    return c.json({ preferences: toPreferencesDto(await loadPreferences(deps, c.get('user').id)) });
  });

  app.put('/', async (c) => {
    const user = c.get('user');
    const body = await readJson(c, UpdatePreferencesBody);
    const current = await loadPreferences(deps, user.id);

    if (body.voiceId !== undefined) assertVoice(body.voiceId);
    const { maxActiveHours } = LIMITS.plans[user.plan];
    if (body.activeHours && body.activeHours.length > maxActiveHours) {
      throw new HttpError(422, 'plan_limit', `Your plan allows up to ${maxActiveHours} bulletin hours a day`);
    }

    const activeHours = body.activeHours ?? current.activeHours;
    let extendedHours = body.extendedHours ?? current.extendedHours;
    if (body.extendedHours) {
      if (!extendedHours.every((h) => activeHours.includes(h))) {
        throw new HttpError(422, 'invalid_extended_hours', 'Extended hours must be among your active hours');
      }
    } else {
      // Turning an hour off implicitly turns off its extended edition.
      extendedHours = extendedHours.filter((h) => activeHours.includes(h));
    }

    const [row] = await deps.db
      .update(preferences)
      .set({ ...body, activeHours, extendedHours, updatedAt: deps.now() })
      .where(eq(preferences.userId, user.id))
      .returning();
    return c.json({ preferences: toPreferencesDto(row!) });
  });

  app.post('/preview', async (c) => {
    const body = await readJson(c, VoicePreviewBody);
    assertVoice(body.voiceId);
    previewLimiter.hit(c.get('user').id);
    const result = await deps.tts.synthesize({
      text: PREVIEW_SAMPLES[body.tone],
      voiceId: body.voiceId,
      tone: body.tone,
      toneNote: body.toneNote || undefined,
    });
    return c.body(new Uint8Array(result.audio), 200, {
      'Content-Type': result.mime,
      'Content-Length': String(result.audio.length),
      'Cache-Control': 'no-store',
    });
  });

  return app;
}
