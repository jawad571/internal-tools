import { languageInfo } from '@shared/constants';
import type { EditionDto } from '@shared/contracts';

const hourFmtCache = new Map<string, Intl.DateTimeFormat>();

/** "6 AM" / "18" etc. following the browser locale. */
export function hourLabel(hour: number): string {
  let f = hourFmtCache.get('h');
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' });
    hourFmtCache.set('h', f);
  }
  return f.format(Date.UTC(2020, 0, 1, hour)).replace(/\s+/g, ' ');
}

/** "9:00" style start time for a given local hour. */
export function hourClock(hour: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    .format(Date.UTC(2020, 0, 1, hour))
    .replace(/\s+/g, ' ');
}

export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function minutesLabel(seconds: number | null | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

export function kindLabel(kind: EditionDto['kind']): string {
  return kind === 'extended' ? 'Extended' : 'Standard';
}

/** "6 AM · Extended · 14 min" */
export function editionMeta(e: EditionDto): string {
  return [hourLabel(e.localHour), kindLabel(e.kind), minutesLabel(e.durationSeconds)].filter(Boolean).join(' · ');
}

export function editionTitle(e: EditionDto): string {
  return e.title ?? `${hourLabel(e.localHour)} ${e.kind === 'extended' ? 'extended edition' : 'bulletin'}`;
}

/**
 * lang/dir for text in the edition's spoken language (its title and script). Story headlines and
 * the app's own labels are English and stay LTR. The fallback title is English too.
 */
export function spokenTextProps(e: Pick<EditionDto, 'language'>): { lang: string; dir: 'ltr' | 'rtl' } {
  const info = languageInfo(e.language);
  return { lang: info.code, dir: info.dir };
}

/** Props for editionTitle(e): spoken-language when the title came from the script writer. */
export const titleTextProps = (e: Pick<EditionDto, 'language' | 'title'>) =>
  e.title ? spokenTextProps(e) : { lang: 'en', dir: 'ltr' as const };

export const STATUS_TEXT: Record<EditionDto['status'], string> = {
  pending: 'Queued',
  scripting: 'Writing the script',
  synthesizing: 'Recording the voice',
  ready: 'Ready',
  skipped: 'Skipped — no fresh stories',
  failed: 'Did not finish',
};

export function isInProgress(e: Pick<EditionDto, 'status'>): boolean {
  return e.status === 'pending' || e.status === 'scripting' || e.status === 'synthesizing';
}

function safeTz(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** YYYY-MM-DD of an instant in a time zone. */
export function dayKey(iso: string, tz?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTz(tz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
  return parts;
}

export function dayHeading(iso: string, tz?: string, now = new Date()): string {
  const key = dayKey(iso, tz);
  const today = dayKey(now.toISOString(), tz);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000).toISOString(), tz);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: safeTz(tz),
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

export function dateTime(iso: string, tz?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: safeTz(tz),
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Current hour (0–23) in a time zone. */
export function currentHourIn(tz?: string, now = new Date()): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: safeTz(tz), hour: '2-digit', hourCycle: 'h23' }).format(now);
  return Number.parseInt(h, 10) % 24;
}

/** Next scheduled local hour strictly after now, or null if none/paused. */
export function nextScheduledHour(
  activeHours: readonly number[],
  paused: boolean,
  tz?: string,
): { hour: number; tomorrow: boolean } | null {
  if (paused || activeHours.length === 0) return null;
  const now = currentHourIn(tz);
  const sorted = [...activeHours].sort((a, b) => a - b);
  const later = sorted.find((h) => h > now);
  if (later !== undefined) return { hour: later, tomorrow: false };
  return { hour: sorted[0]!, tomorrow: true };
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
