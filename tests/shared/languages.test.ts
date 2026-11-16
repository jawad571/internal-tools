import { describe, expect, it } from 'vitest';
import {
  hasArabicScript,
  isSupportedLanguage,
  languageInfo,
  SUPPORTED_LANGUAGES,
  voicesForLanguage,
  wordsPerMinuteFor,
} from '../../src/shared/constants.ts';
import { englishSlotLabel, spokenSlotLabel } from '../../src/shared/time.ts';

describe('supported languages', () => {
  it('lists English (default, first) and Urdu with native names and direction', () => {
    expect(SUPPORTED_LANGUAGES.map((l) => [l.code, l.name, l.nativeName, l.dir])).toEqual([
      ['en', 'English', 'English', 'ltr'],
      ['ur', 'Urdu', 'اردو', 'rtl'],
    ]);
    expect(isSupportedLanguage('ur')).toBe(true);
    expect(isSupportedLanguage('fr')).toBe(false);
    expect(languageInfo('xx').code).toBe('en');
    expect(languageInfo(null).code).toBe('en');
  });

  it('scales the word budget per language from the configured English rate', () => {
    expect(wordsPerMinuteFor('en', 150)).toBe(150);
    expect(wordsPerMinuteFor('ur', 150)).toBe(160);
    expect(wordsPerMinuteFor('ur', 180)).toBe(192);
    expect(wordsPerMinuteFor('xx', 150)).toBe(150);
  });

  it('filters voices by language', () => {
    const voices = [
      { id: 'a', languages: ['en'] },
      { id: 'b', languages: ['ur'] },
      { id: 'c', languages: ['en', 'ur'] },
    ];
    expect(voicesForLanguage(voices, 'ur').map((v) => v.id)).toEqual(['b', 'c']);
  });

  it('detects Arabic-script text (Urdu, incl. presentation forms)', () => {
    expect(hasArabicScript('اردو')).toBe(true);
    expect(hasArabicScript('Lahore ﻻ')).toBe(true);
    expect(hasArabicScript('Newscast · Monday 16 November, 6 PM')).toBe(false);
  });
});

describe('spokenSlotLabel', () => {
  const at = (iso: string) => new Date(iso);

  it('English is unchanged', () => {
    expect(spokenSlotLabel(at('2026-11-16T13:00:00Z'), 'Asia/Karachi')).toBe('Monday 16 November, 6 PM');
    expect(englishSlotLabel(at('2026-11-16T13:00:00Z'), 'Asia/Karachi')).toBe('Monday 16 November, 6 PM');
  });

  it('Urdu reads naturally aloud: Urdu day and month, part of day + hour + بجے, Urdu commas', () => {
    // 18:00 PKT
    expect(spokenSlotLabel(at('2026-11-16T13:00:00Z'), 'Asia/Karachi', 'ur')).toBe('پیر، 16 نومبر، شام 6 بجے');
    const hour = (h: number) => spokenSlotLabel(at(`2026-11-16T${String(h).padStart(2, '0')}:00:00Z`), 'UTC', 'ur').split('، ').at(-1);
    expect(hour(6)).toBe('صبح 6 بجے');
    expect(hour(12)).toBe('دوپہر 12 بجے');
    expect(hour(15)).toBe('سہ پہر 3 بجے');
    expect(hour(21)).toBe('رات 9 بجے');
    expect(hour(0)).toBe('رات 12 بجے');
    expect(spokenSlotLabel(at('2026-11-21T04:00:00Z'), 'UTC', 'ur')).toBe('ہفتہ، 21 نومبر، صبح 4 بجے');
    expect(spokenSlotLabel(at('2026-11-16T13:00:00Z'), 'Asia/Karachi', 'ur')).not.toMatch(/PM|AM|,/);
  });
});
