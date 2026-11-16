import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { NoSuchKey, type S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalBlobStore } from '../../src/providers/blobs/local.ts';
import { MemoryBlobStore } from '../../src/providers/blobs/memory.ts';
import { S3BlobStore } from '../../src/providers/blobs/s3.ts';

const read = async (s: Readable) => {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString();
};

describe('LocalBlobStore', () => {
  let dir: string;
  let store: LocalBlobStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blobs-'));
    store = new LocalBlobStore(join(dir, 'audio'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('puts, gets (whole and ranged) and deletes', async () => {
    await store.put('editions/u1/e1.mp3', Buffer.from('0123456789'), 'audio/mpeg');
    const whole = (await store.get('editions/u1/e1.mp3'))!;
    expect(whole.size).toBe(10);
    expect(await read(whole.stream)).toBe('0123456789');
    const part = (await store.get('editions/u1/e1.mp3', { start: 2, end: 5 }))!;
    expect(part.size).toBe(10);
    expect(await read(part.stream)).toBe('2345');
    expect(await read((await store.get('editions/u1/e1.mp3', { start: 8, end: 100 }))!.stream)).toBe('89');
    expect(await read((await store.get('editions/u1/e1.mp3', { start: 50, end: 60 }))!.stream)).toBe('');
    await store.delete('editions/u1/e1.mp3');
    expect(await store.get('editions/u1/e1.mp3')).toBeNull();
    await store.delete('editions/u1/e1.mp3'); // idempotent
    expect(await readdir(join(dir, 'audio', 'editions', 'u1'))).toEqual([]); // no temp files left
  });

  it.each(['../escape.mp3', 'a/../../b', '/etc/passwd', 'a//b', './a', 'a/./b', '', 'a\\b', 'a b', '..', 'x/%2e%2e/y'])(
    'rejects unsafe key %j',
    async (key) => {
      await expect(store.put(key, Buffer.from('x'), 'text/plain')).rejects.toThrow('Invalid blob key');
      await expect(store.get(key)).rejects.toThrow('Invalid blob key');
      await expect(store.delete(key)).rejects.toThrow('Invalid blob key');
    },
  );
});

describe('MemoryBlobStore', () => {
  it('supports ranges', async () => {
    const m = new MemoryBlobStore();
    await m.put('k', Buffer.from('abcdef'), 'text/plain');
    const r = (await m.get('k', { start: 1, end: 3 }))!;
    expect([r.size, await read(r.stream)]).toEqual([6, 'bcd']);
    expect(await m.get('missing')).toBeNull();
  });
});

describe('S3BlobStore', () => {
  it('maps put/get/range/delete onto S3 commands', async () => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    const client = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'GetObjectCommand') {
          if (cmd.input.Key === 'missing') throw new NoSuchKey({ message: 'nope', $metadata: {} });
          const { Readable } = await import('node:stream');
          return cmd.input.Range
            ? { Body: Readable.from(['23']), ContentRange: 'bytes 2-3/10', ContentLength: 2 }
            : { Body: Readable.from(['0123456789']), ContentLength: 10 };
        }
        return {};
      },
    } as unknown as S3Client;
    const s3 = new S3BlobStore({ bucket: 'b', client });
    await s3.put('editions/u/e.mp3', Buffer.from('x'), 'audio/mpeg');
    expect(sent[0]).toMatchObject({ name: 'PutObjectCommand', input: { Bucket: 'b', Key: 'editions/u/e.mp3', ContentType: 'audio/mpeg' } });
    const ranged = (await s3.get('editions/u/e.mp3', { start: 2, end: 3 }))!;
    expect(sent[1]!.input.Range).toBe('bytes=2-3');
    expect(ranged.size).toBe(10);
    expect((await s3.get('editions/u/e.mp3'))!.size).toBe(10);
    expect(await s3.get('missing')).toBeNull();
    await s3.delete('editions/u/e.mp3');
    expect(sent.at(-1)!.name).toBe('DeleteObjectCommand');
    await expect(s3.get('../x')).rejects.toThrow('Invalid blob key');
  });
});
