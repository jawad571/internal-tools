import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, useAuth } from './state/auth';
import { EditionsProvider } from './state/editions';
import { PlayerProvider } from './state/player';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/ui';
import { Landing } from './screens/Landing';
import { Onboarding } from './screens/Onboarding';
import { Listen } from './screens/Listen';
import { EditionDetail } from './screens/EditionDetail';
import { Sources } from './screens/Sources';
import { Voice } from './screens/Voice';
import { Schedule } from './screens/Schedule';
import { Account } from './screens/Account';

function Splash() {
  return (
    <div className="splash">
      <Spinner size={28} label="Loading Newscast" />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { status, expired } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Splash />;
  if (status === 'anon') return <Navigate to="/login" replace state={expired ? { from: location.pathname } : undefined} />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { status, nextPath } = useAuth();
  if (status === 'loading') return <Splash />;
  if (status === 'authed') return <Navigate to={nextPath ?? '/listen'} replace />;
  return <>{children}</>;
}

function Providers({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  return (
    <EditionsProvider enabled={status === 'authed'}>
      <PlayerProvider>{children}</PlayerProvider>
    </EditionsProvider>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Providers>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<PublicOnly><Landing mode="signup" /></PublicOnly>} />
            <Route path="/login" element={<PublicOnly><Landing mode="login" /></PublicOnly>} />
            <Route path="/welcome" element={<RequireAuth><Onboarding /></RequireAuth>} />
            <Route element={<RequireAuth><AppShell /></RequireAuth>}>
              <Route path="/listen" element={<Listen />} />
              <Route path="/listen/:id" element={<EditionDetail />} />
              <Route path="/sources" element={<Sources />} />
              <Route path="/voice" element={<Voice />} />
              <Route path="/schedule" element={<Schedule />} />
              <Route path="/account" element={<Account />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </Providers>
    </AuthProvider>
  );
}
