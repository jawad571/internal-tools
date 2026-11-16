import { useState } from 'react';
import { Link } from 'react-router';
import { LIMITS } from '@shared/constants';
import type { EditionDto } from '@shared/contracts';
import { errorMessage, type EditionKind } from '../lib/api';
import { STATUS_TEXT, dayHeading, dayKey, hourLabel, isInProgress, kindLabel, minutesLabel, editionTitle } from '../lib/format';
import { useMe } from '../state/auth';
import { useEditions } from '../state/editions';
import { usePlayer } from '../state/player';
import { usePreferences } from '../state/data';
import { Icon } from './Icon';
import { EqBars } from './Player';
import { Segmented, Spinner } from './ui';

export function StatusLine({ e }: { e: EditionDto }) {
  if (isInProgress(e))
    return (
      <span className="status status-working">
        <Spinner size={14} /> {STATUS_TEXT[e.status]}…
      </span>
    );
  if (e.status === 'failed')
    return (
      <span className="status status-failed">
        <Icon name="alert" size={15} /> {STATUS_TEXT.failed}
      </span>
    );
  return null;
}

function rowMeta(e: EditionDto): string {
  const parts: string[] = [kindLabel(e.kind)];
  const m = minutesLabel(e.durationSeconds);
  if (m) parts.push(m);
  if (e.storyCount) parts.push(`${e.storyCount} ${e.storyCount === 1 ? 'story' : 'stories'}`);
  if (e.trigger === 'on_demand') parts.push('On demand');
  return parts.join(' · ');
}

function EditionRow({ e }: { e: EditionDto }) {
  const p = usePlayer();
  const { generate } = useEditions();
  const [retrying, setRetrying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const current = p.edition?.id === e.id;
  const playing = current && p.playing;
  const unheard = e.status === 'ready' && !e.listened;

  return (
    <li className={`ed-row${current ? ' is-current' : ''}${unheard ? ' is-new' : ''}`}>
      <span className="ed-hour" aria-hidden="true">
        {hourLabel(e.localHour)}
      </span>
      <Link to={`/listen/${e.id}`} className="ed-main">
        <span className="ed-title">
          {unheard && <span className="new-badge">New</span>}
          {e.status === 'ready' ? editionTitle(e) : `${hourLabel(e.localHour)} ${e.kind === 'extended' ? 'extended edition' : 'bulletin'}`}
        </span>
        <span className="ed-meta">
          <span className="visually-hidden">{hourLabel(e.localHour)}, </span>
          {e.status === 'ready' ? rowMeta(e) : <StatusLine e={e} />}
        </span>
        {err && <span className="ed-err">{err}</span>}
      </Link>
      <span className="ed-action">
        {e.status === 'ready' && (
          <button
            type="button"
            className={`round-btn${current ? ' is-current' : ''}`}
            onClick={() => (current ? p.toggle() : p.play(e))}
            aria-label={`${playing ? 'Pause' : 'Play'} ${editionTitle(e)}`}
          >
            {playing ? <EqBars active /> : <Icon name="play" size={22} />}
          </button>
        )}
        {e.status === 'failed' && (
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              setErr(null);
              generate(e.kind)
                .catch((x: unknown) => setErr(errorMessage(x)))
                .finally(() => setRetrying(false));
            }}
          >
            {retrying ? <Spinner size={14} /> : <Icon name="retry" size={16} />} Try again
          </button>
        )}
      </span>
    </li>
  );
}

export function EditionList({ editions }: { editions: EditionDto[] }) {
  const me = useMe();
  const { hasMore, loadMore, loadingMore } = useEditions();
  const groups: { key: string; heading: string; items: EditionDto[] }[] = [];
  for (const e of editions) {
    if (e.status === 'skipped') continue;
    const key = dayKey(e.slotAt, me.timezone);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, heading: dayHeading(e.slotAt, me.timezone), items: [] };
      groups.push(g);
    }
    g.items.push(e);
  }
  return (
    <div className="ed-list">
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`day-${g.key}`}>
          <h3 className="day" id={`day-${g.key}`}>
            {g.heading}
            <span className="day-count">
              {g.items.filter((e) => e.status === 'ready' && !e.listened).length > 0 &&
                `${g.items.filter((e) => e.status === 'ready' && !e.listened).length} new`}
            </span>
          </h3>
          <ul>
            {g.items.map((e) => (
              <EditionRow key={e.id} e={e} />
            ))}
          </ul>
        </section>
      ))}
      {hasMore && (
        <button type="button" className="btn btn-quiet btn-block" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore && <Spinner size={16} />} Show older bulletins
        </button>
      )}
    </div>
  );
}

export function GeneratePanel({ disabledReason, compact }: { disabledReason?: string | null; compact?: boolean }) {
  const { generate } = useEditions();
  const prefs = usePreferences();
  const me = useMe();
  const [kind, setKind] = useState<EditionKind>('standard');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const std = prefs.data?.standardMinutes ?? LIMITS.standardMinutes.default;
  const ext = prefs.data?.extendedMinutes ?? LIMITS.extendedMinutes.default;
  const perDay = LIMITS.plans[me.plan].onDemandPerDay;
  return (
    <section className={`generate${compact ? ' is-compact' : ''}`} aria-labelledby="gen-h">
      <div className="generate-head">
        <h2 id="gen-h">Can’t wait for the hour?</h2>
        <p>Make a fresh bulletin now. Your plan includes {perDay} a day.</p>
      </div>
      <Segmented
        label="Bulletin length"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'standard', label: `Standard · ${std} min` },
          { value: 'extended', label: `Extended · ${ext} min` },
        ]}
      />
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={busy || !!disabledReason}
        onClick={() => {
          setBusy(true);
          setMsg(null);
          generate(kind)
            .then(() => setMsg({ ok: true, text: 'On its way — usually ready in a minute or two. It’ll appear below.' }))
            .catch((e: unknown) => setMsg({ ok: false, text: errorMessage(e) }))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <Spinner size={18} /> : <Icon name="sparkle" size={18} />} Generate now
      </button>
      {disabledReason && <p className="field-hint">{disabledReason}</p>}
      {msg && (
        <p className={msg.ok ? 'field-ok' : 'field-error'} role={msg.ok ? 'status' : 'alert'}>
          <Icon name={msg.ok ? 'check' : 'alert'} size={16} /> {msg.text}
        </p>
      )}
    </section>
  );
}
