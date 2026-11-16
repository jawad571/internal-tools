import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editionArticles, editions } from '../../src/db/schema.ts';
import { runOnce, startWorker } from '../../src/pipeline/worker.ts';
import { FeedFetcher } from '../../src/providers/feeds/fetch.ts';
import { createSource, createUser, fakeFetch, NOW, publicLookup, setup, subscribe, type TestEnv } from './helpers.ts';

const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toUTCString();
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Wire</title>
<item><guid>w1</guid><title>Parliament passes landmark climate bill</title><pubDate>${ago(20)}</pubDate><description>&lt;p&gt;MPs voted 320 to 210.&lt;/p&gt;</description></item>
<item><guid>w2</guid><title>Local team wins cup final on penalties</title><pubDate>${ago(40)}</pubDate><description>A tense evening at the stadium.</description></item>
<item><guid>w3</guid><title>Central bank holds rates steady</title><pubDate>${ago(70)}</pubDate><description>Inflation is easing, officials said.</description></item>
</channel></rss>`;

describe('runOnce', () => {
  let env: TestEnv;
  beforeEach(async () => {
    const origin = fakeFetch({ 'https://wire.example.com/rss': () => new Response(FEED) });
    env = await setup({ feeds: new FeedFetcher({ fetch: origin.fetch, lookup: publicLookup }) });
  });
  afterEach(() => env.close());

  it('ingests, schedules and generates a ready edition; a second pass repeats nothing', async () => {
    const user = await createUser(env.db);
    const src = await createSource(env.db, { url: 'https://wire.example.com/rss', title: 'The Wire' });
    await subscribe(env.db, user.id, src.id);

    const first = await runOnce(env.deps);
    expect(first).toEqual({ ingest: { fetched: 1, failed: 0, inserted: 3 }, scheduled: 1, outcomes: { ready: 1 }, videos: {} });
    const [e] = await env.db.select().from(editions);
    expect(e!.status).toBe('ready');
    expect(env.blobs.objects.size).toBe(1);
    expect((await env.db.select().from(editionArticles)).length).toBeGreaterThan(0);

    // Next hour: same feed, no new stories -> skipped rather than repeated.
    env.setNow(new Date(NOW.getTime() + 3600_000));
    const second = await runOnce(env.deps);
    expect(second.scheduled).toBe(1);
    expect(second.outcomes).toEqual({ skipped: 1 });
  });
});

describe('startWorker', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(() => env.close());

  it('runs loops, survives tick errors and stops cleanly', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let nowCalls = 0;
    env.deps.now = () => {
      nowCalls++;
      if (nowCalls === 1) throw new Error('boom'); // first tick of the first loop fails
      return NOW;
    };
    const worker = startWorker(env.deps);
    await vi.waitFor(() => expect(nowCalls).toBeGreaterThanOrEqual(4), { timeout: 5000 });
    await worker.stop();
    const after = nowCalls;
    await new Promise((r) => setTimeout(r, 50));
    expect(nowCalls).toBe(after);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('tick failed'), expect.any(Error));
    errors.mockRestore();
  });
});
