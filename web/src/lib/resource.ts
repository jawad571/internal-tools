import { useCallback, useEffect, useReducer } from 'react';
import { ApiError } from './api';

/**
 * A deliberately tiny shared cache for GET resources: one entry per key, every
 * component using the key sees the same data, and `mutate` gives optimistic updates.
 */
type Entry = {
  data?: unknown;
  error?: ApiError | Error;
  promise?: Promise<unknown>;
  fetcher: () => Promise<unknown>;
  listeners: Set<() => void>;
  loadedAt: number;
};

const cache = new Map<string, Entry>();
const STALE_MS = 30_000;

function entryFor(key: string, fetcher: () => Promise<unknown>): Entry {
  let e = cache.get(key);
  if (!e) {
    e = { fetcher, listeners: new Set(), loadedAt: 0 };
    cache.set(key, e);
  }
  return e;
}

function notify(e: Entry) {
  for (const l of e.listeners) l();
}

function load(key: string): Promise<unknown> {
  const e = cache.get(key);
  if (!e) return Promise.resolve(undefined);
  if (e.promise) return e.promise;
  const p = e
    .fetcher()
    .then((data) => {
      e.data = data;
      e.error = undefined;
      e.loadedAt = Date.now();
      return data;
    })
    .catch((err: unknown) => {
      e.error = err instanceof Error ? err : new Error(String(err));
      return undefined;
    })
    .finally(() => {
      e.promise = undefined;
      notify(e);
    });
  e.promise = p;
  notify(e);
  return p;
}

export function mutateResource<T>(key: string, updater: T | ((prev: T | undefined) => T)) {
  const e = cache.get(key);
  if (!e) return;
  e.data = typeof updater === 'function' ? (updater as (p: T | undefined) => T)(e.data as T | undefined) : updater;
  e.error = undefined;
  notify(e);
}

export function reloadResource(key: string) {
  return load(key);
}

export function clearResources() {
  for (const e of cache.values()) {
    e.data = undefined;
    e.error = undefined;
    e.loadedAt = 0;
    notify(e);
  }
}

export function useResource<T>(key: string, fetcher: () => Promise<T>) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const e = entryFor(key, fetcher);

  useEffect(() => {
    const entry = entryFor(key, fetcher);
    entry.listeners.add(force);
    if ((entry.data === undefined || Date.now() - entry.loadedAt > STALE_MS) && !entry.promise) void load(key);
    return () => {
      entry.listeners.delete(force);
    };
    // fetcher identity is irrelevant; the key names the resource
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reload = useCallback(() => load(key), [key]);
  const mutate = useCallback((u: T | ((prev: T | undefined) => T)) => mutateResource<T>(key, u), [key]);

  return {
    data: e.data as T | undefined,
    error: e.error,
    loading: e.data === undefined && !e.error,
    reload,
    mutate,
  };
}
