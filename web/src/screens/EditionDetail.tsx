import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { EditionDetailDto } from '@shared/contracts';
import { api, ApiError, errorMessage } from '../lib/api';
import { clock, dateTime, dayHeading, editionMeta, editionTitle, hostOf, spokenTextProps, titleTextProps, isInProgress, STATUS_TEXT } from '../lib/format';
import { useMe } from '../state/auth';
import { useEditions } from '../state/editions';
import { usePlayer } from '../state/player';
import { Icon } from '../components/Icon';
import { EqBars } from '../components/Player';
import { ErrorNote, Loading, Segmented, Spinner } from '../components/ui';

const videoInProgress = (e: Pick<EditionDetailDto, 'videoStatus'>) => e.videoStatus === 'pending' || e.videoStatus === 'rendering';

/** Story art comes from third-party feeds: hide it quietly if it fails to load. */
function StoryThumb({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img className="story-thumb" src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  );
}

const STEPS = ['pending', 'scripting', 'synthesizing', 'ready'] as const;

function Progress({ status }: { status: EditionDetailDto['status'] }) {
  const at = STEPS.indexOf(status as (typeof STEPS)[number]);
  return (
    <ol className="steps" aria-label="Progress">
      {STEPS.slice(0, 3).map((s, i) => (
        <li key={s} className={i < at ? 'is-done' : i === at ? 'is-now' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="step-dot" aria-hidden="true">
            {i < at ? <Icon name="check" size={14} /> : i === at ? <Spinner size={14} /> : null}
          </span>
          {STATUS_TEXT[s]}
        </li>
      ))}
    </ol>
  );
}

export function EditionDetail() {
  const { id = '' } = useParams();
  const me = useMe();
  const p = usePlayer();
  const { upsert, generate, editions } = useEditions();
  const [ed, setEd] = useState<EditionDetailDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState<{ busy: boolean; msg?: string; ok?: boolean }>({ busy: false });
  const [mode, setMode] = useState<'listen' | 'watch'>('listen');
  const videoRef = useRef<HTMLVideoElement>(null);

  // Prefer the list's listened flag (it updates live while playing).
  const listed = editions?.find((e) => e.id === id);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const d = await api.edition(id);
        if (cancelled) return;
        setEd(d);
        setError(null);
        const { script: _s, error: _e, stories: _st, ...summary } = d;
        upsert(summary);
        if (isInProgress(d) || videoInProgress(d)) timer = window.setTimeout(load, isInProgress(d) ? 3000 : 5000);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    };
    setEd(null);
    setMode('listen');
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id, upsert]);

  useEffect(() => {
    if (ed) document.title = `${editionTitle(ed)} · Newscast`;
  }, [ed]);

  if (error)
    return (
      <div className="page">
        <BackLink />
        {error instanceof ApiError && error.status === 404 ? (
          <div className="empty-hero">
            <h2>That bulletin isn’t available</h2>
            <p>It may have expired. Head back to see your recent bulletins.</p>
          </div>
        ) : (
          <ErrorNote error={error} />
        )}
      </div>
    );
  if (!ed)
    return (
      <div className="page">
        <BackLink />
        <Loading label="Loading bulletin" />
      </div>
    );

  const current = p.edition?.id === ed.id;
  const playing = current && p.playing;
  const listened = listed?.listened ?? ed.listened;
  const paragraphs = (ed.script ?? '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const watching = mode === 'watch' && !!ed.videoUrl;
  const canJump = watching || (current && ed.status === 'ready');
  const jumpTo = (t: number) => {
    const v = videoRef.current;
    if (watching && v) {
      v.currentTime = t;
      void v.play().catch(() => {});
    } else if (current) {
      p.seekTo(t);
      if (!p.playing) p.play();
    }
  };

  return (
    <div className="page page-detail">
      <BackLink />
      <header className="detail-head">
        <p className="kicker">
          {dayHeading(ed.slotAt, me.timezone)} · {ed.trigger === 'on_demand' ? 'On demand' : 'Scheduled'}
        </p>
        <h1 className="detail-title" {...titleTextProps(ed)}>
          {editionTitle(ed)}
        </h1>
        <p className="detail-meta">
          {editionMeta(ed)}
          {ed.status === 'ready' && ` · ${listened ? 'Heard' : 'Not heard yet'}`}
        </p>

        {ed.status === 'ready' && ed.videoUrl && (
          <div className="detail-mode">
            <Segmented
              label="Listen or watch"
              size="sm"
              value={mode}
              onChange={(m) => {
                setMode(m);
                if (m === 'watch') p.pause();
                else videoRef.current?.pause();
              }}
              options={[
                { value: 'listen', label: 'Listen' },
                { value: 'watch', label: 'Watch' },
              ]}
            />
          </div>
        )}

        {watching ? (
          <video
            ref={videoRef}
            className="detail-video"
            src={ed.videoUrl!}
            controls
            playsInline
            preload="metadata"
            // One thing plays at a time: the app-wide audio player yields to the video.
            onPlay={() => p.pause()}
          />
        ) : (
          ed.status === 'ready' &&
          ed.audioUrl && (
            <button type="button" className="btn btn-primary btn-play" onClick={() => (current ? p.toggle() : p.play(ed))}>
              {playing ? <EqBars active /> : <Icon name="play" size={22} />}
              {playing ? 'Pause' : current && p.time > 1 ? 'Resume' : 'Play bulletin'}
            </button>
          )
        )}

        {ed.status === 'ready' && videoInProgress(ed) && (
          <p className="video-note muted" role="status">
            <Spinner size={14} /> Video version on its way. You can listen now.
          </p>
        )}
        {ed.status === 'ready' && ed.videoStatus === 'failed' && (
          <p className="video-note muted">The video version couldn’t be made this time. The audio is unaffected.</p>
        )}
      </header>

      {isInProgress(ed) && (
        <section className="card">
          <h2 className="card-title">Being made now</h2>
          <Progress status={ed.status} />
          <p className="muted">This page updates by itself.</p>
        </section>
      )}

      {ed.status === 'failed' && (
        <section className="card card-error">
          <h2 className="card-title">
            <Icon name="alert" size={20} /> This bulletin didn’t finish
          </h2>
          {ed.error && <p>{ed.error}</p>}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={retry.busy}
            onClick={() => {
              setRetry({ busy: true });
              generate(ed.kind)
                .then(() => setRetry({ busy: false, ok: true, msg: 'A new one is on its way. Find it on the Listen screen.' }))
                .catch((e: unknown) => setRetry({ busy: false, ok: false, msg: errorMessage(e) }));
            }}
          >
            {retry.busy ? <Spinner size={16} /> : <Icon name="retry" size={18} />} Generate a new one
          </button>
          {retry.msg && (
            <p className={retry.ok ? 'field-ok' : 'field-error'} role={retry.ok ? 'status' : 'alert'}>
              {retry.msg}
            </p>
          )}
        </section>
      )}

      {ed.stories.length > 0 && (
        <section className="stories" aria-labelledby="stories-h">
          <h2 id="stories-h" className="section-title">
            Stories covered <span className="count">{ed.stories.length}</span>
          </h2>
          <ol>
            {ed.stories.map((s, i) => (
              <li key={`${s.title}-${i}`} className={s.imageUrl ? 'has-thumb' : undefined}>
                <span className="story-n" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="story-title" dir="auto">
                      {s.title}
                      <Icon name="external" size={15} />
                      <span className="visually-hidden"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <span className="story-title" dir="auto">
                      {s.title}
                    </span>
                  )}
                  <span className="story-meta">
                    {s.sourceTitle} · {dateTime(s.publishedAt, me.timezone)}
                    {s.url && ` · ${hostOf(s.url)}`}
                  </span>
                  {canJump && s.startSeconds !== null && (
                    <button type="button" className="story-jump" onClick={() => jumpTo(s.startSeconds!)}>
                      <Icon name="play" size={12} /> {watching ? 'Watch' : 'Hear'} from {clock(s.startSeconds)}
                    </button>
                  )}
                </div>
                {s.imageUrl && <StoryThumb src={s.imageUrl} />}
              </li>
            ))}
          </ol>
        </section>
      )}

      {paragraphs.length > 0 && (
        <section className="transcript-wrap" aria-labelledby="transcript-h">
          <h2 id="transcript-h" className="section-title">
            Transcript
          </h2>
          <article className="transcript" {...spokenTextProps(ed)}>
            {paragraphs.map((t, i) => (
              <p key={i}>{t}</p>
            ))}
          </article>
        </section>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/listen" className="back-link">
      <Icon name="chevronLeft" size={20} /> Listen
    </Link>
  );
}
