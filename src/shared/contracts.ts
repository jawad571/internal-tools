/**
 * API contract shared by the server (validation) and the web app (types).
 * Must stay free of Node-only imports: the browser bundle imports this file.
 *
 * All routes are under /api, JSON in/out, cookie-session auth unless noted.
 * Errors are `{ error: { code, message } }` with an appropriate HTTP status.
 */
import { z } from 'zod';
import { LIMITS } from './constants.ts';

export { LIMITS, SUPPORTED_LANGUAGES, TONES } from './constants.ts';
export type { LanguageCode } from './constants.ts';

// ---------- enums & limits ----------

export const ToneId = z.enum(['neutral', 'warm', 'energetic', 'calm', 'witty', 'formal']);
export type ToneId = z.infer<typeof ToneId>;

export const Plan = z.enum(['free', 'pro']);
export type Plan = z.infer<typeof Plan>;

const Hour = z.number().int().min(0).max(23);
const Hours = z.array(Hour).max(24).transform((h) => [...new Set(h)].sort((a, b) => a - b));

export const EditionKind = z.enum(['standard', 'extended']);
export const EditionStatus = z.enum(['pending', 'scripting', 'synthesizing', 'ready', 'skipped', 'failed']);
/** none = not requested (preference off or server has video disabled). */
export const VideoStatus = z.enum(['none', 'pending', 'rendering', 'ready', 'failed']);

// ---------- auth & account ----------

export const SignupBody = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(60),
  timezone: z.string().min(1).max(64),
});
export const LoginBody = z.object({ email: z.email(), password: z.string().min(1).max(200) });
export const UpdateMeBody = z
  .object({ displayName: z.string().trim().min(1).max(60), timezone: z.string().min(1).max(64) })
  .partial();

export const Me = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  timezone: z.string(),
  plan: Plan,
  /** Absolute URL of the private podcast feed. */
  podcastFeedUrl: z.string(),
});
export type Me = z.infer<typeof Me>;

// ---------- sources ----------

export const SourceDto = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  siteUrl: z.string().nullable(),
  category: z.string(),
  isCurated: z.boolean(),
});
export type SourceDto = z.infer<typeof SourceDto>;

export const MySourceDto = SourceDto.extend({
  weight: z.number().int().min(1).max(3),
  /** Last fetch failed repeatedly; UI should flag it. */
  unhealthy: z.boolean(),
});
export type MySourceDto = z.infer<typeof MySourceDto>;

/** Subscribe either to a catalog source by id, or to any RSS/Atom feed by URL. */
export const AddSourceBody = z.union([
  z.object({ sourceId: z.uuid() }),
  z.object({ url: z.url().max(2000) }),
]);
export const UpdateSourceBody = z.object({ weight: z.number().int().min(1).max(3) });

// ---------- voice, tone, schedule ----------

export const VoiceDto = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  gender: z.enum(['female', 'male', 'neutral']),
  /** Bulletin languages (SUPPORTED_LANGUAGES codes) this voice is meant for. */
  languages: z.array(z.string()),
});
export type VoiceDto = z.infer<typeof VoiceDto>;

export const PreferencesDto = z.object({
  voiceId: z.string(),
  tone: ToneId,
  toneNote: z.string(),
  language: z.string(),
  standardMinutes: z.number().int(),
  extendedMinutes: z.number().int(),
  activeHours: z.array(Hour),
  extendedHours: z.array(Hour),
  paused: z.boolean(),
  /** Also make a video version of each bulletin. */
  videoBulletins: z.boolean(),
  /** Read-only: whether this server renders video at all (VIDEO_ENABLED). */
  videoAvailable: z.boolean(),
});
export type PreferencesDto = z.infer<typeof PreferencesDto>;

export const UpdatePreferencesBody = z
  .object({
    voiceId: z.string().min(1).max(100),
    tone: ToneId,
    toneNote: z.string().trim().max(LIMITS.toneNoteMax),
    /** Must also be one of SUPPORTED_LANGUAGES (checked by the server: 422 otherwise). */
    language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    standardMinutes: z.number().int().min(LIMITS.standardMinutes.min).max(LIMITS.standardMinutes.max),
    extendedMinutes: z.number().int().min(LIMITS.extendedMinutes.min).max(LIMITS.extendedMinutes.max),
    activeHours: Hours,
    extendedHours: Hours,
    paused: z.boolean(),
    videoBulletins: z.boolean(),
  })
  .partial();
export type UpdatePreferencesBody = z.infer<typeof UpdatePreferencesBody>;

export const VoicePreviewBody = z.object({
  voiceId: z.string().min(1).max(100),
  tone: ToneId,
  toneNote: z.string().trim().max(LIMITS.toneNoteMax).optional(),
  /** Language of the sample sentence; defaults to the listener's bulletin language. */
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
});

// ---------- editions ----------

export const EditionDto = z.object({
  id: z.string(),
  slotAt: z.iso.datetime(),
  localHour: Hour,
  kind: EditionKind,
  trigger: z.enum(['scheduled', 'on_demand']),
  status: EditionStatus,
  /** Spoken language of this edition (SUPPORTED_LANGUAGES code). */
  language: z.string(),
  /** In the spoken language. */
  title: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  /** Relative URL, present only when status = ready. */
  audioUrl: z.string().nullable(),
  listened: z.boolean(),
  storyCount: z.number().int(),
  videoStatus: VideoStatus,
  /** Relative URL of the MP4, present only when videoStatus = ready. */
  videoUrl: z.string().nullable(),
});
export type EditionDto = z.infer<typeof EditionDto>;

export const EditionDetailDto = EditionDto.extend({
  /** In the spoken language (`language`). */
  script: z.string().nullable(),
  error: z.string().nullable(),
  stories: z.array(
    z.object({
      title: z.string(),
      url: z.string().nullable(),
      sourceTitle: z.string(),
      publishedAt: z.iso.datetime(),
      /** Lead image URL from the feed (third-party host). */
      imageUrl: z.string().nullable(),
      /** Where this story starts in the audio/video, when timings are known. */
      startSeconds: z.number().nullable(),
    }),
  ),
});
export type EditionDetailDto = z.infer<typeof EditionDetailDto>;

export const GenerateNowBody = z.object({ kind: EditionKind.default('standard') });

// ---------- route table (documentation; keep in sync with src/server) ----------
//
// POST   /api/auth/signup            SignupBody            -> { me: Me }           (sets cookie)
// POST   /api/auth/login             LoginBody             -> { me: Me }           (sets cookie)
// POST   /api/auth/logout                                  -> { ok: true }
// GET    /api/me                                           -> { me: Me }
// PATCH  /api/me                     UpdateMeBody          -> { me: Me }
// POST   /api/me/rotate-feed-token                         -> { me: Me }
//
// GET    /api/sources/catalog                              -> { sources: SourceDto[] }
// GET    /api/sources                                      -> { sources: MySourceDto[] }
// POST   /api/sources                AddSourceBody         -> { source: MySourceDto }
// PATCH  /api/sources/:id            UpdateSourceBody      -> { source: MySourceDto }
// DELETE /api/sources/:id                                  -> { ok: true }
//
// GET    /api/voices                                       -> { voices: VoiceDto[] }
// GET    /api/preferences                                  -> { preferences: PreferencesDto }
// PUT    /api/preferences            UpdatePreferencesBody -> { preferences: PreferencesDto }
// POST   /api/preferences/preview    VoicePreviewBody      -> audio bytes (Content-Type from provider)
//
// GET    /api/editions?limit=&before=                      -> { editions: EditionDto[] }  (newest first; excludes skipped)
// GET    /api/editions/:id                                 -> { edition: EditionDetailDto }
// POST   /api/editions/generate      GenerateNowBody       -> { edition: EditionDto }     (202)
// POST   /api/editions/:id/listened                        -> { ok: true }
// GET    /api/editions/:id/audio[?token=feedToken]         -> audio, supports Range       (cookie OR token)
// GET    /api/editions/:id/video[?token=feedToken]         -> video/mp4, supports Range   (cookie OR token)
//
// GET    /feed/:feedToken.xml                              -> podcast RSS (no cookie; token is the credential)
// GET    /healthz                                          -> { ok: true }
