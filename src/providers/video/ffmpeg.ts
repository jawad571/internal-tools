import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoRenderer, VideoRequest, VideoResult, VideoStory } from '../../shared/deps.ts';
import type { ImageSource } from '../feeds/fetch.ts';
import { errorMessage, mapLimit } from '../util.ts';

const require = createRequire(import.meta.url);

/** The ffmpeg binary shipped by ffmpeg-static (null if its download failed at install time). */
export function bundledFfmpegPath(): string | null {
  try {
    return (require('ffmpeg-static') as string | null) ?? null;
  } catch {
    return null;
  }
}

/** DejaVu Sans (Bitstream Vera licence: free to redistribute and embed). */
export function bundledFonts(): { regular: string; bold: string } {
  const dir = join(require.resolve('dejavu-fonts-ttf/package.json'), '..', 'ttf');
  return { regular: join(dir, 'DejaVuSans.ttf'), bold: join(dir, 'DejaVuSans-Bold.ttf') };
}

// ---------- layout ----------

const COLORS = {
  navy: '0x0b1d3a',
  navyDeep: '0x07142a',
  red: '0xd62828',
  white: '0xffffff',
  paper: '0xf5f7fa',
  muted: '0xb8c4d6',
  coral: '0xff7b7b',
};

/** Sizes are designed at 1080p and scaled to the output height. */
function layout(width: number, height: number) {
  const u = height / 1080;
  const px = (n: number) => Math.max(1, Math.round(n * u));
  const tickerH = px(64);
  const bandH = px(150);
  return {
    u,
    px,
    margin: px(60),
    tickerH,
    tickerY: height - tickerH,
    tickerFs: px(30),
    tickerLabelW: px(230),
    tickerSpeed: Math.round(width * 0.085), // px per second
    bandH,
    bandY: height - tickerH - bandH,
    headlineFs: px(46),
    sourceFs: px(28),
    bugFs: px(26),
    cardHeadlineFs: px(72),
    cardSourceFs: px(34),
    titleFs: px(80),
  };
}

/** Rough DejaVu Sans glyph width as a fraction of the font size, for wrapping. */
const CHAR_W = { regular: 0.56, bold: 0.62 };

/** Greedy word wrap to `maxChars` per line, at most `maxLines` lines, ellipsis on overflow. */
export function wrapText(text: string, maxChars: number, maxLines: number): string {
  const words = cleanText(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  let i = 0;
  for (; i < words.length; i++) {
    let w = words[i]!;
    if (w.length > maxChars) w = `${w.slice(0, maxChars - 1)}…`;
    const next = line ? `${line} ${w}` : w;
    if (next.length <= maxChars) {
      line = next;
      continue;
    }
    lines.push(line);
    line = w;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) {
    lines.push(line);
    line = '';
    i = words.length;
  }
  if (i < words.length) {
    const last = lines[maxLines - 1] ?? '';
    lines[maxLines - 1] = last.length + 1 > maxChars ? `${last.slice(0, maxChars - 1).trimEnd()}…` : `${last}…`;
  }
  return lines.join('\n');
}

/** Single line, no control characters (drawtext would render them as boxes). */
export const cleanText = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- plan ----------

export interface PlanSegment {
  story: VideoStory | null;
  start: number;
  end: number;
  /** Normalised image file in the work dir, or null for a title card. */
  image: string | null;
}

export interface PlanInput {
  title: string;
  slotLabel: string;
  durationSeconds: number;
  segments: PlanSegment[];
  stories: VideoStory[];
  audioFile: string;
}

export interface RenderPlan {
  /** Text files to write into the work dir before running (drawtext reads them with expansion off). */
  files: Record<string, string>;
  args: string[];
  /** The -filter_complex graph (also present in args). */
  graph: string;
}

export interface PlanOptions {
  width: number;
  height: number;
  fps: number;
  /** Font file names inside the work dir. */
  font: string;
  boldFont: string;
  output: string;
}

const between = (a: number, b: number) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`;

/**
 * Builds the ffmpeg invocation. Pure: every path is relative to the work dir (ffmpeg runs with it
 * as cwd), and all text goes through textfile= with expansion=none, so nothing user-controlled
 * is ever spliced into the filtergraph and no escaping is needed.
 */
export function buildRenderPlan(input: PlanInput, o: PlanOptions): RenderPlan {
  const { width: W, height: H, fps } = o;
  const L = layout(W, H);
  const files: Record<string, string> = {};
  const totalFrames = Math.max(1, Math.round(input.durationSeconds * fps));

  // Frame-exact segment boundaries, so concatenated clips never drift from the audio.
  type Seg = PlanSegment & { frames: number; t0: number; t1: number };
  const segs: Seg[] = [];
  input.segments.forEach((s, i) => {
    const f0 = Math.min(totalFrames, Math.round(s.start * fps));
    const f1 = i === input.segments.length - 1 ? totalFrames : Math.min(totalFrames, Math.round(s.end * fps));
    if (f1 > f0) segs.push({ ...s, frames: f1 - f0, t0: f0 / fps, t1: f1 / fps });
  });
  if (!segs.length) segs.push({ story: null, start: 0, end: input.durationSeconds, image: null, frames: totalFrames, t0: 0, t1: totalFrames / fps });

  const text = (o2: {
    file: string;
    content: string;
    bold?: boolean;
    size: number;
    color: string;
    x: string | number;
    y: string | number;
    enable?: string;
    box?: { color: string; border: number };
    lineSpacing?: number;
  }) => {
    files[o2.file] = o2.content;
    const parts = [
      `fontfile=${o2.bold ? o.boldFont : o.font}`,
      `textfile=${o2.file}`,
      'expansion=none',
      `fontsize=${o2.size}`,
      `fontcolor=${o2.color}`,
      `x='${o2.x}'`,
      `y='${o2.y}'`,
    ];
    if (o2.lineSpacing) parts.push(`line_spacing=${o2.lineSpacing}`);
    if (o2.box) parts.push('box=1', `boxcolor=${o2.box.color}`, `boxborderw=${o2.box.border}`);
    if (o2.enable) parts.push(`enable='${o2.enable}'`);
    return `drawtext=${parts.join(':')}`;
  };
  const box = (x: number | string, y: number | string, w: number | string, h: number | string, color: string, enable?: string) =>
    `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill${enable ? `:enable='${enable}'` : ''}`;
  const chars = (widthPx: number, fs: number, bold: boolean) => Math.max(8, Math.floor(widthPx / (fs * (bold ? CHAR_W.bold : CHAR_W.regular))));

  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  const cardBase = (frames: number) => `color=c=${COLORS.navy}:s=${W}x${H}:r=${fps}:d=${(frames / fps).toFixed(3)}`;

  segs.forEach((s, i) => {
    const out = `s${i}`;
    labels.push(`[${out}]`);
    if (s.image) {
      // Ken Burns: one still frame in, `frames` frames out. Images are pre-scaled to 2x so the
      // sub-pixel motion of a slow zoom/pan doesn't judder.
      const idx = inputs.length / 2;
      inputs.push('-i', s.image);
      const n = Math.max(1, s.frames - 1);
      const centreX = 'iw/2-(iw/zoom/2)';
      const centreY = 'ih/2-(ih/zoom/2)';
      const moves = [
        { z: `1+0.15*on/${n}`, x: centreX, y: centreY },
        { z: `1.15-0.15*on/${n}`, x: centreX, y: centreY },
        { z: '1.12', x: `(iw-iw/zoom)*on/${n}`, y: centreY },
        { z: '1.12', x: `(iw-iw/zoom)*(1-on/${n})`, y: centreY },
      ];
      const m = moves[i % moves.length]!;
      chains.push(`[${idx}:v]zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${s.frames}:s=${W}x${H}:fps=${fps},setsar=1,format=yuv420p[${out}]`);
      return;
    }
    const parts = [cardBase(s.frames), box(0, 0, L.px(14), H, COLORS.red)];
    const x = Math.round(W * 0.1);
    if (s.story) {
      // Title card for a story without a usable image: source over a big headline.
      parts.push(
        text({ file: `card_src_${i}.txt`, content: cleanText(s.story.sourceTitle).toUpperCase(), bold: true, size: L.cardSourceFs, color: COLORS.coral, x, y: Math.round(H * 0.2) }),
        text({
          file: `card_head_${i}.txt`,
          content: wrapText(s.story.title, chars(W * 0.8, L.cardHeadlineFs, true), 4),
          bold: true,
          size: L.cardHeadlineFs,
          color: COLORS.white,
          x,
          y: Math.round(H * 0.2) + L.cardSourceFs * 2,
          lineSpacing: L.px(14),
        }),
      );
    } else {
      // Intro / outro / link card: brand, edition title, slot.
      parts.push(
        text({ file: `card_brand_${i}.txt`, content: 'NEWSCAST', bold: true, size: L.cardSourceFs, color: COLORS.white, x, y: Math.round(H * 0.22), box: { color: COLORS.red, border: L.px(12) } }),
        text({
          file: `card_title_${i}.txt`,
          content: wrapText(input.title, chars(W * 0.8, L.titleFs, true), 3),
          bold: true,
          size: L.titleFs,
          color: COLORS.white,
          x,
          y: Math.round(H * 0.22) + L.cardSourceFs * 3,
          lineSpacing: L.px(16),
        }),
        text({ file: `card_slot_${i}.txt`, content: cleanText(input.slotLabel), size: L.cardSourceFs, color: COLORS.muted, x, y: Math.round(H * 0.72) }),
      );
    }
    chains.push(`${parts.join(',')},setsar=1,format=yuv420p[${out}]`);
  });

  chains.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[bg]`);

  // ---- graphics over the whole programme ----
  const storySegs = segs.map((s, i) => ({ s, i })).filter(({ s }) => s.story);
  const anyStory = storySegs.map(({ s }) => between(s.t0, s.t1)).join('+');
  const overlay: string[] = [];
  if (anyStory) {
    overlay.push(
      // Corner bug.
      text({ file: 'bug.txt', content: 'NEWSCAST', bold: true, size: L.bugFs, color: COLORS.white, x: L.margin, y: L.margin, box: { color: COLORS.red, border: L.px(10) }, enable: anyStory }),
      text({ file: 'bug_slot.txt', content: cleanText(input.slotLabel), size: L.bugFs, color: COLORS.white, x: `${L.margin}+${L.px(190)}`, y: L.margin, box: { color: `${COLORS.navy}@0.85`, border: L.px(10) }, enable: anyStory }),
      // Lower-third band.
      box(0, L.bandY, W, L.bandH, `${COLORS.paper}@0.95`, anyStory),
      box(0, L.bandY, L.px(14), L.bandH, COLORS.red, anyStory),
    );
    const headChars = chars(W - 2 * L.margin, L.headlineFs, true);
    for (const { s, i } of storySegs) {
      const en = between(s.t0, s.t1);
      overlay.push(
        text({
          file: `lt_src_${i}.txt`,
          content: cleanText(s.story!.sourceTitle).toUpperCase(),
          bold: true,
          size: L.sourceFs,
          color: COLORS.white,
          x: L.margin,
          y: L.bandY - L.sourceFs - L.px(14),
          box: { color: COLORS.red, border: L.px(10) },
          enable: en,
        }),
        text({
          file: `lt_head_${i}.txt`,
          content: wrapText(s.story!.title, headChars, 2),
          bold: true,
          size: L.headlineFs,
          color: COLORS.navy,
          x: L.margin,
          y: `${L.bandY}+(${L.bandH}-th)/2`,
          lineSpacing: L.px(10),
          enable: en,
        }),
      );
    }
  }

  // Ticker: during a story, the edition's *other* headlines; restarts from the right at each segment.
  overlay.push(box(0, L.tickerY, W, L.tickerH, COLORS.navyDeep));
  const sep = '   •   ';
  segs.forEach((s, i) => {
    const others = input.stories.filter((st) => st.articleId !== s.story?.articleId);
    if (!others.length) return;
    const content = others.map((st) => cleanText(st.title)).join(sep);
    const startX = L.tickerLabelW + L.px(20);
    overlay.push(
      text({
        file: `ticker_${i}.txt`,
        content,
        size: L.tickerFs,
        color: COLORS.white,
        // Scrolls right-to-left from the right edge, wrapping once the whole line has passed.
        x: `w-mod((t-${s.t0.toFixed(3)})*${L.tickerSpeed},w-${startX}+tw)`,
        y: `${L.tickerY}+(${L.tickerH}-th)/2`,
        enable: between(s.t0, s.t1),
      }),
    );
  });
  overlay.push(
    box(0, L.tickerY, L.tickerLabelW, L.tickerH, COLORS.red),
    text({ file: 'ticker_label.txt', content: 'HEADLINES', bold: true, size: L.tickerFs, color: COLORS.white, x: `(${L.tickerLabelW}-tw)/2`, y: `${L.tickerY}+(${L.tickerH}-th)/2` }),
  );
  chains.push(`[bg]${overlay.join(',')},format=yuv420p[v]`);

  const graph = chains.join(';\n');
  const audioIdx = inputs.length / 2;
  const pixels = W * H;
  const kbps = Math.max(300, Math.round((4000 * pixels) / (1920 * 1080)));
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-i',
    input.audioFile,
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    '-map',
    `${audioIdx}:a:0`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-maxrate',
    `${kbps}k`,
    '-bufsize',
    `${kbps * 2}k`,
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-g',
    String(fps * 2),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-movflags',
    '+faststart',
    '-t',
    (totalFrames / fps).toFixed(3),
    o.output,
  ];
  return { files, args, graph };
}

// ---------- process ----------

export class FfmpegError extends Error {}

/** Runs ffmpeg; rejects with the tail of stderr on failure or timeout. */
export function runFfmpeg(ffmpegPath: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { cwd: opts.cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-16_000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new FfmpegError(`could not start ffmpeg: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stderr);
      const tail = stderr.trim().split('\n').slice(-4).join(' | ');
      reject(new FfmpegError(signal ? `ffmpeg timed out (${signal})` : `ffmpeg exited ${code}: ${tail}`));
    });
  });
}

/** Simple FIFO semaphore: video encodes are CPU-bound, so a worker runs only a few at once. */
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * Default ffmpeg time limit: 2 min + 3x the programme, capped below the video queue's 30-minute
 * stale-claim window (pipeline/video.ts) so a live render is never declared dead while still running.
 */
export const defaultRenderTimeoutMs = (durationSeconds: number) => Math.min(120_000 + durationSeconds * 3000, 25 * 60_000);

const audioExt = (mime: string) => ({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/aac': 'aac' })[mime] ?? 'bin';

export interface FfmpegRendererOptions {
  ffmpegPath: string;
  images: ImageSource;
  fonts?: { regular: string; bold: string };
  width?: number;
  height?: number;
  fps?: number;
  concurrency?: number;
  /** Defaults to defaultRenderTimeoutMs(programme length). */
  timeoutMs?: number;
  /** Parent of the per-render work dirs (default: OS temp dir). */
  tmpDir?: string;
}

export class FfmpegVideoRenderer implements VideoRenderer {
  readonly id = 'ffmpeg';
  private readonly sem: Semaphore;
  private readonly width: number;
  private readonly height: number;
  private readonly fps: number;

  constructor(private readonly opts: FfmpegRendererOptions) {
    this.sem = new Semaphore(opts.concurrency ?? 1);
    // libx264 + yuv420p need even dimensions.
    this.width = Math.round((opts.width ?? 1920) / 2) * 2;
    this.height = Math.round((opts.height ?? 1080) / 2) * 2;
    this.fps = opts.fps ?? 30;
  }

  render(req: VideoRequest): Promise<VideoResult> {
    return this.sem.run(() => this.renderNow(req));
  }

  /**
   * Downloads and normalises one story image to a 2x-size cover-cropped JPEG. Any failure
   * (refused URL, not an image, undecodable, too small) returns null: that story gets a title card.
   */
  private async prepareImage(url: string, dir: string, n: number): Promise<string | null> {
    try {
      const img = await this.opts.images.fetchImage(url);
      const raw = `raw_${n}`;
      const out = `img_${n}.jpg`;
      await writeFile(join(dir, raw), img.data);
      const W2 = this.width * 2;
      const H2 = this.height * 2;
      const log = await runFfmpeg(
        this.opts.ffmpegPath,
        [
          '-nostdin', '-hide_banner', '-loglevel', 'info', '-y',
          // Refuse decompression bombs before decoding.
          '-max_pixels', '60000000',
          '-i', raw,
          '-vf', `scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},format=yuvj420p`,
          '-frames:v', '1', '-q:v', '3', out,
        ],
        { cwd: dir, timeoutMs: 30_000 },
      );
      const dims = log.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
      // Upscaled thumbnails look worse than a clean title card.
      if (dims && Number(dims[1]) < this.width / 5) return null;
      return out;
    } catch (e) {
      console.warn('[video] story image unusable, using a title card:', url.slice(0, 200), errorMessage(e));
      return null;
    }
  }

  private async renderNow(req: VideoRequest): Promise<VideoResult> {
    const dir = await mkdtemp(join(this.opts.tmpDir ?? tmpdir(), 'newscast-video-'));
    try {
      const fonts = this.opts.fonts ?? bundledFonts();
      await Promise.all([copyFile(fonts.regular, join(dir, 'font.ttf')), copyFile(fonts.bold, join(dir, 'bold.ttf'))]);
      const audioFile = `audio.${audioExt(req.audioMime)}`;
      await writeFile(join(dir, audioFile), req.audio);

      const withImages = [...new Map(req.stories.filter((s) => s.imageUrl).map((s) => [s.articleId, s])).values()];
      const prepared = await mapLimit(withImages, 4, (s, n) => this.prepareImage(s.imageUrl!, dir, n));
      const imageFor = new Map(withImages.map((s, n) => [s.articleId, prepared[n] ?? null]));

      const plan = buildRenderPlan(
        {
          title: req.title,
          slotLabel: req.slotLabel,
          durationSeconds: req.durationSeconds,
          segments: req.segments.map((s) => ({ ...s, image: s.story ? (imageFor.get(s.story.articleId) ?? null) : null })),
          stories: req.stories,
          audioFile,
        },
        { width: this.width, height: this.height, fps: this.fps, font: 'font.ttf', boldFont: 'bold.ttf', output: 'out.mp4' },
      );
      await Promise.all(Object.entries(plan.files).map(([name, content]) => writeFile(join(dir, name), content, 'utf8')));
      await runFfmpeg(this.opts.ffmpegPath, plan.args, {
        cwd: dir,
        timeoutMs: this.opts.timeoutMs ?? defaultRenderTimeoutMs(req.durationSeconds),
      });
      return { video: await readFile(join(dir, 'out.mp4')), mime: 'video/mp4' };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
