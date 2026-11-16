import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LIMITS, SUPPORTED_LANGUAGES, TONES, languageInfo, voicesForLanguage } from '@shared/constants';
import type { PreferencesDto, ToneId } from '@shared/contracts';
import { api, errorMessage } from '../lib/api';
import { usePlayer } from '../state/player';
import { usePreferences, useVoices } from '../state/data';
import { Icon } from './Icon';
import { ErrorNote, Loading, Spinner } from './ui';

type Saver = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

/** Plays one voice sample at a time through its own Audio object; pauses the main player first. */
function usePreview() {
  const player = usePlayer();
  const [state, setState] = useState<{ voiceId: string; phase: 'loading' | 'playing' } | null>(null);
  const [error, setError] = useState<{ voiceId: string; message: string } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const reqId = useRef(0);

  const cleanup = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const stop = useCallback(() => {
    reqId.current++;
    cleanup();
    setState(null);
  }, [cleanup]);

  const start = useCallback(
    async (voiceId: string, tone: ToneId, toneNote: string, language: string) => {
      stop();
      player.pause();
      setError(null);
      const id = ++reqId.current;
      setState({ voiceId, phase: 'loading' });
      try {
        const blob = await api.preview({ voiceId, tone, toneNote: toneNote.trim() || undefined, language });
        if (id !== reqId.current) return;
        url.current = URL.createObjectURL(blob);
        const a = new Audio(url.current);
        audio.current = a;
        a.addEventListener('ended', () => id === reqId.current && stop());
        await a.play();
        if (id === reqId.current) setState({ voiceId, phase: 'playing' });
      } catch (e) {
        if (id !== reqId.current) return;
        cleanup();
        setState(null);
        setError({ voiceId, message: errorMessage(e) });
      }
    },
    [player, stop, cleanup],
  );

  return { state, error, start, stop };
}

/** Spoken language of the bulletin. Changing it also moves to that language's first voice (server-side). */
export function LanguagePicker({ prefs, run }: { prefs: PreferencesDto; run: Saver }) {
  const { save } = usePreferences();
  const name = useId();
  return (
    <div className="tone-grid lang-grid" role="radiogroup" aria-label="Bulletin language">
      {SUPPORTED_LANGUAGES.map((l) => {
        const selected = prefs.language === l.code;
        return (
          <label key={l.code} className={`tone-card${selected ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name={name}
              value={l.code}
              checked={selected}
              onChange={() => void run(() => save({ language: l.code }))}
              className="visually-hidden"
            />
            <span className="tone-label">
              <span lang={l.code} dir={l.dir} className="lang-native">
                {l.nativeName}
              </span>
              {selected && <Icon name="check" size={18} />}
            </span>
            {l.nativeName !== l.name && <span className="tone-blurb">{l.name}</span>}
          </label>
        );
      })}
    </div>
  );
}

export function VoicePicker({ prefs, run }: { prefs: PreferencesDto; run: Saver }) {
  const voices = useVoices();
  const { save } = usePreferences();
  const preview = usePreview();
  const name = useId();
  const [showAll, setShowAll] = useState(false);
  if (voices.loading) return <Loading label="Loading voices" />;
  if (voices.error) return <ErrorNote error={voices.error} onRetry={voices.reload} />;
  const all = voices.data ?? [];
  const matching = voicesForLanguage(all, prefs.language);
  // A voice picked for another language (allowed, if unusual) stays visible so the selection is.
  const shown = showAll || !matching.length ? all : all.filter((v) => matching.includes(v) || v.id === prefs.voiceId);
  const langName = languageInfo(prefs.language).name;
  return (
    <>
      <div className="voice-grid" role="radiogroup" aria-label="Voice">
        {shown.map((v) => {
          const selected = prefs.voiceId === v.id;
          const ps = preview.state?.voiceId === v.id ? preview.state.phase : null;
          const err = preview.error?.voiceId === v.id ? preview.error.message : null;
          return (
            <div key={v.id} className={`voice-card${selected ? ' is-selected' : ''}`}>
              <label className="voice-choose">
                <input
                  type="radio"
                  name={name}
                  value={v.id}
                  checked={selected}
                  onChange={() => void run(() => save({ voiceId: v.id }))}
                  className="visually-hidden"
                />
                <span className="voice-radio" aria-hidden="true">
                  {selected && <Icon name="check" size={16} />}
                </span>
                <span className="voice-text">
                  <span className="voice-name">{v.name}</span>
                  <span className="voice-desc">
                    {v.description}
                    {!v.languages.includes(prefs.language) && ` Made for ${v.languages.map((c) => languageInfo(c).name).join(', ')}.`}
                  </span>
                </span>
              </label>
              <button
                type="button"
                className="preview-btn"
                onClick={() => (ps ? preview.stop() : void preview.start(v.id, prefs.tone, prefs.toneNote, prefs.language))}
                aria-label={ps ? `Stop preview of ${v.name}` : `Preview ${v.name}`}
              >
                {ps === 'loading' ? <Spinner size={18} /> : <Icon name={ps === 'playing' ? 'stop' : 'play'} size={18} />}
                <span>{ps === 'loading' ? 'Loading' : ps === 'playing' ? 'Stop' : 'Preview'}</span>
              </button>
              {err && (
                <p className="field-error voice-error" role="alert">
                  <Icon name="alert" size={16} /> {err}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {matching.length > 0 && matching.length < all.length && (
        <button type="button" className="link-btn voice-more" onClick={() => setShowAll((x) => !x)} aria-expanded={showAll}>
          {showAll ? `Only show ${langName} voices` : `Show voices made for other languages`}
        </button>
      )}
    </>
  );
}

export function TonePicker({ prefs, run }: { prefs: PreferencesDto; run: Saver }) {
  const { save } = usePreferences();
  const name = useId();
  return (
    <div className="tone-grid" role="radiogroup" aria-label="Tone">
      {TONES.map((t) => {
        const selected = prefs.tone === t.id;
        return (
          <label key={t.id} className={`tone-card${selected ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name={name}
              value={t.id}
              checked={selected}
              onChange={() => void run(() => save({ tone: t.id }))}
              className="visually-hidden"
            />
            <span className="tone-label">
              {t.label}
              {selected && <Icon name="check" size={18} />}
            </span>
            <span className="tone-blurb">{t.blurb}</span>
          </label>
        );
      })}
    </div>
  );
}

export function ToneNote({ prefs, run }: { prefs: PreferencesDto; run: Saver }) {
  const { save } = usePreferences();
  const [value, setValue] = useState(prefs.toneNote);
  const id = useId();
  const countId = useId();
  const max = LIMITS.toneNoteMax;
  useEffect(() => setValue(prefs.toneNote), [prefs.toneNote]);
  const commit = () => {
    const v = value.trim();
    if (v !== prefs.toneNote) void run(() => save({ toneNote: v }));
  };
  return (
    <div className="field">
      <label htmlFor={id}>
        A note for your host <span className="optional">optional</span>
      </label>
      <textarea
        id={id}
        rows={3}
        maxLength={max}
        value={value}
        placeholder="e.g. Skip celebrity news. Explain economics simply. Say the date at the start."
        aria-describedby={countId}
        onChange={(e) => setValue(e.target.value.slice(0, max))}
        onBlur={commit}
      />
      <div className="field-foot">
        <span className="field-hint">Saved when you leave the box.</span>
        <span id={countId} className={`counter${value.length > max - 20 ? ' is-near' : ''}`} aria-live="polite">
          {value.length}/{max}
        </span>
      </div>
    </div>
  );
}

function LengthSlider({
  label,
  hint,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
}) {
  const [v, setV] = useState(value);
  const id = useId();
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setV(value), [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const pct = ((v - min) / (max - min)) * 100;
  return (
    <div className="length">
      <div className="length-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="length-value">
          {v} min
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={v}
        style={{ ['--pct' as string]: `${pct}%` }}
        aria-valuetext={`${v} minutes`}
        onChange={(e) => {
          const n = Number(e.currentTarget.value);
          setV(n);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => n !== value && onCommit(n), 450);
        }}
      />
      <div className="length-scale" aria-hidden="true">
        <span>{min}</span>
        <span>{hint}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

export function LengthSliders({ prefs, run }: { prefs: PreferencesDto; run: Saver }) {
  const { save } = usePreferences();
  return (
    <div className="lengths">
      <LengthSlider
        label="Standard bulletins"
        hint="minutes"
        value={prefs.standardMinutes}
        min={LIMITS.standardMinutes.min}
        max={LIMITS.standardMinutes.max}
        onCommit={(n) => void run(() => save({ standardMinutes: n }))}
      />
      <LengthSlider
        label="Extended editions"
        hint="minutes"
        value={prefs.extendedMinutes}
        min={LIMITS.extendedMinutes.min}
        max={LIMITS.extendedMinutes.max}
        onCommit={(n) => void run(() => save({ extendedMinutes: n }))}
      />
    </div>
  );
}
