import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import type { BlobStore } from '../../shared/deps.ts';
import { assertValidKey } from './key.ts';

/** S3 or any S3-compatible store (R2, MinIO) via `endpoint`. */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;

  constructor(
    private readonly opts: { bucket: string; region?: string; endpoint?: string; client?: S3Client },
  ) {
    this.client =
      opts.client ??
      new S3Client({
        region: opts.region ?? 'auto',
        endpoint: opts.endpoint,
        // MinIO and most self-hosted endpoints don't do virtual-hosted bucket DNS.
        forcePathStyle: Boolean(opts.endpoint),
      });
  }

  async put(key: string, data: Buffer, mime: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: data, ContentType: mime }));
  }

  async get(key: string, range?: { start: number; end: number }) {
    assertValidKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.opts.bucket, Key: key, Range: range && `bytes=${range.start}-${range.end}` }),
      );
      // For ranged responses the total size is the part after the slash in Content-Range.
      const total = res.ContentRange ? Number(res.ContentRange.split('/')[1]) : res.ContentLength;
      return { stream: res.Body as Readable, size: total ?? 0 };
    } catch (e) {
      if (e instanceof NoSuchKey || e instanceof NotFound) return null;
      if (e instanceof S3ServiceException && e.name === 'InvalidRange') {
        const head = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
        return { stream: Readable.from([]), size: head.ContentLength ?? 0 };
      }
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }
}
