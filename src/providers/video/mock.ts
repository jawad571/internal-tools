import type { VideoRenderer, VideoRequest, VideoResult } from '../../shared/deps.ts';

/** Records requests and returns a placeholder body. For tests, and when VIDEO_ENABLED is off. */
export class MockVideoRenderer implements VideoRenderer {
  readonly id = 'mock';
  readonly requests: VideoRequest[] = [];

  async render(req: VideoRequest): Promise<VideoResult> {
    this.requests.push(req);
    // An ftyp box header, so the bytes at least sniff as MP4.
    const ftyp = Buffer.from([0, 0, 0, 0x18, ...Buffer.from('ftypisom'), 0, 0, 2, 0, ...Buffer.from('isomiso2')]);
    return { video: Buffer.concat([ftyp, Buffer.from(`mock video ${Math.round(req.durationSeconds)}s`)]), mime: 'video/mp4' };
  }
}
