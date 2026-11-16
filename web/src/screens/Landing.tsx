import { useEffect, useId, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { LIMITS } from '@shared/contracts';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../state/auth';
import { Icon } from '../components/Icon';
import { Mark } from '../components/Wordmark';
import { Spinner } from '../components/ui';

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function Landing({ mode: initialMode }: { mode: 'signup' | 'login' }) {
  const [mode, setMode] = useState(initialMode);
  const navigate = useNavigate();
  const location = useLocation();
  const { setMe, expired } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const ids = { name: useId(), email: useId(), pw: useId(), err: useId() };

  useEffect(() => setMode(initialMode), [initialMode]);
  useEffect(() => {
    document.title = 'Newscast — the news, read to you on the hour';
  }, []);

  const switchMode = (m: 'signup' | 'login') => {
    setMode(m);
    setError(null);
    navigate(m === 'login' ? '/login' : '/', { replace: true });
  };

  const onSubmit = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const email = String(f.get('email') ?? '').trim();
    const password = String(f.get('password') ?? '');
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') {
        const displayName = String(f.get('displayName') ?? '').trim();
        if (password.length < 8) throw new Error('Use at least 8 characters for your password.');
        const me = await api.signup({ email, password, displayName, timezone: browserTimezone() });
        setMe(me);
        navigate('/welcome', { replace: true });
      } else {
        const me = await api.login({ email, password });
        setMe(me);
        const from = (location.state as { from?: string } | null)?.from;
        navigate(from && from.startsWith('/') ? from : '/listen', { replace: true });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <section className="pitch">
        <div className="pitch-brand">
          <Mark size={40} />
          <span>Newscast</span>
        </div>
        <h1 className="pitch-title">
          The news, read to you <em>on the hour.</em>
        </h1>
        <p className="pitch-lede">
          Choose the outlets you trust, a voice you like and the hours you’re on the move. Each hour you pick, Newscast writes
          and reads you a fresh five-to-ten minute bulletin — no repeats, no filler.
        </p>
        <ul className="pitch-points">
          <li>
            <Icon name="sources" size={22} />
            <span>Your sources, weighted the way you read them</span>
          </li>
          <li>
            <Icon name="voice" size={22} />
            <span>Six tones, from calm to witty</span>
          </li>
          <li>
            <Icon name="podcast" size={22} />
            <span>Plays here, on your lock screen, or in any podcast app</span>
          </li>
        </ul>
      </section>

      <section className="auth-card" aria-labelledby="auth-heading">
        <h2 id="auth-heading" className="visually-hidden">
          {mode === 'signup' ? 'Create your account' : 'Log in'}
        </h2>
        <div className="auth-tabs" role="tablist" aria-label="Account">
          <button type="button" role="tab" aria-selected={mode === 'signup'} onClick={() => switchMode('signup')}>
            Sign up
          </button>
          <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => switchMode('login')}>
            Log in
          </button>
        </div>

        {expired && mode === 'login' && !error && (
          <p className="note note-info" role="status">
            Your session ended. Log in again to keep listening.
          </p>
        )}

        <form className="form" onSubmit={onSubmit} aria-describedby={error ? ids.err : undefined} noValidate={false}>
          {mode === 'signup' && (
            <div className="field">
              <label htmlFor={ids.name}>Your name</label>
              <input id={ids.name} name="displayName" autoComplete="given-name" required maxLength={60} placeholder="What should the host call you?" />
            </div>
          )}
          <div className="field">
            <label htmlFor={ids.email}>Email</label>
            <input id={ids.email} name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} />
          </div>
          <div className="field">
            <label htmlFor={ids.pw}>Password</label>
            <div className="input-with-action">
              <input
                id={ids.pw}
                name="password"
                type={showPw ? 'text' : 'password'}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                required
                minLength={mode === 'signup' ? 8 : 1}
                maxLength={200}
              />
              <button type="button" className="input-action" onClick={() => setShowPw((s) => !s)} aria-pressed={showPw}>
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
            {mode === 'signup' && <p className="field-hint">At least 8 characters.</p>}
          </div>

          {error && (
            <p className="note note-error" id={ids.err} role="alert">
              <Icon name="alert" size={18} /> <span>{error}</span>
            </p>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy && <Spinner size={18} />}
            {mode === 'signup' ? 'Create account' : 'Log in'}
          </button>
          {mode === 'signup' && <p className="fine-print">
              Free plan: up to {LIMITS.plans.free.maxSources} sources and {LIMITS.plans.free.maxActiveHours} scheduled bulletins a day. No card needed.
            </p>}
        </form>
      </section>
    </div>
  );
}
