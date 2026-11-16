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
import { isSupportedLanguage, languageInfo, SUPPORTED_LANGUAGES, type LanguageCode } from '../shared/constants.ts';
import type { Deps } from '../shared/deps.ts';
import { requireUser } from './auth.ts';
import { HttpError, readJson, type AppEnv } from './http.ts';
import { RateLimiter } from './rate-limit.ts';

const PREVIEW_SAMPLES_EN: Record<ToneId, string> = {
  neutral: 'Good morning. Here is your Newscast: the top stories from your chosen sources, summarised clearly and without fuss.',
  warm: "Hello, and thanks for tuning in. It's lovely to have you here, so let's catch up on today's news together.",
  energetic: "Good morning and welcome to your Newscast! We've got a packed bulletin today, so let's jump straight in!",
  calm: "Good evening. Settle in, take a breath, and let's go gently through the stories that mattered most today.",
  witty: "Welcome back to your Newscast, where the news is real, the jokes are brief, and nobody mentions the weather. Mostly.",
  formal: 'Good evening. This is your Newscast. The headlines at the top of the hour, read in full from your selected sources.',
};

const PREVIEW_SAMPLES: Record<LanguageCode, Record<ToneId, string>> = {
  en: PREVIEW_SAMPLES_EN,
  ur: {
    neutral: 'السلام علیکم۔ یہ ہے آپ کا نیوزکاسٹ: آپ کے منتخب ذرائع سے اہم خبریں، صاف اور سیدھے انداز میں۔',
    warm: 'السلام علیکم، اور ہمارے ساتھ شامل ہونے کا شکریہ۔ آپ کا ساتھ اچھا لگا، تو آئیے مل کر آج کی خبروں پر نظر ڈالتے ہیں۔',
    energetic: 'صبح بخیر، اور آپ کے نیوزکاسٹ میں خوش آمدید! آج بہت سی خبریں ہیں، تو چلیے سیدھے شروع کرتے ہیں!',
    calm: 'شام بخیر۔ آرام سے بیٹھیے، ایک گہری سانس لیجیے، اور آئیے آہستہ آہستہ آج کی اہم ترین خبروں کا جائزہ لیتے ہیں۔',
    witty: 'نیوزکاسٹ میں ایک بار پھر خوش آمدید، جہاں خبریں سچی ہیں، مذاق مختصر ہیں، اور موسم کا ذکر کوئی نہیں کرتا۔ زیادہ تر۔',
    formal: 'شام بخیر۔ یہ آپ کا نیوزکاسٹ ہے۔ آپ کے منتخب ذرائع سے اس گھنٹے کی سرخیاں، پوری تفصیل کے ساتھ۔',
  },
};

const assertLanguage = (code: string): LanguageCode => {
  if (!isSupportedLanguage(code)) {
    const options = SUPPORTED_LANGUAGES.map((l) => `${l.name} (${l.code})`).join(', ');
    throw new HttpError(422, 'unsupported_language', `Bulletins can't be read in "${code}" yet. Choose one of: ${options}`);
  }
  return code;
};

export const toPreferencesDto = (p: Preferences, videoAvailable: boolean): PreferencesDto => ({
  voiceId: p.voiceId,
  tone: p.tone as ToneId,
  toneNote: p.toneNote,
  language: p.language,
  standardMinutes: p.standardMinutes,
  extendedMinutes: p.extendedMinutes,
  activeHours: p.activeHours,
  extendedHours: p.extendedHours,
  paused: p.paused,
  videoBulletins: p.videoBulletins,
  videoAvailable,
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
    return c.json({ preferences: toPreferencesDto(await loadPreferences(deps, c.get('user').id), deps.config.VIDEO_ENABLED) });
  });

  app.put('/', async (c) => {
    const user = c.get('user');
    const body = await readJson(c, UpdatePreferencesBody);
    const current = await loadPreferences(deps, user.id);

    if (body.voiceId !== undefined) assertVoice(body.voiceId);
    if (body.language !== undefined) assertLanguage(body.language);

    // Switching language without choosing a voice moves to that language's default voice, unless the
    // current voice is meant for it too. A voice sent in the same request is the listener's explicit
    // choice and is kept even if it's meant for another language (e.g. a British voice reading Urdu).
    let voiceId = body.voiceId ?? current.voiceId;
    if (body.voiceId === undefined && body.language !== undefined && body.language !== current.language) {
      const fits = deps.tts.voices().some((v) => v.id === voiceId && v.languages.includes(body.language!));
      if (!fits) voiceId = deps.tts.defaultVoiceId(body.language);
    }
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
      .set({ ...body, voiceId, activeHours, extendedHours, updatedAt: deps.now() })
      .where(eq(preferences.userId, user.id))
      .returning();
    return c.json({ preferences: toPreferencesDto(row!, deps.config.VIDEO_ENABLED) });
  });

  app.post('/preview', async (c) => {
    const body = await readJson(c, VoicePreviewBody);
    assertVoice(body.voiceId);
    const language =
      body.language !== undefined ? assertLanguage(body.language) : languageInfo((await loadPreferences(deps, c.get('user').id)).language).code;
    previewLimiter.hit(c.get('user').id);
    const result = await deps.tts.synthesize({
      text: PREVIEW_SAMPLES[language][body.tone],
      voiceId: body.voiceId,
      tone: body.tone,
      toneNote: body.toneNote || undefined,
      language,
    });
    return c.body(new Uint8Array(result.audio), 200, {
      'Content-Type': result.mime,
      'Content-Length': String(result.audio.length),
      'Cache-Control': 'no-store',
    });
  });

  return app;
}
