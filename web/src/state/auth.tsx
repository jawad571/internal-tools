import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Me } from '@shared/contracts';
import { api, ApiError, onUnauthorized } from '../lib/api';
import { clearResources } from '../lib/resource';

type AuthState = {
  status: 'loading' | 'anon' | 'authed';
  me: Me | null;
  /** True when the session ended underneath us (a 401), so the login screen can say why. */
  expired: boolean;
  /** Where the public screens should send the user once signed in (e.g. onboarding after signup). */
  nextPath: string | null;
  setMe: (me: Me, nextPath?: string) => void;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [expired, setExpired] = useState(false);
  const [nextPath, setNextPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((m) => {
        if (cancelled) return;
        setMeState(m);
        setStatus('authed');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (!(e instanceof ApiError) || e.status !== 401) console.warn('Could not load session', e);
        setStatus('anon');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    onUnauthorized(() => {
      clearResources();
      setMeState((prev) => {
        if (prev) setExpired(true);
        return null;
      });
      setStatus('anon');
    });
    return () => onUnauthorized(null);
  }, []);

  const setMe = useCallback((m: Me, next?: string) => {
    if (next !== undefined) setNextPath(next);
    setMeState(m);
    setStatus('authed');
    setExpired(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* the session is going away either way */
    }
    clearResources();
    setMeState(null);
    setExpired(false);
    setStatus('anon');
  }, []);

  const value = useMemo(
    () => ({ status, me, expired, nextPath, setMe, logout }),
    [status, me, expired, nextPath, setMe, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** For screens behind the auth guard. */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('useMe without a session');
  return me;
}
