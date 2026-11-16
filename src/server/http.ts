import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import type { User } from '../db/schema.ts';

export type AppEnv = { Variables: { user: User } };

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);

export const errorBody = (code: string, message: string) => ({ error: { code, message } });

/**
 * Parse a JSON body against a schema. Requiring application/json is half of the CSRF defence:
 * a cross-site <form> can only send urlencoded/multipart/text bodies without a CORS preflight.
 * `allowEmpty` lets bodies whose schema is all-defaults be omitted entirely.
 */
export async function readJson<S extends z.ZodType>(
  c: Context,
  schema: S,
  { allowEmpty = false } = {},
): Promise<z.output<S>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim() !== '' || !allowEmpty) {
    const type = c.req.header('content-type') ?? '';
    if (!/^application\/json\b/i.test(type)) {
      throw new HttpError(415, 'unsupported_media_type', 'Expected Content-Type: application/json');
    }
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, 'invalid_body', `${where}${issue?.message ?? 'Invalid request body'}`);
  }
  return parsed.data;
}

export const publicBase = (publicUrl: string) => publicUrl.replace(/\/+$/, '');

const Uuid = z.uuid();

/** Route ids are uuids; anything else can't exist, and would make Postgres throw on the cast. */
export function uuidParam(c: Context, name = 'id'): string {
  const value = c.req.param(name);
  if (!value || !Uuid.safeParse(value).success) throw notFound();
  return value;
}

export function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // app.request() in tests has no socket
  }
}
