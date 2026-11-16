import { useState } from 'react';
import { usePreferences } from '../state/data';
import { HourGrid, Presets, TimezonePicker, useMaxHours } from '../components/Schedule';
import { Icon } from '../components/Icon';
import { ErrorNote, Loading, PageHeader, SaveIndicator, Switch, useSaveStatus } from '../components/ui';

export function Schedule() {
  const prefs = usePreferences();
  const { status, run } = useSaveStatus();
  const [limitMsg, setLimitMsg] = useState<string | null>(null);
  const max = useMaxHours();
  const p = prefs.data;
  return (
    <div className="page page-schedule">
      <PageHeader title="Schedule" kicker="When bulletins arrive" actions={<SaveIndicator status={status} />} />
      {prefs.loading && <Loading />}
      {prefs.error && <ErrorNote error={prefs.error} onRetry={prefs.reload} />}
      {p && (
        <>
          <div className="card card-flush">
            <Switch
              checked={p.paused}
              onChange={(v) => void run(() => prefs.save({ paused: v }))}
              label="Pause all bulletins"
              description={p.paused ? 'Nothing will be made on schedule. Generate now still works.' : 'Bulletins are made for the hours below.'}
            />
          </div>

          <section className="section" aria-labelledby="hours-h">
            <div className="section-head section-head-row">
              <div>
                <h2 id="hours-h" className="section-title">
                  Hours
                </h2>
                <p className="section-sub">Tap an hour to cycle Off → Standard → Extended.</p>
              </div>
              <p className={`hours-count${p.activeHours.length >= max ? ' is-full' : ''}`}>
                <strong>
                  {p.activeHours.length}/{max}
                </strong>{' '}
                hours
              </p>
            </div>

            <Presets prefs={p} run={run} onLimit={setLimitMsg} />

            {limitMsg && (
              <p className="note note-warn" role="alert">
                <Icon name="alert" size={18} /> <span>{limitMsg}</span>
              </p>
            )}

            <HourGrid prefs={p} run={run} onLimit={setLimitMsg} />
          </section>

          <section className="section" aria-labelledby="tz-h">
            <div className="section-head">
              <h2 id="tz-h" className="section-title">
                Time zone
              </h2>
              <p className="section-sub">Hours above are in this time zone. Change it when you travel.</p>
            </div>
            <TimezonePicker run={run} />
          </section>
        </>
      )}
    </div>
  );
}
