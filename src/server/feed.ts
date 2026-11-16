import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { editions, preferences, users, type Edition, type User } from '../db/schema.ts';
import type { Deps } from '../shared/deps.ts';
import { notFound, publicBase } from './http.ts';

const FEED_ITEMS = 30;

export const xmlEscape = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);

const hms = (total: number) => {
  const s = Math.max(0, Math.round(total));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

function renderFeed(base: string, user: User, language: string, items: Edition[]): string {
  const x = xmlEscape;
  const channelTitle = `${user.displayName}'s Newscast`;
  const entries = items.map((e) => {
    const title = e.title ?? `Newscast, ${e.readyAt!.toUTCString()}`;
    const audioUrl = `${base}/api/editions/${e.id}/audio?token=${encodeURIComponent(user.feedToken)}`;
    return `    <item>
      <title>${x(title)}</title>
      <guid isPermaLink="false">${x(e.id)}</guid>
      <pubDate>${e.readyAt!.toUTCString()}</pubDate>
      <enclosure url="${x(audioUrl)}" length="${e.audioBytes ?? 0}" type="${x(e.audioMime ?? 'audio/mpeg')}"/>
      <itunes:duration>${hms(e.durationSeconds ?? 0)}</itunes:duration>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${x(channelTitle)}</title>
    <link>${x(base)}</link>
    <description>${x(`Personal hourly news bulletins for ${user.displayName}.`)}</description>
    <language>${x(language)}</language>
    <itunes:author>Newscast</itunes:author>
    <itunes:explicit>false</itunes:explicit>
    <itunes:block>Yes</itunes:block>
${entries.join('\n')}
  </channel>
</rss>
`;
}

export function feedRoutes(deps: Deps) {
  const app = new Hono();

  app.get('/:file', async (c) => {
    const file = c.req.param('file');
    if (!file.endsWith('.xml')) throw notFound();
    const token = file.slice(0, -'.xml'.length);

    const [row] = await deps.db
      .select({ user: users, language: preferences.language })
      .from(users)
      .leftJoin(preferences, eq(preferences.userId, users.id))
      .where(eq(users.feedToken, token));
    if (!row) throw notFound();

    const items = await deps.db
      .select()
      .from(editions)
      .where(and(eq(editions.userId, row.user.id), eq(editions.status, 'ready'), isNotNull(editions.readyAt)))
      .orderBy(desc(editions.readyAt))
      .limit(FEED_ITEMS);

    const xml = renderFeed(publicBase(deps.config.PUBLIC_URL), row.user, row.language ?? 'en', items);
    return c.body(xml, 200, {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
      'X-Robots-Tag': 'noindex',
    });
  });

  return app;
}
