import type { Db } from '../db/client.ts';
import type { Config } from '../shared/config.ts';
import type { BlobStore, Deps, ScriptWriter, TtsProvider, VideoRenderer } from '../shared/deps.ts';
import { LocalBlobStore } from './blobs/local.ts';
import { S3BlobStore } from './blobs/s3.ts';
import { FeedFetcher } from './feeds/fetch.ts';
import { AnthropicScriptWriter } from './script/anthropic.ts';
import { MockScriptWriter } from './script/mock.ts';
import { ElevenLabsTts } from './tts/elevenlabs.ts';
import { MockTts } from './tts/mock.ts';
import { OpenAiTts } from './tts/openai.ts';
import { bundledFfmpegPath, FfmpegVideoRenderer } from './video/ffmpeg.ts';
import { MockVideoRenderer } from './video/mock.ts';

function buildTts(config: Config): TtsProvider {
  switch (config.ttsProvider) {
    case 'openai':
      if (!config.OPENAI_API_KEY) throw new Error('TTS_PROVIDER=openai requires OPENAI_API_KEY');
      return new OpenAiTts({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_TTS_MODEL });
    case 'elevenlabs':
      if (!config.ELEVENLABS_API_KEY) throw new Error('TTS_PROVIDER=elevenlabs requires ELEVENLABS_API_KEY');
      return new ElevenLabsTts({ apiKey: config.ELEVENLABS_API_KEY, model: config.ELEVENLABS_MODEL });
    case 'mock':
      return new MockTts(config.WORDS_PER_MINUTE);
  }
}

function buildBlobs(config: Config): BlobStore {
  if (config.STORAGE === 'local') return new LocalBlobStore(config.STORAGE_DIR);
  if (!config.S3_BUCKET) throw new Error('STORAGE=s3 requires S3_BUCKET');
  return new S3BlobStore({ bucket: config.S3_BUCKET, region: config.S3_REGION, endpoint: config.S3_ENDPOINT });
}

function buildVideo(config: Config, feeds: FeedFetcher): VideoRenderer {
  if (!config.VIDEO_ENABLED) return new MockVideoRenderer();
  const ffmpegPath = config.FFMPEG_PATH ?? bundledFfmpegPath();
  if (!ffmpegPath) throw new Error('VIDEO_ENABLED requires ffmpeg: reinstall ffmpeg-static or set FFMPEG_PATH');
  return new FfmpegVideoRenderer({ ffmpegPath, images: feeds, concurrency: config.VIDEO_CONCURRENCY });
}

export function buildDeps(config: Config, db: Db): Deps {
  const feeds = new FeedFetcher();
  const scriptWriter: ScriptWriter = config.ANTHROPIC_API_KEY
    ? new AnthropicScriptWriter({ apiKey: config.ANTHROPIC_API_KEY, model: config.SCRIPT_MODEL })
    : new MockScriptWriter();
  return {
    config,
    db,
    scriptWriter,
    tts: buildTts(config),
    video: buildVideo(config, feeds),
    blobs: buildBlobs(config),
    feeds,
    now: () => new Date(),
  };
}
