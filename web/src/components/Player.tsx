import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { EditionDto } from '@shared/contracts';
import { clock, editionMeta, editionTitle } from '../lib/format';
import { SKIP, usePlayer } from '../state/player';
import { Icon, SkipIcon } from './Icon';
import { Spinner } from './ui';

export function EqBars({ active }: { active: boolean }) {
  return (
    <span className={`eq${active ? ' is-active' : ''}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function Scrubber({ time, duration, onSeek, disabled }: { time: number; duration: number; onSeek: (t: number) => void; disabled?: boolean }) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? time;
  const max = duration > 0 ? duration : 1;
  const pct = Math.min(100, (shown / max) * 100);
  const commit = () => {
    if (drag !== null) {
      onSeek(drag);
      setDrag(null);
    }
  };
  return (
    <div className="scrubber">
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(shown, max)}
        disabled={disabled}
        aria-label="Seek"
        aria-valuetext={`${clock(shown)} of ${clock(duration)}`}
        style={{ ['--pct' as string]: `${pct}%` }}
        onChange={(e) => setDrag(Number(e.currentTarget.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        onTouchEnd={commit}
      />
      <div className="scrubber-times" aria-hidden="true">
        <span>{clock(shown)}</span>
        <span>−{clock(Math.max(0, duration - shown))}</span>
      </div>
    </div>
  );
}

function rateLabel(r: number) {
  return `${Number.isInteger(r) ? r.toFixed(0) : String(r)}×`;
}

/** The big player on the Listen screen. Shows the loaded edition, or `fallback` (latest ready) if nothing is loaded. */
export function HeroPlayer({ fallback }: { fallback: EditionDto }) {
  const p = usePlayer();
  const e = p.edition ?? fallback;
  const isLoaded = p.edition?.id === e.id;
  const playing = isLoaded && p.playing;
  const duration = isLoaded && p.duration ? p.duration : (e.durationSeconds ?? 0);
  const time = isLoaded ? p.time : 0;

  return (
    <section className="hero" aria-label="Player">
      <div className="hero-top">
        <p className="hero-kicker">
          <EqBars active={playing} />
          {playing ? 'Now playing' : isLoaded && time > 1 ? 'Paused' : e.listened ? 'Latest bulletin · heard' : 'Latest bulletin'}
        </p>
        <button
          type="button"
          className="rate-pill"
          onClick={p.cycleRate}
          aria-label={`Playback speed ${rateLabel(p.rate)}. Tap to change.`}
        >
          {rateLabel(p.rate)}
        </button>
      </div>
      <h2 className="hero-title">{editionTitle(e)}</h2>
      <p className="hero-meta">{editionMeta(e)}</p>

      <Scrubber time={time} duration={duration} onSeek={p.seekTo} disabled={!isLoaded} />

      <div className="transport">
        <button type="button" className="t-btn t-small" onClick={p.playOlder} disabled={!isLoaded || !p.older} aria-label="Previous edition">
          <Icon name="prev" size={24} />
        </button>
        <button type="button" className="t-btn" onClick={() => p.seekBy(-SKIP.back)} disabled={!isLoaded} aria-label={`Back ${SKIP.back} seconds`}>
          <SkipIcon seconds={SKIP.back} dir="back" />
        </button>
        <button
          type="button"
          className="t-play"
          onClick={() => (isLoaded ? p.toggle() : p.play(e))}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {isLoaded && p.buffering && playing ? <Spinner size={34} /> : <Icon name={playing ? 'pause' : 'play'} size={40} />}
        </button>
        <button type="button" className="t-btn" onClick={() => p.seekBy(SKIP.forward)} disabled={!isLoaded} aria-label={`Forward ${SKIP.forward} seconds`}>
          <SkipIcon seconds={SKIP.forward} dir="forward" />
        </button>
        <button type="button" className="t-btn t-small" onClick={p.playNewer} disabled={!isLoaded || !p.newer} aria-label="Next edition">
          <Icon name="next" size={24} />
        </button>
      </div>

      {p.error && isLoaded && (
        <p className="hero-error" role="alert">
          <Icon name="alert" size={18} /> {p.error}
        </p>
      )}

      <Link className="hero-link" to={`/listen/${e.id}`}>
        Stories &amp; transcript <Icon name="chevronRight" size={18} />
      </Link>
    </section>
  );
}

/** Docked bar shown on every screen except the Listen home (which has the hero). */
export function MiniPlayer() {
  const p = usePlayer();
  const { pathname } = useLocation();
  if (!p.edition || pathname === '/listen') return null;
  const pct = p.duration ? Math.min(100, (p.time / p.duration) * 100) : 0;
  return (
    <div className="mini" role="region" aria-label="Now playing">
      <div className="mini-progress" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <Link to="/listen" className="mini-info">
        <EqBars active={p.playing} />
        <span className="mini-text">
          <span className="mini-title">{editionTitle(p.edition)}</span>
          <span className="mini-meta">
            {clock(p.time)} / {clock(p.duration)} · {editionMeta(p.edition)}
          </span>
        </span>
      </Link>
      <button type="button" className="t-btn mini-skip" onClick={() => p.seekBy(-SKIP.back)} aria-label={`Back ${SKIP.back} seconds`}>
        <SkipIcon seconds={SKIP.back} dir="back" size={28} />
      </button>
      <button type="button" className="mini-play" onClick={p.toggle} aria-label={p.playing ? 'Pause' : 'Play'}>
        <Icon name={p.playing ? 'pause' : 'play'} size={26} />
      </button>
    </div>
  );
}
