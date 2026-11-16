import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { LIMITS } from '@shared/contracts';
import { api } from '../lib/api';
import { useAuth, useMe } from '../state/auth';
import { usePlayer } from '../state/player';
import { Icon } from '../components/Icon';
import { PageHeader, SaveIndicator, Spinner, useSaveStatus } from '../components/ui';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function Account() {
  const me = useMe();
  const { setMe, logout } = useAuth();
  const player = usePlayer();
  const navigate = useNavigate();
  const { status, run } = useSaveStatus();
  const [name, setName] = useState(me.displayName);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotated, setRotated] = useState(false);
  const ids = { name: useId(), feed: useId(), feedHelp: useId() };
  const plan = LIMITS.plans[me.plan];

  useEffect(() => setName(me.displayName), [me.displayName]);

  const saveName = () => {
    const v = name.trim();
    if (!v) {
      setName(me.displayName);
      return;
    }
    if (v === me.displayName) return;
    void run(async () => {
      const next = await api.updateMe({ displayName: v });
      setMe(next);
      return next;
    });
  };

  return (
    <div className="page page-account">
      <PageHeader title="Account" actions={<SaveIndicator status={status} />} />

      <section className="card">
        <div className="field">
          <label htmlFor={ids.name}>Display name</label>
          <input
            id={ids.name}
            value={name}
            maxLength={60}
            autoComplete="given-name"
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
          />
          <p className="field-hint">Your host may greet you by this name.</p>
        </div>
        <dl className="facts">
          <div>
            <dt>Email</dt>
            <dd>{me.email}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>
              <span className={`plan-badge plan-${me.plan}`}>{me.plan === 'free' ? 'Free' : 'Pro'}</span>
              <span className="plan-limits">
                {plan.maxSources} sources · {plan.maxActiveHours} hours a day · {plan.onDemandPerDay} on-demand a day
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <section className="section" aria-labelledby="feed-h">
        <div className="section-head">
          <h2 id="feed-h" className="section-title">
            Podcast feed
          </h2>
          <p className="section-sub" id={ids.feedHelp}>
            Paste this into Apple Podcasts, Overcast, Pocket Casts… to get bulletins there automatically.
          </p>
        </div>
        <div className="card">
          <label htmlFor={ids.feed} className="visually-hidden">
            Private podcast feed URL
          </label>
          <div className="copy-row">
            <input id={ids.feed} readOnly value={me.podcastFeedUrl} aria-describedby={ids.feedHelp} onFocus={(e) => e.currentTarget.select()} className="mono" />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={async () => {
                const ok = await copyText(me.podcastFeedUrl);
                setCopied(ok ? 'ok' : 'fail');
                window.setTimeout(() => setCopied('idle'), 2500);
              }}
            >
              <Icon name={copied === 'ok' ? 'check' : 'copy'} size={18} />
              {copied === 'ok' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="sr-live" role="status" aria-live="polite">
            {copied === 'ok' ? 'Feed link copied.' : copied === 'fail' ? 'Could not copy. Select the link and copy it manually.' : ''}
          </p>
          {copied === 'fail' && <p className="field-error">Couldn’t copy automatically — select the link and copy it.</p>}
          <p className="field-hint">
            <Icon name="alert" size={14} /> Anyone with this link can listen to your bulletins. Keep it private.
          </p>

          {rotated && (
            <p className="field-ok" role="status">
              <Icon name="check" size={16} /> New link created. Update it in your podcast app.
            </p>
          )}

          {!confirmRotate ? (
            <button type="button" className="btn btn-quiet" onClick={() => setConfirmRotate(true)}>
              <Icon name="retry" size={18} /> Get a new link
            </button>
          ) : (
            <div className="confirm" role="group" aria-label="Confirm new link">
              <p>
                <strong>Replace your feed link?</strong> The old link stops working right away, so any podcast app using it will stop
                updating until you add the new one.
              </p>
              <div className="confirm-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={rotating}
                  onClick={() => {
                    setRotating(true);
                    void run(async () => {
                      const next = await api.rotateFeedToken();
                      setMe(next);
                      setRotated(true);
                      return next;
                    }).finally(() => {
                      setRotating(false);
                      setConfirmRotate(false);
                    });
                  }}
                >
                  {rotating && <Spinner size={16} />} Replace link
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirmRotate(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={async () => {
            player.stop();
            await logout();
            navigate('/login', { replace: true });
          }}
        >
          Log out
        </button>
      </section>
    </div>
  );
}
