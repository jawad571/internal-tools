import type { Deps } from '../shared/deps.ts';
import { claimEditions, generateEdition } from './generate.ts';
import { ingestDueSources } from './ingest.ts';
import { runRetention } from './retention.ts';
import { scheduleDueEditions } from './scheduler.ts';
import { claimVideos, renderEditionVideo } from './video.ts';

const INTERVALS = { ingest: 120_000, schedule: 30_000, generate: 5_000, video: 5_000, retention: 3_600_000 };

/** Runs `fn` now and then `ms` after each run finishes, so ticks never overlap. Errors are logged, not fatal. */
function loop(name: string, ms: number, fn: () => Promise<unknown>) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const tick = () => {
    running = fn()
      .then(
        () => {},
        (e) => console.error(`[worker:${name}] tick failed`, e),
      )
      .finally(() => {
        running = undefined;
        if (!stopped) timer = setTimeout(tick, ms);
      });
  };
  timer = setTimeout(tick, 0);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

export function startWorker(deps: Deps): { stop(): Promise<void> } {
  const inFlight = new Set<Promise<unknown>>();
  const videosInFlight = new Set<Promise<unknown>>();
  const concurrency = deps.config.WORKER_CONCURRENCY;

  const loops = [
    loop('ingest', INTERVALS.ingest, () => ingestDueSources(deps)),
    loop('schedule', INTERVALS.schedule, () => scheduleDueEditions(deps)),
    // Claims only as many editions as there are free slots; generation runs outside the tick.
    loop('generate', INTERVALS.generate, async () => {
      for (const id of await claimEditions(deps, concurrency - inFlight.size)) {
        const job = generateEdition(deps, id).catch((e) => console.error('[worker:generate]', id, e));
        inFlight.add(job);
        void job.finally(() => inFlight.delete(job));
      }
    }),
    loop('retention', INTERVALS.retention, () => runRetention(deps)),
  ];
  if (deps.config.VIDEO_ENABLED) {
    // Separate from generation so a slow encode never holds up the next hour's audio.
    loops.push(
      loop('video', INTERVALS.video, async () => {
        for (const id of await claimVideos(deps, deps.config.VIDEO_CONCURRENCY - videosInFlight.size)) {
          const job = renderEditionVideo(deps, id).catch((e) => console.error('[worker:video]', id, e));
          videosInFlight.add(job);
          void job.finally(() => videosInFlight.delete(job));
        }
      }),
    );
  }

  return {
    async stop() {
      await Promise.all(loops.map((l) => l.stop()));
      await Promise.all(inFlight);
      await Promise.all(videosInFlight);
    },
  };
}

/** One full pass, draining all claimable editions. For tests and scripts. */
export async function runOnce(deps: Deps) {
  const ingest = await ingestDueSources(deps);
  const scheduled = await scheduleDueEditions(deps);
  const outcomes: Record<string, number> = {};
  for (;;) {
    const ids = await claimEditions(deps, deps.config.WORKER_CONCURRENCY);
    if (!ids.length) break;
    for (const outcome of await Promise.all(ids.map((id) => generateEdition(deps, id)))) {
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
  }
  const videos: Record<string, number> = {};
  for (;;) {
    if (!deps.config.VIDEO_ENABLED) break;
    const ids = await claimVideos(deps, deps.config.VIDEO_CONCURRENCY);
    if (!ids.length) break;
    for (const outcome of await Promise.all(ids.map((id) => renderEditionVideo(deps, id)))) {
      videos[outcome] = (videos[outcome] ?? 0) + 1;
    }
  }
  return { ingest, scheduled, outcomes, videos };
}
