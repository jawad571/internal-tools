import { DateTime, IANAZone } from 'luxon';

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

/** e.g. "Monday 16 November, 6 AM" — handed to the script writer for the greeting. */
export const spokenSlotLabel = (at: Date, tz: string, locale = 'en') =>
  DateTime.fromJSDate(at, { zone: tz }).setLocale(locale).toFormat("cccc d LLLL, h a");
