import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LIMITS } from '@shared/constants';
import type { PreferencesDto } from '@shared/contracts';
import { api } from '../lib/api';
import { hourLabel } from '../lib/format';
import { useAuth, useMe } from '../state/auth';
import { usePreferences } from '../state/data';
import { Icon } from './Icon';

type Saver = <T>(fn: () => Promise<T>) => Promise<T | undefined>;
type HourState = 'off' | 'standard' | 'extended';

const PARTS = [
  { label: 'Night', hours: [0, 1, 2, 3, 4, 5] },
  { label: 'Morning', hours: [6, 7, 8, 9, 10, 11] },
  { label: 'Afternoon', hours: [12, 13, 14, 15, 16, 17] },
  { label: 'Evening', hours: [18, 19, 20, 21, 22, 23] },
];

export const PRESETS: { id: string; label: string; desc: string; active: number[]; extended: number[] }[] = [
  { id: 'commute', label: 'Commute', desc: '7–8 AM and 5–6 PM', active: [7, 8, 17, 18], extended: [7] },
  { id: 'bookends', label: 'Morning & evening', desc: 'Extended at 6 AM and 9 PM', active: [6, 8, 12, 18, 21], extended: [6, 21] },
  {
    id: 'waking',
    label: 'Every waking hour',
    desc: '6 AM to 9 PM',
    active: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    extended: [6, 21],
  },
];

function stateOf(prefs: PreferencesDto, h: number): HourState {
  if (!prefs.activeHours.includes(h)) return 'off';
  return prefs.extendedHours.includes(h) ? 'extended' : 'standard';
}

const STATE_TEXT: Record<HourState, string> = { off: 'Off', standard: 'Standard', extended: 'Extended' };

export function useMaxHours() {
  const me = useMe();
  return LIMITS.plans[me.plan].maxActiveHours;
}

export function HourGrid({ prefs, run, onLimit }: { prefs: PreferencesDto; run: Saver; onLimit: (msg: string | null) => void }) {
  const { save } = usePreferences();
  const max = useMaxHours();
  const me = useMe();

  const cycle = (h: number) => {
    const s = stateOf(prefs, h);
    let active = prefs.activeHours.filter((x) => x !== h);
    let extended = prefs.extendedHours.filter((x) => x !== h);
    if (s === 'off') {
      if (prefs.activeHours.length >= max) {
        onLimit(
          `Your ${me.plan === 'free' ? 'Free' : 'Pro'} plan includes up to ${max} bulletin hours a day. Turn one off to add ${hourLabel(h)}.`,
        );
        return;
      }
      active = [...active, h];
    } else if (s === 'standard') {
      active = [...active, h];
      extended = [...extended, h];
    }
    onLimit(null);
    void run(() => save({ activeHours: active.sort((a, b) => a - b), extendedHours: extended.sort((a, b) => a - b) }));
  };

  return (
    <div className={`hour-grid${prefs.paused ? ' is-paused' : ''}`}>
      <ul className="hour-legend" aria-label="Legend">
        <li>
          <span className="cell-swatch s-off" aria-hidden="true" /> Off
        </li>
        <li>
          <span className="cell-swatch s-standard" aria-hidden="true" /> Standard · {prefs.standardMinutes} min
        </li>
        <li>
          <span className="cell-swatch s-extended" aria-hidden="true" /> Extended · {prefs.extendedMinutes} min
        </li>
      </ul>
      {PARTS.map((part) => (
        <section key={part.label} className="hour-part" aria-label={part.label}>
          <h3>{part.label}</h3>
          <div className="hour-cells">
            {part.hours.map((h) => {
              const s = stateOf(prefs, h);
              return (
                <button
                  key={h}
                  type="button"
                  className={`hour-cell s-${s}`}
                  onClick={() => cycle(h)}
                  aria-label={`${hourLabel(h)}: ${STATE_TEXT[s]}. Tap to change.`}
                >
                  <span className="hour-time">{hourLabel(h)}</span>
                  <span className="hour-state">
                    {s === 'standard' && <span className="pip" aria-hidden="true" />}
                    {s === 'extended' && (
                      <span className="pip-pair" aria-hidden="true">
                        <span className="pip" />
                        <span className="pip" />
                      </span>
                    )}
                    {STATE_TEXT[s]}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export function Presets({ prefs, run, onLimit }: { prefs: PreferencesDto; run: Saver; onLimit: (msg: string | null) => void }) {
  const { save } = usePreferences();
  const max = useMaxHours();
  const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((x, i) => x === [...b].sort((p, q) => p - q)[i]);
  return (
    <div className="presets" role="group" aria-label="Quick presets">
      {PRESETS.map((p) => {
        const tooMany = p.active.length > max;
        const on = same(prefs.activeHours, p.active) && same(prefs.extendedHours, p.extended);
        return (
          <button
            key={p.id}
            type="button"
            className={`preset${on ? ' is-on' : ''}`}
            aria-pressed={on}
            aria-disabled={tooMany}
            onClick={() => {
              if (tooMany) {
                onLimit(`${p.label} needs ${p.active.length} hours; your plan includes up to ${max}.`);
                return;
              }
              onLimit(null);
              void run(() => save({ activeHours: p.active, extendedHours: p.extended }));
            }}
          >
            <span className="preset-label">{p.label}</span>
            <span className="preset-desc">{tooMany ? `${p.active.length} hours · Pro plan` : p.desc}</span>
          </button>
        );
      })}
    </div>
  );
}

function allZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  if (!zones.includes(current)) zones = [current, ...zones];
  if (!zones.includes('UTC')) zones.push('UTC');
  return zones;
}

function zoneTime(tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date());
  } catch {
    return '';
  }
}

export function TimezonePicker({ run }: { run: Saver }) {
  const me = useMe();
  const { setMe } = useAuth();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const searchId = useId();
  const zones = useMemo(() => allZones(me.timezone), [me.timezone]);
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/\s+/g, '_');
    const list = needle ? zones.filter((z) => z.toLowerCase().includes(needle)) : zones;
    return list.slice(0, 80);
  }, [zones, q]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus({ preventScroll: true });
    panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open]);

  const choose = (tz: string) => {
    setOpen(false);
    setQ('');
    if (tz === me.timezone) return;
    void run(async () => {
      const next = await api.updateMe({ timezone: tz });
      setMe(next);
      return next;
    });
  };

  return (
    <div className="tz">
      <button type="button" className="tz-current" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
        <Icon name="globe" size={22} />
        <span className="tz-text">
          <span className="tz-name">{me.timezone.replace(/_/g, ' ')}</span>
          <span className="tz-time">It’s {zoneTime(me.timezone)} there now</span>
        </span>
        <span className="tz-change">
          Change <Icon name="chevronDown" size={18} />
        </span>
      </button>
      {open && (
        <div className="tz-panel" id={listId} ref={panelRef}>
          <label htmlFor={searchId} className="visually-hidden">
            Search time zones
          </label>
          <div className="search">
            <Icon name="search" size={20} />
            <input
              id={searchId}
              ref={inputRef}
              type="search"
              placeholder="Search a city, e.g. Lisbon"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter' && matches[0]) choose(matches[0]);
              }}
            />
          </div>
          <ul className="tz-list" aria-label="Time zones">
            {matches.map((z) => (
              <li key={z}>
                <button type="button" className={z === me.timezone ? 'is-current' : ''} aria-current={z === me.timezone} onClick={() => choose(z)}>
                  <span>{z.replace(/_/g, ' ')}</span>
                  <span className="tz-list-time">{zoneTime(z)}</span>
                </button>
              </li>
            ))}
            {matches.length === 0 && <li className="muted tz-none">No time zone matches “{q}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
