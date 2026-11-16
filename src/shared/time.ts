import { DateTime, IANAZone } from 'luxon';
import { urduHourLabel } from './constants.ts';

export const isValidTimezone = (tz: string) => IANAZone.isValidZone(tz);

export interface Slot {
  /** Instant of the local top-of-hour. */
  slotAt: Date;
  /** 0-23 in the user's zone. */
  localHour: number;
}

/** The next local top-of-hour strictly after `now` in `tz` (handles :30/:45 offset zones and DST). */
export function nextSlot(now: Date, tz: string): Slot {
  const next = DateTime.fromJSDate(now, { zone: tz }).startOf('hour').plus({ hours: 1 });
  return { slotAt: next.toJSDate(), localHour: next.hour };
}

/** Local hour (0-23) of an instant in `tz`. */
export const localHourOf = (at: Date, tz: string) => DateTime.fromJSDate(at, { zone: tz }).hour;

/**
 * e.g. "Monday 16 November, 6 AM" — handed to the script writer for the greeting, so it is
 * phrased in the spoken language. Urdu: "پیر، 16 نومبر، شام 6 بجے" (Intl's "6 PM" and Latin
 * comma read badly aloud). Other locales use luxon/Intl names in the English pattern.
 */
export function spokenSlotLabel(at: Date, tz: string, locale = 'en'): string {
  const dt = DateTime.fromJSDate(at, { zone: tz });
  if (locale === 'ur' || locale.startsWith('ur-')) {
    const ur = dt.setLocale('ur');
    return `${ur.toFormat('cccc')}، ${dt.day} ${ur.toFormat('LLLL')}، ${urduHourLabel(dt.hour)}`;
  }
  return dt.setLocale(locale).toFormat('cccc d LLLL, h a');
}

/** Always-English slot label, for on-screen video text. */
export const englishSlotLabel = (at: Date, tz: string) => spokenSlotLabel(at, tz, 'en');
