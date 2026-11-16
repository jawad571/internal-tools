import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../lib/api';
import { hourClock, nextScheduledHour } from '../lib/format';
import { useMe } from '../state/auth';
import { useMySources, usePreferences } from '../state/data';
import { useEditions } from '../state/editions';
import { AddByUrl, CatalogBrowser, useSourceLimit } from '../components/Sources';
import { HourGrid, Presets, useMaxHours } from '../components/Schedule';
import { TonePicker, VoicePicker } from '../components/VoiceTone';
import { Icon } from '../components/Icon';
import { Mark } from '../components/Wordmark';
import { ErrorNote, Loading, SaveIndicator, Spinner, UsageMeter, useSaveStatus } from '../components/ui';

const STEPS = ['Sources', 'Voice & tone', 'Hours'] as const;

export function Onboarding() {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const me = useMe();
  const prefs = usePreferences();
  const sources = useMySources();
  const limit = useSourceLimit();
  const maxHours = useMaxHours();
  const { generate } = useEditions();
  const { status, run } = useSaveStatus();
  const [err, setErr] = useState<string | null>(null);
  const [limitMsg, setLimitMsg] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  useEffect(() => {
    document.title = `Set up · ${STEPS[step]} · Newscast`;
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    headingRef.current?.focus();
  }, [step]);

  const finish = async () => {
    setMaking(true);
    setErr(null);
    try {
      await generate('standard');
      navigate('/listen', { replace: true });
    } catch (e) {
      setErr(errorMessage(e));
      setMaking(false);
    }
  };

  const count = sources.data?.length ?? 0;
  const next = prefs.data ? nextScheduledHour(prefs.data.activeHours, prefs.data.paused, me.timezone) : null;

  return (
    <div className="onboarding">
      <header className="ob-top">
        <div className="ob-brand">
          <Mark size={28} />
          <span className="ob-step">
            Step {step + 1} of {STEPS.length}
            <span className="ob-step-name"> · {STEPS[step]}</span>
          </span>
        </div>
        <div className="ob-top-right">
          <SaveIndicator status={status} />
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => navigate('/listen', { replace: true })}>
            Skip setup
          </button>
        </div>
        <div
          className="ob-progress"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-valuenow={step + 1}
        >
          <span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
        </div>
      </header>

      <main className="ob-body" id="main">
        {step === 0 && (
          <>
            <h1 ref={headingRef} tabIndex={-1}>
              Welcome, {me.displayName}. Which outlets do you trust?
            </h1>
            <p className="lede">Pick a few to start. You can fine-tune priorities later.</p>
            {sources.data && <UsageMeter used={count} max={limit} label="sources" />}
            {err && <p className="note note-error" role="alert">{err}</p>}
            <CatalogBrowser onError={setErr} />
            <details className="ob-more">
              <summary>Have a feed that isn’t listed?</summary>
              <div className="card">
                <AddByUrl disabled={count >= limit} />
              </div>
            </details>
          </>
        )}

        {step === 1 && (
          <>
            <h1 ref={headingRef} tabIndex={-1}>
              Who reads your news, and how?
            </h1>
            <p className="lede">Choose a voice and a tone. Preview to hear them together.</p>
            {prefs.loading && <Loading />}
            {prefs.error && <ErrorNote error={prefs.error} onRetry={prefs.reload} />}
            {prefs.data && (
              <>
                <h2 className="section-title">Voice</h2>
                <VoicePicker prefs={prefs.data} run={run} />
                <h2 className="section-title">Tone</h2>
                <TonePicker prefs={prefs.data} run={run} />
              </>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h1 ref={headingRef} tabIndex={-1}>
              When do you want to listen?
            </h1>
            <p className="lede">
              Choose up to {maxHours} hours. Each one gets a fresh bulletin, ready on the hour. Extended editions go deeper.
            </p>
            {prefs.data && (
              <>
                <Presets prefs={prefs.data} run={run} onLimit={setLimitMsg} />
                {limitMsg && (
                  <p className="note note-warn" role="alert">
                    <Icon name="alert" size={18} /> <span>{limitMsg}</span>
                  </p>
                )}
                <HourGrid prefs={prefs.data} run={run} onLimit={setLimitMsg} />
              </>
            )}
          </>
        )}
      </main>

      <footer className="ob-actions">
        {err && step === 2 && (
          <p className="field-error" role="alert">
            <Icon name="alert" size={16} /> {err}
          </p>
        )}
        <div className="ob-buttons">
          {step > 0 && (
            <button type="button" className="btn btn-secondary" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button type="button" className="btn btn-primary btn-grow" onClick={() => setStep((s) => s + 1)}>
              {step === 0 && count === 0 ? 'Continue without sources' : 'Continue'}
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-grow" onClick={finish} disabled={making || count === 0}>
              {making ? <Spinner size={18} /> : <Icon name="sparkle" size={18} />} Make my first bulletin now
            </button>
          )}
        </div>
        {step === STEPS.length - 1 && (
          <button type="button" className="link-btn" onClick={() => navigate('/listen', { replace: true })}>
            {count === 0
              ? 'Add sources first — or finish and do it later'
              : next
                ? `I’ll wait for ${hourClock(next.hour)}`
                : 'Finish without a bulletin'}
          </button>
        )}
      </footer>
    </div>
  );
}
