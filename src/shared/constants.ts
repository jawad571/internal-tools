/** Zod-free constants, so the browser bundle can use them without pulling in the schemas. */

export const TONES = [
  { id: 'neutral', label: 'Neutral', blurb: 'Straight wire-service delivery. Facts first, no colour.' },
  { id: 'warm', label: 'Warm', blurb: 'A friendly host who is glad you tuned in.' },
  { id: 'energetic', label: 'Energetic', blurb: 'Upbeat morning-radio pace.' },
  { id: 'calm', label: 'Calm', blurb: 'Unhurried and soothing. Good for late evening.' },
  { id: 'witty', label: 'Witty', blurb: 'Dry asides between stories; never at the expense of accuracy.' },
  { id: 'formal', label: 'Formal', blurb: 'Classic broadcast newsreader.' },
] as const;

export const LIMITS = {
  standardMinutes: { min: 5, max: 10, default: 7 },
  extendedMinutes: { min: 10, max: 20, default: 15 },
  toneNoteMax: 280,
  plans: {
    free: { maxSources: 8, maxActiveHours: 6, onDemandPerDay: 2, defaultActiveHours: [6, 9, 12, 15, 18, 21] },
    pro: { maxSources: 60, maxActiveHours: 24, onDemandPerDay: 12, defaultActiveHours: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21] },
  },
} as const;

/**
 * Languages a bulletin can be spoken in. Adding one is one line here (plus voices for it, if the
 * TTS provider's voices are per-language). Video text stays English whatever the spoken language.
 *
 * wordsPerMinute: speaking rate used for the word budget, relative to English's default 150
 * (WORDS_PER_MINUTE scales every language). Urdu: spoken Hindustani puts postpositions and
 * auxiliaries in separate words (کا، کی، ہے، رہا تھا), so the same content takes more words.
 * Hindi, its closest measured relative, runs ~8% more words per minute than English
 * (median 181 vs 168 WPM over ~4,100 captioned videos, sozai.app/speaking-rate-by-language,
 * Oct 2026); 150 × 1.08 ≈ 160.
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr', wordsPerMinute: 150 },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', dir: 'rtl', wordsPerMinute: 160 },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];
export type LanguageInfo = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: LanguageCode = 'en';

export const isSupportedLanguage = (code: string): code is LanguageCode => SUPPORTED_LANGUAGES.some((l) => l.code === code);

/** Info for a language code; unknown codes get English (the default). */
export const languageInfo = (code: string | null | undefined): LanguageInfo =>
  SUPPORTED_LANGUAGES.find((l) => l.code === code) ?? SUPPORTED_LANGUAGES[0];

/** Words per minute for a language, scaled by the configured English rate (WORDS_PER_MINUTE). */
export const wordsPerMinuteFor = (code: string, englishWpm: number = SUPPORTED_LANGUAGES[0].wordsPerMinute) =>
  (englishWpm * languageInfo(code).wordsPerMinute) / SUPPORTED_LANGUAGES[0].wordsPerMinute;

/** Voices whose `languages` include `code`. */
export const voicesForLanguage = <V extends { languages: readonly string[] }>(voices: readonly V[], code: string): V[] =>
  voices.filter((v) => v.languages.includes(code));

/** True if any character is in an Arabic-script block (Urdu, Arabic, Persian…). */
export const hasArabicScript = (s: string) => /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(s);

/**
 * Urdu has no AM/PM in speech: the hour is said with its part of the day, e.g. "شام 6 بجے"
 * (evening six o'clock). 0-23 local hour.
 */
export function urduHourLabel(hour: number): string {
  let part = 'رات'; // night, 20:00-03:59
  if (hour >= 4 && hour < 12) part = 'صبح'; // morning
  else if (hour >= 12 && hour < 15) part = 'دوپہر'; // midday
  else if (hour >= 15 && hour < 17) part = 'سہ پہر'; // afternoon
  else if (hour >= 17 && hour < 20) part = 'شام'; // evening
  return `${part} ${hour % 12 || 12} بجے`;
}
