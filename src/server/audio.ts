import { Readable } from 'node:stream';
import type { Context } from 'hono';
import type { Edition } from '../db/schema.ts';
import type { Deps } from '../shared/deps.ts';
import { notFound } from './http.ts';

type ByteRange = { start: number; end: number };

/**
 * Resolves a `Range` header against the object size. Returns undefined to serve the whole object
 * (no header, malformed, or multi-range — RFC 9110 lets servers ignore those) and 'unsatisfiable'
 * for a well-formed range that falls outside the object.
 */
export function resolveRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  const [, a = '', b = ''] = m;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (b !== '' && Number(b) < start) return undefined; // invalid spec: ignore the header
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

/** Streams a ready edition's audio with full single-range support (Safari and podcast apps need it). */
export async function serveEditionAudio(c: Context, deps: Deps, edition: Edition): Promise<Response> {
  if (edition.status !== 'ready' || !edition.audioKey) throw notFound('Audio not available');
  const key = edition.audioKey;

  let size = edition.audioBytes;
  if (size == null) {
    const probe = await deps.blobs.get(key);
    if (!probe) throw notFound('Audio not available');
    probe.stream.destroy();
    size = probe.size;
  }

  const headers = new Headers({
    'Content-Type': edition.audioMime ?? 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400',
  });

  const range = resolveRange(c.req.header('range'), size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const status = range ? 206 : 200;
  const { start, end } = range ?? { start: 0, end: size - 1 };
  headers.set('Content-Length', String(size === 0 ? 0 : end - start + 1));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  if (c.req.method === 'HEAD') return new Response(null, { status, headers });

  const blob = await deps.blobs.get(key, range);
  if (!blob) throw notFound('Audio not available');
  return new Response(Readable.toWeb(blob.stream) as ReadableStream, { status, headers });
}
