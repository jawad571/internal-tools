import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EditionDto } from '@shared/contracts';
import { api, type EditionKind } from '../lib/api';
import { isInProgress } from '../lib/format';

type EditionsState = {
  editions: EditionDto[] | null;
  error: Error | null;
  hasMore: boolean;
  loadingMore: boolean;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
  generate: (kind: EditionKind) => Promise<EditionDto>;
  markListened: (id: string) => void;
  /** Merge a fresher copy of one edition (e.g. from the detail endpoint). */
  upsert: (e: EditionDto) => void;
};

const Ctx = createContext<EditionsState | null>(null);
const PAGE = 30;
const POLL_MS = 3000;
const IDLE_REFRESH_MS = 60_000;

function mergeById(a: EditionDto[], b: EditionDto[]): EditionDto[] {
  const map = new Map<string, EditionDto>();
  for (const e of a) map.set(e.id, e);
  for (const e of b) map.set(e.id, { ...map.get(e.id), ...e });
  return [...map.values()].sort((x, y) => (x.slotAt < y.slotAt ? 1 : x.slotAt > y.slotAt ? -1 : 0));
}

export function EditionsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [editions, setEditions] = useState<EditionDto[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const listenedLocally = useRef(new Set<string>());

  const reload = useCallback(async () => {
    try {
      const list = await api.editions({ limit: PAGE });
      // keep older pages we already loaded; refresh the newest page
      setEditions((prev) => {
        const merged = mergeById(prev ?? [], list);
        return merged.map((e) => (listenedLocally.current.has(e.id) ? { ...e, listened: true } : e));
      });
      setHasMore((prev) => (prev ? prev : list.length >= PAGE));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, []);

  const loadMore = useCallback(async () => {
    const oldest = editions?.[editions.length - 1];
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const list = await api.editions({ limit: PAGE, before: oldest.slotAt });
      setEditions((prev) => mergeById(prev ?? [], list));
      setHasMore(list.length >= PAGE);
    } finally {
      setLoadingMore(false);
    }
  }, [editions]);

  useEffect(() => {
    if (!enabled) {
      setEditions(null);
      setError(null);
      setHasMore(false);
      listenedLocally.current.clear();
      return;
    }
    void reload();
  }, [enabled, reload]);

  // Poll quickly while anything is being made; otherwise refresh gently while visible.
  const anyInProgress = !!editions?.some(isInProgress);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const t = window.setInterval(tick, anyInProgress ? POLL_MS : IDLE_REFRESH_MS);
    const onVis = () => tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled, anyInProgress, reload]);

  const generate = useCallback(async (kind: EditionKind) => {
    const e = await api.generate(kind);
    setEditions((prev) => mergeById(prev ?? [], [e]));
    return e;
  }, []);

  const markListened = useCallback((id: string) => {
    if (listenedLocally.current.has(id)) return;
    listenedLocally.current.add(id);
    setEditions((prev) => prev?.map((e) => (e.id === id ? { ...e, listened: true } : e)) ?? prev);
    api.markListened(id).catch((err: unknown) => {
      listenedLocally.current.delete(id);
      console.warn('Could not mark as listened', err);
    });
  }, []);

  const upsert = useCallback((e: EditionDto) => {
    setEditions((prev) => (prev ? mergeById(prev, [e]) : prev));
  }, []);

  const value = useMemo(
    () => ({ editions, error, hasMore, loadingMore, reload, loadMore, generate, markListened, upsert }),
    [editions, error, hasMore, loadingMore, reload, loadMore, generate, markListened, upsert],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEditions(): EditionsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useEditions outside EditionsProvider');
  return ctx;
}
