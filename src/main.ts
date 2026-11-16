import { serve } from '@hono/node-server';
import { openDb } from './db/client.ts';
import { startWorker } from './pipeline/worker.ts';
import { buildDeps } from './providers/index.ts';
import { createApp } from './server/app.ts';
import { seedCatalog } from './server/catalog.ts';
import { loadConfig } from './shared/config.ts';

const config = loadConfig();
const { db, close } = await openDb(config.DATABASE_URL);
const deps = buildDeps(config, db);
await seedCatalog(db);

const stops: Array<() => Promise<void> | void> = [];

if (config.ROLE !== 'worker') {
  const server = serve({ fetch: createApp(deps).fetch, port: config.PORT });
  stops.push(() => void server.close());
  console.log(`[web] listening on :${config.PORT}`);
}
if (config.ROLE !== 'web') {
  const worker = startWorker(deps);
  stops.push(() => worker.stop());
  console.log(`[worker] started (tts=${deps.tts.id}, script=${config.ANTHROPIC_API_KEY ? config.SCRIPT_MODEL : 'mock'})`);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    for (const stop of stops) await stop();
    await close();
    process.exit(0);
  });
}
