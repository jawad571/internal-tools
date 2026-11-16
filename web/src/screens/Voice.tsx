import { usePreferences } from '../state/data';
import { LengthSliders, TonePicker, ToneNote, VoicePicker } from '../components/VoiceTone';
import { ErrorNote, Loading, PageHeader, SaveIndicator, useSaveStatus } from '../components/ui';

export function Voice() {
  const prefs = usePreferences();
  const { status, run } = useSaveStatus();
  return (
    <div className="page page-voice">
      <PageHeader title="Voice & tone" kicker="How your bulletins sound" actions={<SaveIndicator status={status} />} />
      {prefs.loading && <Loading />}
      {prefs.error && <ErrorNote error={prefs.error} onRetry={prefs.reload} />}
      {prefs.data && (
        <>
          <section className="section" aria-labelledby="voice-h">
            <div className="section-head">
              <h2 id="voice-h" className="section-title">
                Voice
              </h2>
              <p className="section-sub">Tap Preview to hear a sample in your chosen tone.</p>
            </div>
            <VoicePicker prefs={prefs.data} run={run} />
          </section>
          <section className="section" aria-labelledby="tone-h">
            <div className="section-head">
              <h2 id="tone-h" className="section-title">
                Tone
              </h2>
              <p className="section-sub">Shapes the wording of the script and, where the voice allows, its delivery.</p>
            </div>
            <TonePicker prefs={prefs.data} run={run} />
            <div className="card">
              <ToneNote prefs={prefs.data} run={run} />
            </div>
          </section>
          <section className="section" aria-labelledby="len-h">
            <div className="section-head">
              <h2 id="len-h" className="section-title">
                Length
              </h2>
              <p className="section-sub">Roughly how long each bulletin runs. Quiet news hours may come in shorter.</p>
            </div>
            <div className="card">
              <LengthSliders prefs={prefs.data} run={run} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
