import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildRenderPlan, bundledFfmpegPath, defaultRenderTimeoutMs, FfmpegVideoRenderer, wrapText, type PlanInput } from '../../src/providers/video/ffmpeg.ts';
import type { VideoStory } from '../../src/shared/deps.ts';

const story = (id: string, title: string, imageUrl: string | null = null): VideoStory => ({
  articleId: id,
  title,
  sourceTitle: `Source ${id}`,
  imageUrl,
});
const A = story('a', "Harbour bridge reopens: council says it's 'on budget' at 100%", 'https://cdn.example/a.jpg');
const B = story('b', 'Tram strike averted %{localtime} \\ [x];,');
const C = story('c', 'Library expansion approved');

const OPTS = { width: 640, height: 360, fps: 30, font: 'font.ttf', boldFont: 'bold.ttf', output: 'out.mp4' };
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  title: 'Bridge reopens',
  slotLabel: 'Monday 16 November, 9 AM',
  durationSeconds: 10,
  audioFile: 'audio.mp3',
  stories: [A, B, C],
  segments: [
    { story: null, start: 0, end: 1.01, image: null },
    { story: A, start: 1.01, end: 4.5, image: 'img_0.jpg' },
    { story: B, start: 4.5, end: 7.2, image: null },
    { story: C, start: 7.2, end: 7.21, image: null }, // under one frame: dropped
    { story: null, start: 7.21, end: 9.9, image: null },
  ],
  ...over,
});

describe('defaultRenderTimeoutMs', () => {
  it('scales with length but stays inside the 30-minute stale-render window', () => {
    expect(defaultRenderTimeoutMs(60)).toBe(300_000);
    // A 20-minute extended edition would otherwise get 62 minutes and be swept as dead mid-render.
    expect(defaultRenderTimeoutMs(20 * 60)).toBe(25 * 60_000);
  });
});

describe('wrapText', () => {
  it('wraps on words, caps lines with an ellipsis, and strips control characters', () => {
    expect(wrapText('one two three four five', 9, 3)).toBe('one two\nthree\nfour five');
    expect(wrapText('one two three four five six seven', 9, 2)).toBe('one two\nthree…');
    expect(wrapText('a\u0000b\nc\td', 20, 2)).toBe('a b c d');
    expect(wrapText('supercalifragilistic word', 8, 2)).toBe('superca…\nword');
    expect(wrapText('short', 20, 2)).toBe('short');
  });
});

describe('buildRenderPlan', () => {
  const plan = buildRenderPlan(input(), OPTS);
  const arg = (flag: string) => plan.args[plan.args.indexOf(flag) + 1];

  it('outputs H.264 + AAC MP4, faststart, 30 fps, frame-exact duration', () => {
    expect(arg('-c:v')).toBe('libx264');
    expect(arg('-c:a')).toBe('aac');
    expect(arg('-pix_fmt')).toBe('yuv420p');
    expect(arg('-movflags')).toBe('+faststart');
    expect(arg('-r')).toBe('30');
    expect(arg('-t')).toBe('10.000');
    expect(arg('-maxrate')).toMatch(/^\d+k$/);
    expect(plan.args.at(-1)).toBe('out.mp4');
  });

  it('adds one input per image segment, then the audio, and maps it', () => {
    const inputs = plan.args.flatMap((a, i) => (a === '-i' ? [plan.args[i + 1]] : []));
    expect(inputs).toEqual(['img_0.jpg', 'audio.mp3']);
    expect(plan.args).toContain('[v]');
    expect(plan.args[plan.args.indexOf('[v]') + 2]).toBe('1:a:0');
  });

  it('Ken Burns for image segments, title cards otherwise, concatenated in order', () => {
    const chains = plan.graph.split(';\n');
    // intro (31 frames: 0 → round(1.01*30)), A (30→135), B (135→216), C dropped, outro (216→300: extends to the end)
    expect(chains[0]).toMatch(/^color=c=0x0b1d3a:s=640x360:r=30:d=1\.000,/);
    expect(chains[1]).toMatch(/^\[0:v\]zoompan=z='1\.15-0\.15\*on\/104':.*:d=105:s=640x360:fps=30,/);
    expect(chains[2]).toMatch(/^color=.*:d=2\.700,/);
    expect(chains[2]).toContain('textfile=card_head_2.txt');
    expect(chains[3]).toMatch(/^color=.*:d=2\.800,/);
    expect(chains[4]).toBe('[s0][s1][s2][s3]concat=n=4:v=1:a=0[bg]');
    expect(plan.graph).not.toContain('card_head_3');
  });

  it('never puts headline text in the filtergraph: every drawtext reads a textfile with expansion off', () => {
    for (const t of [A.title, B.title, '%{', 'localtime', 'Source a']) expect(plan.graph).not.toContain(t);
    const drawtexts = plan.graph.match(/drawtext=[^,]*(?:'[^']*'[^,]*)*/g)!;
    expect(drawtexts.length).toBeGreaterThan(8);
    for (const d of drawtexts) {
      expect(d).toMatch(/textfile=[\w.]+\.txt:expansion=none/);
      expect(d).toMatch(/fontfile=(font|bold)\.ttf/);
    }
    expect(plan.files['lt_head_1.txt']).toBe("Harbour bridge reopens: council says it's 'on budget' at 100%");
    expect(plan.files['lt_src_2.txt']).toBe('SOURCE B');
    expect(plan.files['card_head_2.txt']!.replace(/\n/g, ' ')).toContain('%{localtime} \\ [x];,');
    expect(plan.files['card_title_0.txt']).toBe('Bridge reopens');
  });

  it('shows the lower third only during its story, on frame boundaries', () => {
    expect(plan.graph).toMatch(/textfile=lt_head_1\.txt:.*enable='between\(t,1\.000,4\.500\)'/);
    expect(plan.graph).toMatch(/textfile=lt_head_2\.txt:.*enable='between\(t,4\.500,7\.200\)'/);
    expect(plan.graph).toContain("enable='between(t,1.000,4.500)+between(t,4.500,7.200)'");
  });

  it('ticker shows the other headlines, restarting at each segment', () => {
    expect(plan.files['ticker_1.txt']).toBe(`${B.title}   •   ${C.title}`);
    expect(plan.files['ticker_2.txt']).toBe(`${A.title}   •   ${C.title}`);
    expect(plan.files['ticker_0.txt']).toBe([A, B, C].map((s) => s.title).join('   •   '));
    expect(plan.graph).toMatch(/textfile=ticker_2\.txt:.*x='w-mod\(\(t-4\.500\)\*\d+,w-\d+\+tw\)'/);
  });

  it('copes with no segments at all (one card for the whole programme)', () => {
    const p = buildRenderPlan(input({ segments: [], durationSeconds: 3 }), OPTS);
    expect(p.graph).toContain('[s0]concat=n=1');
    expect(p.graph).not.toContain('zoompan');
  });
});

// ---------- real ffmpeg ----------

const ffmpeg = bundledFfmpegPath();
const ffmpegWorks = !!ffmpeg && spawnSync(ffmpeg, ['-version']).status === 0;

describe.skipIf(!ffmpegWorks)('FfmpegVideoRenderer (real ffmpeg)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'newscast-video-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const make = (args: string[]) => execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: dir });

  it('renders a valid MP4 of the right length, falling back to cards for bad images', async () => {
    make(['-f', 'lavfi', '-i', 'testsrc2=s=400x300', '-frames:v', '1', 'pic.jpg']);
    make(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-ac', '1', '-ar', '8000', 'audio.wav']);
    const pic = readFileSync(join(dir, 'pic.jpg'));
    const fetched: string[] = [];
    const renderer = new FfmpegVideoRenderer({
      ffmpegPath: ffmpeg!,
      width: 320,
      height: 180,
      images: {
        fetchImage: async (url) => {
          fetched.push(url);
          if (url.includes('broken')) return { data: Buffer.from('not really a jpeg at all'), mime: 'image/jpeg' };
          if (url.includes('refused')) throw new Error('refused');
          return { data: pic, mime: 'image/jpeg' };
        },
      },
    });
    const good = story('g', 'Good image story', 'https://cdn.example/good.jpg');
    const broken = story('x', 'Broken image story', 'https://cdn.example/broken.jpg');
    const refused = story('r', 'Refused image story', 'https://cdn.example/refused.jpg');
    const res = await renderer.render({
      audio: readFileSync(join(dir, 'audio.wav')),
      audioMime: 'audio/wav',
      durationSeconds: 3,
      title: 'Test edition',
      slotLabel: 'Monday 16 November, 9 AM',
      stories: [good, broken, refused, C],
      segments: [
        { story: null, start: 0, end: 0.5 },
        { story: good, start: 0.5, end: 1.2 },
        { story: broken, start: 1.2, end: 1.8 },
        { story: refused, start: 1.8, end: 2.4 },
        { story: C, start: 2.4, end: 2.7 },
        { story: null, start: 2.7, end: 3 },
      ],
    });
    expect(res.mime).toBe('video/mp4');
    expect(fetched.sort()).toEqual([broken.imageUrl, good.imageUrl, refused.imageUrl].sort());
    expect(res.video.toString('latin1', 4, 8)).toBe('ftyp');
    // faststart: the index comes before the media data.
    expect(res.video.indexOf('moov')).toBeLessThan(res.video.indexOf('mdat'));

    const out = join(dir, 'out.mp4');
    writeFileSync(out, res.video);
    const info = spawnSync(ffmpeg!, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr;
    expect(info).toMatch(/Video: h264 .*320x180.*30 fps/);
    expect(info).toMatch(/Audio: aac/);
    const [, h, m, s] = info.match(/Duration: (\d+):(\d+):([\d.]+)/)!;
    expect(Number(h) * 3600 + Number(m) * 60 + Number(s)).toBeCloseTo(3, 1);
  });
});
