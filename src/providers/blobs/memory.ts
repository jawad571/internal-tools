import { Readable } from 'node:stream';
import type { BlobStore } from '../../shared/deps.ts';
import { assertValidKey } from './key.ts';

/** In-process store for tests and ephemeral dev runs. */
export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { data: Buffer; mime: string }>();

  async put(key: string, data: Buffer, mime: string) {
    assertValidKey(key);
    this.objects.set(key, { data, mime });
  }

  async get(key: string, range?: { start: number; end: number }) {
    const obj = this.objects.get(key);
    if (!obj) return null;
    const data = range ? obj.data.subarray(range.start, range.end + 1) : obj.data;
    return { stream: Readable.from([data]), size: obj.data.length };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}
