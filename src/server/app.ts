import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Deps } from '../shared/deps.ts';
import { authRoutes, meRoutes } from './account.ts';
import { requireUser } from './auth.ts';
import { editionRoutes } from './editions.ts';
import { feedRoutes } from './feed.ts';
import { errorBody, HttpError, publicBase, type AppEnv } from './http.ts';
import { preferenceRoutes } from './preferences.ts';
import { sourceRoutes } from './sources.ts';

const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Session cookies are SameSite=Lax, which already withholds them from cross-site POSTs; refusing
 * foreign Origins covers same-site-but-cross-origin pages and older browsers.
 */
const rejectCrossOrigin =
  (publicUrl: string): MiddlewareHandler =>
  async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !SAFE_METHODS.has(c.req.method)) {
      const allowed = new URL(publicBase(publicUrl)).origin;
      const host = c.req.header('host') ?? new URL(c.req.url).host;
      let ok = origin === allowed;
      try {
        ok ||= new URL(origin).host === host;
      } catch {
        // "null" or garbage: not ok
      }
      if (!ok) throw new HttpError(403, 'cross_origin', 'Cross-origin request refused');
    }
    await next();
  };

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(errorBody(err.code, err.message), err.status, err.headers);
    console.error('[web] unhandled error', err);
    return c.json(errorBody('internal', 'Something went wrong'), 500);
  });
  app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));

  app.get('/healthz', (c) => c.json({ ok: true as const }));

  app.use('/api/*', rejectCrossOrigin(deps.config.PUBLIC_URL));
  app.route('/api/auth', authRoutes(deps));
  app.route('/api/me', meRoutes(deps));
  app.route('/api/sources', sourceRoutes(deps));
  app.route('/api/voices', new Hono<AppEnv>().get('/', requireUser(deps), (c) => c.json({ voices: deps.tts.voices() })));
  app.route('/api/preferences', preferenceRoutes(deps));
  app.route('/api/editions', editionRoutes(deps));
  app.route('/feed', feedRoutes(deps));

  if (existsSync(WEB_DIST)) {
    const indexHtml = serveStatic({ root: WEB_DIST, path: 'index.html' });
    app.use('*', serveStatic({ root: WEB_DIST }));
    app.get('*', (c, next) => (/^\/(api|feed)(\/|$)/.test(c.req.path) ? next() : indexHtml(c, next)));
  }

  return app;
}
