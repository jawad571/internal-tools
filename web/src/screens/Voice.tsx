import { usePreferences } from '../state/data';
import { LanguagePicker, LengthSliders, TonePicker, ToneNote, VoicePicker } from '../components/VoiceTone';
import { ErrorNote, Loading, PageHeader, SaveIndicator, Switch, useSaveStatus } from '../components/ui';

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
          <section className="section" aria-labelledby="lang-h">
            <div className="section-head">
              <h2 id="lang-h" className="section-title">
                Bulletin language
              </h2>
              <p className="section-sub">The language your bulletins are spoken in. Video headlines stay in English.</p>
            </div>
            <LanguagePicker prefs={prefs.data} run={run} />
          </section>
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
          <section className="section" aria-labelledby="video-h">
            <div className="section-head">
              <h2 id="video-h" className="section-title">
                Video
              </h2>
              <p className="section-sub">Watch instead of listen: the same bulletin over story pictures and headlines.</p>
            </div>
            <div className="card">
              <Switch
                label="Video bulletins"
                description={
                  prefs.data.videoAvailable
                    ? 'Each bulletin also gets a video version, ready a few minutes after the audio.'
                    : 'Video isn’t switched on for this Newscast server yet.'
                }
                checked={prefs.data.videoBulletins && prefs.data.videoAvailable}
                disabled={!prefs.data.videoAvailable}
                onChange={(v) => void run(() => prefs.save({ videoBulletins: v }))}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
