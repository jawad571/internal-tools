import { useCallback, useRef } from 'react';
import type { MySourceDto, PreferencesDto, UpdatePreferencesBody } from '@shared/contracts';
import { api } from '../lib/api';
import { mutateResource, useResource } from '../lib/resource';

export function usePreferences() {
  const r = useResource('preferences', api.preferences);
  const seq = useRef(0);
  /** Optimistic: applies locally at once, reconciles with the server, rolls back on error. */
  const save = useCallback(async (patch: UpdatePreferencesBody) => {
    const id = ++seq.current;
    let prev: PreferencesDto | undefined;
    mutateResource<PreferencesDto>('preferences', (p) => {
      prev = p;
      return { ...(p as PreferencesDto), ...patch };
    });
    try {
      const next = await api.updatePreferences(patch);
      if (id === seq.current) mutateResource('preferences', next);
      return next;
    } catch (e) {
      if (id === seq.current && prev) mutateResource('preferences', prev);
      throw e;
    }
  }, []);
  return { ...r, save };
}

export function useMySources() {
  return useResource<MySourceDto[]>('mySources', api.mySources);
}

export function useCatalog() {
  return useResource('catalog', api.catalog);
}

export function useVoices() {
  return useResource('voices', api.voices);
}
