export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Map with at most `limit` calls in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
  return out;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const isTransient = (e: unknown) =>
  e instanceof HttpError ? e.status === 429 || e.status >= 500 : e instanceof TypeError; // fetch network failures are TypeErrors

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
}

/** Retries 429/5xx/network errors with exponential backoff + jitter, honouring Retry-After (capped). */
export async function withRetry<T>(fn: () => Promise<T>, { attempts = 4, baseMs = 500 }: RetryOptions = {}): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isTransient(e)) throw e;
      const backoff = baseMs * 2 ** (i - 1) * (1 + Math.random() * 0.25);
      const hinted = e instanceof HttpError ? e.retryAfterMs : undefined;
      await sleep(Math.min(hinted ?? backoff, 20_000));
    }
  }
}

/** Throws an HttpError (with a trimmed body excerpt) for a non-2xx response. */
export async function assertOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  const body = (await res.text().catch(() => '')).slice(0, 300);
  const ra = Number(res.headers.get('retry-after'));
  throw new HttpError(`${what} failed: HTTP ${res.status}${body ? ` — ${body}` : ''}`, res.status, ra > 0 ? ra * 1000 : undefined);
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
