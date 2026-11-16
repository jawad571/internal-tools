import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { EditionDto } from '@shared/contracts';
import { editionMeta, editionTitle } from '../lib/format';
import { storage } from '../lib/storage';
import { useEditions } from './editions';

export const RATES = [0.8, 1, 1.2, 1.5, 1.75, 2] as const;
const RATE_KEY = 'nc.rate';
const POS_KEY = (id: string) => `nc.pos.${id}`;
const LISTENED_AT = 0.9;
const BACK_S = 15;
const FWD_S = 30;

type PlayerState = {
  edition: EditionDto | null;
  playing: boolean;
  buffering: boolean;
  time: number;
  duration: number;
  rate: number;
  error: string | null;
  newer: EditionDto | null;
  older: EditionDto | null;
  /** Load an edition (and start it unless autoplay is false). Must run inside a user gesture to autoplay. */
  play: (e?: EditionDto) => void;
  /** Show an edition in the player without starting it, if nothing is loaded yet. */
  cue: (e: EditionDto) => void;
  toggle: () => void;
  pause: () => void;
  seekTo: (t: number) => void;
  seekBy: (d: number) => void;
  setRate: (r: number) => void;
  cycleRate: () => void;
  playNewer: () => void;
  playOlder: () => void;
  stop: () => void;
};

const Ctx = createContext<PlayerState | null>(null);

function savedRate(): number {
  const r = Number.parseFloat(storage.get(RATE_KEY) ?? '');
  return Number.isFinite(r) && r >= 0.8 && r <= 2 ? r : 1;
}

function savedPosition(id: string): number {
  const v = Number.parseFloat(storage.get(POS_KEY(id)) ?? '');
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function playable(e: EditionDto): boolean {
  return e.status === 'ready' && !!e.audioUrl;
}

/** Ready editions newest first (the list is already newest first). */
function queueOf(list: EditionDto[] | null): EditionDto[] {
  return (list ?? []).filter(playable);
}

/** After `current` ends: catch up chronologically on newer unlistened, else the most recent older unlistened. */
function nextUnlistened(list: EditionDto[] | null, current: EditionDto): EditionDto | null {
  const q = queueOf(list).filter((e) => e.id !== current.id && !e.listened);
  const newer = q.filter((e) => e.slotAt > current.slotAt);
  if (newer.length) return newer[newer.length - 1]!;
  const older = q.filter((e) => e.slotAt <= current.slotAt);
  return older[0] ?? null;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { editions, markListened } = useEditions();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [edition, setEdition] = useState<EditionDto | null>(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRateState] = useState(savedRate);
  const [error, setError] = useState<string | null>(null);

  const editionRef = useRef<EditionDto | null>(null);
  const editionsRef = useRef(editions);
  editionsRef.current = editions;
  const lastSaved = useRef(0);
  const marked = useRef(new Set<string>());
  const pendingSeek = useRef<number | null>(null);

  // Keep the loaded edition in sync with fresher list data (title, listened, etc.).
  useEffect(() => {
    if (!edition || !editions) return;
    const fresh = editions.find((e) => e.id === edition.id);
    if (fresh && (fresh.listened !== edition.listened || fresh.title !== edition.title)) {
      setEdition(fresh);
      editionRef.current = fresh;
    }
  }, [editions, edition]);

  // Clear the player when signed out.
  useEffect(() => {
    if (editions === null && editionRef.current) {
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.removeAttribute('src');
        a.load();
      }
      editionRef.current = null;
      setEdition(null);
      setPlaying(false);
      setTime(0);
      setDuration(0);
    }
  }, [editions]);

  const savePosition = useCallback((force = false) => {
    const a = audioRef.current;
    const e = editionRef.current;
    if (!a || !e) return;
    if (!force && Math.abs(a.currentTime - lastSaved.current) < 5) return;
    lastSaved.current = a.currentTime;
    if (a.duration && a.currentTime > a.duration - 5) storage.remove(POS_KEY(e.id));
    else if (a.currentTime > 1) storage.set(POS_KEY(e.id), a.currentTime.toFixed(1));
  }, []);

  const load = useCallback(
    (e: EditionDto, autoplay: boolean) => {
      const a = audioRef.current;
      if (!a || !e.audioUrl) return;
      savePosition(true);
      editionRef.current = e;
      setEdition(e);
      setError(null);
      setTime(0);
      setDuration(e.durationSeconds ?? 0);
      const resume = savedPosition(e.id);
      pendingSeek.current = resume > 0 ? resume : null;
      lastSaved.current = resume;
      a.src = e.audioUrl;
      a.defaultPlaybackRate = rate;
      a.playbackRate = rate;
      if (autoplay) {
        setBuffering(true);
        a.play().catch((err: unknown) => {
          setBuffering(false);
          if (err instanceof DOMException && err.name === 'AbortError') return;
          if (err instanceof DOMException && err.name === 'NotAllowedError') return;
          setError('This bulletin could not be played.');
        });
      } else {
        a.load();
      }
    },
    [rate, savePosition],
  );

  const play = useCallback(
    (e?: EditionDto) => {
      const a = audioRef.current;
      if (!a) return;
      if (e && e.id !== editionRef.current?.id) return load(e, true);
      if (!editionRef.current) return;
      a.play().catch(() => setError('This bulletin could not be played.'));
    },
    [load],
  );

  const cue = useCallback(
    (e: EditionDto) => {
      if (!editionRef.current && playable(e)) load(e, false);
    },
    [load],
  );

  const pause = useCallback(() => audioRef.current?.pause(), []);
  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a || !editionRef.current) return;
    if (a.paused) play();
    else a.pause();
  }, [play]);

  const seekTo = useCallback((t: number) => {
    const a = audioRef.current;
    if (!a) return;
    const max = Number.isFinite(a.duration) ? a.duration : Infinity;
    a.currentTime = Math.max(0, Math.min(t, max - 0.25));
    setTime(a.currentTime);
  }, []);
  const seekBy = useCallback((d: number) => seekTo((audioRef.current?.currentTime ?? 0) + d), [seekTo]);

  const setRate = useCallback((r: number) => {
    const a = audioRef.current;
    setRateState(r);
    storage.set(RATE_KEY, String(r));
    if (a) {
      a.defaultPlaybackRate = r;
      a.playbackRate = r;
    }
  }, []);
  const cycleRate = useCallback(() => {
    const i = RATES.findIndex((r) => Math.abs(r - rate) < 0.01);
    setRate(RATES[(i + 1) % RATES.length]!);
  }, [rate, setRate]);

  const queue = useMemo(() => queueOf(editions), [editions]);
  const idx = edition ? queue.findIndex((e) => e.id === edition.id) : -1;
  const newer = idx > 0 ? queue[idx - 1]! : null;
  const older = idx >= 0 && idx < queue.length - 1 ? queue[idx + 1]! : null;
  const playNewer = useCallback(() => newer && load(newer, true), [newer, load]);
  const playOlder = useCallback(() => older && load(older, true), [older, load]);

  const stop = useCallback(() => {
    const a = audioRef.current;
    a?.pause();
  }, []);

  // ---- audio element events ----
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      setTime(a.currentTime);
      savePosition();
      const e = editionRef.current;
      if (e && a.duration && Number.isFinite(a.duration) && a.currentTime / a.duration >= LISTENED_AT) {
        if (!marked.current.has(e.id) && !e.listened) {
          marked.current.add(e.id);
          markListened(e.id);
        }
      }
    };
    const onMeta = () => {
      if (Number.isFinite(a.duration)) setDuration(a.duration);
      if (pendingSeek.current !== null) {
        const t = pendingSeek.current;
        pendingSeek.current = null;
        if (Number.isFinite(a.duration) && t < a.duration - 10) {
          a.currentTime = t;
          setTime(t);
        }
      }
      a.playbackRate = a.defaultPlaybackRate;
    };
    const onPlay = () => {
      setPlaying(true);
      setError(null);
    };
    const onPlaying = () => setBuffering(false);
    const onWaiting = () => setBuffering(true);
    const onPause = () => {
      setPlaying(false);
      setBuffering(false);
      savePosition(true);
    };
    const onEnded = () => {
      setPlaying(false);
      const e = editionRef.current;
      if (!e) return;
      storage.remove(POS_KEY(e.id));
      if (!marked.current.has(e.id) && !e.listened) {
        marked.current.add(e.id);
        markListened(e.id);
      }
      const next = nextUnlistened(editionsRef.current, { ...e, listened: true });
      if (next) load(next, true);
    };
    const onError = () => {
      if (!a.getAttribute('src')) return;
      setBuffering(false);
      setPlaying(false);
      setError('Could not load the audio for this bulletin.');
    };
    const onHide = () => savePosition(true);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onMeta);
    a.addEventListener('play', onPlay);
    a.addEventListener('playing', onPlaying);
    a.addEventListener('waiting', onWaiting);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onEnded);
    a.addEventListener('error', onError);
    window.addEventListener('pagehide', onHide);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onMeta);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('playing', onPlaying);
      a.removeEventListener('waiting', onWaiting);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('error', onError);
      window.removeEventListener('pagehide', onHide);
    };
  }, [load, markListened, savePosition]);

  // ---- Media Session: lock screen, headphones, car ----
  useEffect(() => {
    if (!('mediaSession' in navigator) || !edition) return;
    try {
      const base = import.meta.env.BASE_URL;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: editionTitle(edition),
        artist: `Newscast · ${editionMeta(edition)}`,
        album: 'Newscast',
        artwork: [
          { src: `${base}icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${base}icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
        ],
      });
    } catch {
      /* MediaMetadata unsupported */
    }
  }, [edition]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* action unsupported on this platform */
      }
    };
    set('play', edition ? () => play() : null);
    set('pause', edition ? () => pause() : null);
    set('seekbackward', edition ? (d) => seekBy(-(d.seekOffset ?? BACK_S)) : null);
    set('seekforward', edition ? (d) => seekBy(d.seekOffset ?? FWD_S) : null);
    set('seekto', edition ? (d) => d.seekTime !== undefined && seekTo(d.seekTime) : null);
    set('previoustrack', older ? () => playOlder() : null);
    set('nexttrack', newer ? () => playNewer() : null);
  }, [edition, newer, older, play, pause, seekBy, seekTo, playNewer, playOlder]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = edition ? (playing ? 'playing' : 'paused') : 'none';
  }, [playing, edition]);

  // Position state: on meaningful changes and every few seconds while playing.
  const posTick = Math.floor(time / 5);
  useEffect(() => {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!edition || !duration || !Number.isFinite(duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: rate,
        position: Math.min(audioRef.current?.currentTime ?? time, duration),
      });
    } catch {
      /* ignore invalid state */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition, duration, rate, playing, posTick]);

  const value = useMemo<PlayerState>(
    () => ({
      edition,
      playing,
      buffering,
      time,
      duration,
      rate,
      error,
      newer,
      older,
      play,
      cue,
      toggle,
      pause,
      seekTo,
      seekBy,
      setRate,
      cycleRate,
      playNewer,
      playOlder,
      stop,
    }),
    [edition, playing, buffering, time, duration, rate, error, newer, older, play, cue, toggle, pause, seekTo, seekBy, setRate, cycleRate, playNewer, playOlder, stop],
  );

  return (
    <Ctx.Provider value={value}>
      {/* The one audio element for the whole app. It sits above the router so playback survives navigation. */}
      <audio ref={audioRef} preload="metadata" hidden />
      {children}
    </Ctx.Provider>
  );
}

export function usePlayer(): PlayerState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePlayer outside PlayerProvider');
  return ctx;
}

export const SKIP = { back: BACK_S, forward: FWD_S };
