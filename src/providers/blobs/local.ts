import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { BlobStore } from '../../shared/deps.ts';
import { assertValidKey } from './key.ts';

export class LocalBlobStore implements BlobStore {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error(`Invalid blob key: ${JSON.stringify(key)}`);
    return path;
  }

  async put(key: string, data: Buffer, _mime?: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path); // readers never see a half-written file
  }

  async get(key: string, range?: { start: number; end: number }) {
    const path = this.pathFor(key);
    const size = await stat(path).then(
      (s) => s.size,
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      },
    );
    if (size === null) return null;
    if (!range) return { stream: createReadStream(path), size };
    const end = Math.min(range.end, size - 1);
    if (range.start > end) return { stream: Readable.from([]), size };
    return { stream: createReadStream(path, { start: range.start, end }), size };
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
