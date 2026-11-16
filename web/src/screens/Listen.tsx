import { useEffect } from 'react';
import { Link } from 'react-router';
import { hourClock, isInProgress, nextScheduledHour, STATUS_TEXT } from '../lib/format';
import { useMe } from '../state/auth';
import { useMySources, usePreferences } from '../state/data';
import { useEditions } from '../state/editions';
import { usePlayer } from '../state/player';
import { EditionList, GeneratePanel } from '../components/Editions';
import { Icon } from '../components/Icon';
import { HeroPlayer } from '../components/Player';
import { ErrorNote, Spinner } from '../components/ui';

function greeting(tz: string): string {
  let h = 12;
  try {
    h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  } catch {
    /* default */
  }
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function Listen() {
  const me = useMe();
  const { editions, error, reload } = useEditions();
  const player = usePlayer();
  const prefs = usePreferences();
  const sources = useMySources();

  const visible = editions?.filter((e) => e.status !== 'skipped') ?? null;
  const latestReady = visible?.find((e) => e.status === 'ready' && e.audioUrl) ?? null;
  const working = visible?.find(isInProgress) ?? null;
  const noSources = sources.data !== undefined && sources.data.length === 0;

  const { cue } = player;
  useEffect(() => {
    if (latestReady) cue(latestReady);
  }, [latestReady, cue]);

  const next = prefs.data ? nextScheduledHour(prefs.data.activeHours, prefs.data.paused, me.timezone) : null;
  const nextText = prefs.data?.paused
    ? 'Your schedule is paused.'
    : next
      ? `Next scheduled bulletin: ${next.tomorrow ? 'tomorrow at ' : ''}${hourClock(next.hour)}.`
      : 'No hours scheduled yet.';

  return (
    <div className="page page-listen">
      <header className="listen-head">
        <p className="kicker">{greeting(me.timezone)}, {me.displayName}</p>
        <h1 className="visually-hidden">Listen</h1>
        <p className="listen-next">
          <Icon name="schedule" size={18} />
          <span>{nextText}</span>
          <Link to="/schedule">Schedule</Link>
        </p>
      </header>

      {error && !editions && <ErrorNote error={error} onRetry={() => void reload()} />}

      {!editions && !error && (
        <div className="hero hero-skeleton" aria-busy="true" aria-label="Loading your bulletins">
          <Spinner size={28} label="Loading your bulletins" />
        </div>
      )}

      {editions && (player.edition || latestReady) && <HeroPlayer fallback={player.edition ?? latestReady!} />}

      {editions && !player.edition && !latestReady && (
        <section className="empty-hero">
          {noSources ? (
            <>
              <h2>Start by choosing your sources</h2>
              <p>Newscast builds each bulletin from the outlets you pick. Add four or five and your first one can be ready in minutes.</p>
              <Link to="/sources" className="btn btn-primary">
                <Icon name="sources" size={20} /> Choose sources
              </Link>
            </>
          ) : working ? (
            <>
              <div className="empty-icon">
                <Spinner size={30} />
              </div>
              <h2>Your bulletin is being made</h2>
              <p>
                {STATUS_TEXT[working.status]}… It usually takes a minute or two. You can leave this screen — it will be here when it’s
                ready.
              </p>
            </>
          ) : (
            <>
              <h2>{next && !prefs.data?.paused ? `Your first bulletin arrives at ${hourClock(next.hour)}` : 'Nothing to play yet'}</h2>
              <p>Or make one right now — it takes a minute or two.</p>
            </>
          )}
        </section>
      )}

      {editions && (
        <GeneratePanel
          compact={!!latestReady}
          disabledReason={noSources ? 'Add at least one source first.' : null}
        />
      )}

      {visible && visible.length > 0 && (
        <section className="recent" aria-labelledby="recent-h">
          <h2 id="recent-h" className="section-title">
            Recent bulletins
          </h2>
          <EditionList editions={visible} />
        </section>
      )}
    </div>
  );
}
