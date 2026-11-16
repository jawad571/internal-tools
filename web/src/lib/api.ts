import type { z } from 'zod';
import type {
  AddSourceBody,
  EditionDetailDto,
  EditionDto,
  LoginBody,
  Me,
  MySourceDto,
  PreferencesDto,
  SignupBody,
  SourceDto,
  UpdateMeBody,
  UpdatePreferencesBody,
  VoiceDto,
  VoicePreviewBody,
} from '@shared/contracts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** The single seam between the app and the network. The dev mock swaps it out. */
export type Transport = (path: string, init: RequestInit) => Promise<Response>;
let transport: Transport = (path, init) => fetch(path, init);
export function setTransport(t: Transport) {
  transport = t;
}

let unauthorizedHandler: (() => void) | null = null;
/** Called on any 401 outside /api/auth/*, so the app can return to the login screen. */
export function onUnauthorized(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

function fallbackMessage(status: number): string {
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  if (status === 404) return 'That could not be found.';
  return 'That did not work. Please try again.';
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await transport(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach Newscast. Check your connection and try again.');
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = fallbackMessage(res.status);
    try {
      const data = (await res.json()) as { error?: { code?: string; message?: string } };
      if (data?.error?.message) message = data.error.message;
      if (data?.error?.code) code = data.error.code;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 && !path.startsWith('/api/auth/')) unauthorizedHandler?.();
    throw new ApiError(res.status, code, message);
  }
  return res;
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  return (await res.json()) as T;
}

export type SignupInput = z.input<typeof SignupBody>;
export type LoginInput = z.input<typeof LoginBody>;
export type UpdateMeInput = z.input<typeof UpdateMeBody>;
export type AddSourceInput = z.input<typeof AddSourceBody>;
export type PreviewInput = z.input<typeof VoicePreviewBody>;
export type EditionKind = EditionDto['kind'];

export const api = {
  signup: (b: SignupInput) => json<{ me: Me }>('POST', '/api/auth/signup', b).then((r) => r.me),
  login: (b: LoginInput) => json<{ me: Me }>('POST', '/api/auth/login', b).then((r) => r.me),
  logout: () => json<{ ok: true }>('POST', '/api/auth/logout'),
  me: () => json<{ me: Me }>('GET', '/api/me').then((r) => r.me),
  updateMe: (b: UpdateMeInput) => json<{ me: Me }>('PATCH', '/api/me', b).then((r) => r.me),
  rotateFeedToken: () => json<{ me: Me }>('POST', '/api/me/rotate-feed-token').then((r) => r.me),

  catalog: () => json<{ sources: SourceDto[] }>('GET', '/api/sources/catalog').then((r) => r.sources),
  mySources: () => json<{ sources: MySourceDto[] }>('GET', '/api/sources').then((r) => r.sources),
  addSource: (b: AddSourceInput) => json<{ source: MySourceDto }>('POST', '/api/sources', b).then((r) => r.source),
  updateSource: (id: string, weight: number) =>
    json<{ source: MySourceDto }>('PATCH', `/api/sources/${encodeURIComponent(id)}`, { weight }).then((r) => r.source),
  removeSource: (id: string) => json<{ ok: true }>('DELETE', `/api/sources/${encodeURIComponent(id)}`),

  voices: () => json<{ voices: VoiceDto[] }>('GET', '/api/voices').then((r) => r.voices),
  preferences: () => json<{ preferences: PreferencesDto }>('GET', '/api/preferences').then((r) => r.preferences),
  updatePreferences: (b: UpdatePreferencesBody) =>
    json<{ preferences: PreferencesDto }>('PUT', '/api/preferences', b).then((r) => r.preferences),
  preview: async (b: PreviewInput): Promise<Blob> => (await send('POST', '/api/preferences/preview', b)).blob(),

  editions: (opts: { limit?: number; before?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.before) q.set('before', opts.before);
    const qs = q.toString();
    return json<{ editions: EditionDto[] }>('GET', `/api/editions${qs ? `?${qs}` : ''}`).then((r) => r.editions);
  },
  edition: (id: string) =>
    json<{ edition: EditionDetailDto }>('GET', `/api/editions/${encodeURIComponent(id)}`).then((r) => r.edition),
  generate: (kind: EditionKind) =>
    json<{ edition: EditionDto }>('POST', '/api/editions/generate', { kind }).then((r) => r.edition),
  markListened: (id: string) => json<{ ok: true }>('POST', `/api/editions/${encodeURIComponent(id)}/listened`),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong.';
}
