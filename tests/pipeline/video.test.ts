import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { editions, preferences } from '../../src/db/schema.ts';
import { generateEdition } from '../../src/pipeline/generate.ts';
import { runRetention } from '../../src/pipeline/retention.ts';
import { claimVideos, renderEditionVideo, videoTitle } from '../../src/pipeline/video.ts';
import { MockScriptWriter } from '../../src/providers/script/mock.ts';
import { hasArabicScript } from '../../src/shared/constants.ts';
import { MockVideoRenderer } from '../../src/providers/video/mock.ts';
import type { Config } from '../../src/shared/config.ts';
import type { VideoRenderer, VideoRequest } from '../../src/shared/deps.ts';
import { addArticle, createSource, createUser, hoursAgo, NOW, setup, subscribe, type TestEnv } from './helpers.ts';

const SLOT = new Date('2026-11-16T09:00:00Z');

let env: TestEnv;
afterEach(async () => {
  await env?.close();
  env = undefined as unknown as TestEnv;
});

async function readyToGenerate(opts: { config?: Partial<Config>; optIn?: boolean; video?: VideoRenderer; language?: string } = {}) {
  env = await setup(opts.video ? { video: opts.video } : {}, { VIDEO_ENABLED: true, ...opts.config });
  const user = await createUser(env.db, { displayName: 'Ada' });
  await env.db.update(preferences).set({ videoBulletins: opts.optIn ?? true }).where(eq(preferences.userId, user.id));
  const src = await createSource(env.db, { title: 'Daily Planet' });
  await subscribe(env.db, user.id, src.id);
  const arts = [
    await addArticle(env.db, src.id, { title: 'Harbour bridge reopens', publishedAt: hoursAgo(0.5), imageUrl: 'https://cdn.example/bridge.jpg' }),
    await addArticle(env.db, src.id, { title: 'City marathon record falls', publishedAt: hoursAgo(1) }),
  ];
  const [e] = await env.db
    .insert(editions)
    .values({ userId: user.id, slotAt: SLOT, localHour: 9, kind: 'standard', targetSeconds: 120, voiceId: 'mock-ben', tone: 'calm', language: opts.language ?? 'en' })
    .returning();
  return { user, arts, edition: e! };
}

const reload = async (id: string) => (await env.db.select().from(editions).where(eq(editions.id, id)))[0]!;

describe('video bulletins', () => {
  it('records a contiguous story timeline with the audio and queues the video', async () => {
    const { edition, arts } = await readyToGenerate();
    expect(await generateEdition(env.deps, edition.id)).toBe('ready');
    const done = await reload(edition.id);
    expect(done.videoStatus).toBe('pending');
    const segs = done.segments!;
    expect(segs.map((s) => s.articleId)).toEqual([null, arts[0]!.id, arts[1]!.id, null]);
    expect(segs[0]!.start).toBe(0);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start).toBe(segs[i - 1]!.end);
    expect(segs.at(-1)!.end).toBeCloseTo(done.durationSeconds!, 0);
  });

  it('renders the queued video from the stored audio and stories', async () => {
    const video = new MockVideoRenderer();
    const { edition, user, arts } = await readyToGenerate({ video });
    await generateEdition(env.deps, edition.id);
    expect(await claimVideos(env.deps, 5)).toEqual([edition.id]);
    expect((await reload(edition.id)).videoStatus).toBe('rendering');
    expect(await claimVideos(env.deps, 5)).toEqual([]);
    expect(await renderEditionVideo(env.deps, edition.id)).toBe('ready');

    const done = await reload(edition.id);
    expect(done).toMatchObject({ status: 'ready', videoStatus: 'ready', videoKey: `editions/${user.id}/${edition.id}.mp4`, videoError: null, videoClaimedAt: null });
    expect(env.blobs.objects.get(done.videoKey!)!.data.length).toBe(done.videoBytes);

    const req = video.requests[0]!;
    expect(req.audio.equals(env.blobs.objects.get(done.audioKey!)!.data)).toBe(true);
    expect(req.audioMime).toBe('audio/wav');
    expect(req.slotLabel).toBe('Monday 16 November, 9 AM');
    expect(req.stories).toEqual([
      { articleId: arts[0]!.id, title: 'Harbour bridge reopens', sourceTitle: 'Daily Planet', imageUrl: 'https://cdn.example/bridge.jpg' },
      { articleId: arts[1]!.id, title: 'City marathon record falls', sourceTitle: 'Daily Planet', imageUrl: null },
    ]);
    expect(req.segments.map((s) => s.story?.articleId ?? null)).toEqual([null, arts[0]!.id, arts[1]!.id, null]);
    expect(req.durationSeconds).toBe(done.segments!.at(-1)!.end);
  });

  it('a video failure leaves the audio edition ready and playable', async () => {
    const failing: VideoRenderer = { id: 'broken', render: async () => Promise.reject(new Error('ffmpeg exited 1: boom')) };
    const { edition } = await readyToGenerate({ video: failing });
    expect(await generateEdition(env.deps, edition.id)).toBe('ready');
    const audioBefore = await reload(edition.id);
    await claimVideos(env.deps, 1);
    expect(await renderEditionVideo(env.deps, edition.id)).toBe('failed');

    const after = await reload(edition.id);
    expect(after).toMatchObject({
      status: 'ready',
      error: null,
      audioKey: audioBefore.audioKey,
      audioBytes: audioBefore.audioBytes,
      videoStatus: 'failed',
      videoKey: null,
      videoError: 'ffmpeg exited 1: boom',
    });
    expect(env.blobs.objects.has(after.audioKey!)).toBe(true);
    expect(await claimVideos(env.deps, 1)).toEqual([]);
  });

  it('only renders for users who opted in, on servers with video enabled', async () => {
    const off = await readyToGenerate({ optIn: false });
    await generateEdition(env.deps, off.edition.id);
    expect((await reload(off.edition.id)).videoStatus).toBe('none');
    await env.close();

    const disabled = await readyToGenerate({ optIn: true, config: { VIDEO_ENABLED: false } });
    await generateEdition(env.deps, disabled.edition.id);
    expect((await reload(disabled.edition.id)).videoStatus).toBe('none');
    expect(await claimVideos(env.deps, 5)).toEqual([]);
  });

  it('gives up on renders whose worker died', async () => {
    const { edition } = await readyToGenerate();
    await generateEdition(env.deps, edition.id);
    await claimVideos(env.deps, 1);
    env.setNow(new Date(NOW.getTime() + 31 * 60_000));
    expect(await claimVideos(env.deps, 1)).toEqual([]);
    expect(await reload(edition.id)).toMatchObject({ videoStatus: 'failed', videoError: 'Video rendering did not finish', status: 'ready' });
  });

  it('deletes the rendered file if the edition was deleted mid-render (no orphaned blob)', async () => {
    let deleteNow: () => Promise<unknown> = async () => {};
    const video: VideoRenderer = {
      id: 'slow',
      render: async () => {
        await deleteNow();
        return { video: Buffer.from('mp4'), mime: 'video/mp4' };
      },
    };
    const { edition, user } = await readyToGenerate({ video });
    await generateEdition(env.deps, edition.id);
    await claimVideos(env.deps, 1);
    deleteNow = () => env.db.delete(editions).where(eq(editions.id, edition.id));
    expect(await renderEditionVideo(env.deps, edition.id)).toBe('missing');
    expect(env.blobs.objects.has(`editions/${user.id}/${edition.id}.mp4`)).toBe(false);
  });

  it('retention deletes the video blob with the audio', async () => {
    const { edition } = await readyToGenerate();
    await generateEdition(env.deps, edition.id);
    await claimVideos(env.deps, 1);
    await renderEditionVideo(env.deps, edition.id);
    const { audioKey, videoKey } = await reload(edition.id);
    expect(env.blobs.objects.has(videoKey!)).toBe(true);
    env.setNow(new Date(SLOT.getTime() + (env.deps.config.RETENTION_DAYS + 1) * 86_400_000));
    expect((await runRetention(env.deps)).editions).toBe(1);
    expect(env.blobs.objects.has(audioKey!)).toBe(false);
    expect(env.blobs.objects.has(videoKey!)).toBe(false);
  });

  describe('Urdu editions', () => {
    /** Every piece of text the renderer could put on screen. */
    const onScreenText = (req: VideoRequest) =>
      [req.title, req.slotLabel, ...req.stories.flatMap((st) => [st.title, st.sourceTitle]), ...req.segments.flatMap((sg) => (sg.story ? [sg.story.title, sg.story.sourceTitle] : []))];

    it('the render input is English only: English title, English slot, feed headlines', async () => {
      const video = new MockVideoRenderer();
      const { edition, arts } = await readyToGenerate({ video, language: 'ur' });
      expect(await generateEdition(env.deps, edition.id)).toBe('ready');
      const spoken = await reload(edition.id);
      expect(hasArabicScript(spoken.script!)).toBe(true);
      expect(hasArabicScript(spoken.title!)).toBe(true);

      await claimVideos(env.deps, 1);
      expect(await renderEditionVideo(env.deps, edition.id)).toBe('ready');
      const req = video.requests[0]!;
      expect(req.title).toBe("This hour's top stories");
      expect(req.slotLabel).toBe('Monday 16 November, 9 AM');
      expect(req.stories.map((st) => st.title)).toEqual(arts.map((a) => a.title));
      expect(req.segments.map((sg) => sg.story?.articleId ?? null)).toEqual([null, arts[0]!.id, arts[1]!.id, null]);
      for (const text of onScreenText(req)) expect(hasArabicScript(text), text).toBe(false);
    });

    it('falls back to a generic English card title when the writer gave no English title', async () => {
      const video = new MockVideoRenderer();
      const { edition } = await readyToGenerate({ video, language: 'ur' });
      const mock = new MockScriptWriter();
      env.deps.scriptWriter = { write: async (r) => ({ ...(await mock.write(r)), titleEn: undefined }) };
      await generateEdition(env.deps, edition.id);
      await claimVideos(env.deps, 1);
      await renderEditionVideo(env.deps, edition.id);
      expect(video.requests[0]!.title).toBe('Newscast · Monday 16 November, 9 AM');
      for (const text of onScreenText(video.requests[0]!)) expect(hasArabicScript(text)).toBe(false);
    });

    it('videoTitle never passes Urdu script through', () => {
      const slot = 'Monday 16 November, 6 PM';
      expect(videoTitle({ language: 'en', title: 'Bridge reopens', titleEn: null }, slot)).toBe('Bridge reopens');
      expect(videoTitle({ language: 'en', title: null, titleEn: null }, slot)).toBe('Your Newscast');
      expect(videoTitle({ language: 'ur', title: 'اہم خبریں', titleEn: 'Top stories' }, slot)).toBe('Top stories');
      expect(videoTitle({ language: 'ur', title: 'اہم خبریں', titleEn: null }, slot)).toBe(`Newscast · ${slot}`);
      expect(videoTitle({ language: 'ur', title: 'اہم خبریں', titleEn: 'Top اہم' }, slot)).toBe(`Newscast · ${slot}`);
      expect(videoTitle({ language: 'en', title: 'اہم خبریں', titleEn: null }, slot)).toBe('Your Newscast');
    });
  });
});
