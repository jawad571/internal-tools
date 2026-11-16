import { beforeEach, describe, expect, it } from 'vitest';
import { insertReadyEdition, PUBLIC_URL, useCtx, type Ctx } from './helpers.ts';

const getCtx = useCtx();
let ctx: Ctx;
beforeEach(() => (ctx = getCtx()));

describe('podcast feed', () => {
  it('renders ready editions as an escaped RSS 2.0 + itunes feed', async () => {
    const { me, feedToken } = await ctx.signup();
    const e = await insertReadyEdition(ctx, me.id, { title: 'Markets & <Mayhem>' });
    await insertReadyEdition(ctx, me.id, { slotAt: new Date('2026-11-16T10:00:00Z'), status: 'pending', readyAt: null });

    const res = await ctx.call('GET', `/feed/${feedToken}.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
    const xml = await res.text();

    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">');
    expect(xml).toContain('<itunes:block>Yes</itunes:block>');
    expect(xml).toContain('<title>Markets &amp; &lt;Mayhem&gt;</title>');
    expect(xml).not.toContain('<Mayhem>');
    expect(xml).toContain(
      `<enclosure url="${PUBLIC_URL}/api/editions/${e.id}/audio?token=${feedToken}" length="20" type="audio/mpeg"/>`,
    );
    expect(xml).toContain(`<guid isPermaLink="false">${e.id}</guid>`);
    expect(xml).toContain('<pubDate>Mon, 16 Nov 2026 08:58:00 GMT</pubDate>');
    expect(xml).toContain('<itunes:duration>00:07:05</itunes:duration>');
    expect(xml.match(/<item>/g)).toHaveLength(1); // pending edition excluded
    expect(xml).toContain("<title>Ada&apos;s Newscast</title>");
  });

  it('the enclosure URL actually plays', async () => {
    const { me, feedToken } = await ctx.signup();
    await insertReadyEdition(ctx, me.id);
    const xml = await (await ctx.call('GET', `/feed/${feedToken}.xml`)).text();
    const enclosure = xml.match(/<enclosure url="([^"]+)"/)![1]!.replace(PUBLIC_URL, '').replace(/&amp;/g, '&');
    const res = await ctx.call('GET', enclosure, { headers: { range: 'bytes=0-1' } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('01');
  });

  it('caps at 30 items, newest first', async () => {
    const { me, feedToken } = await ctx.signup();
    for (let i = 0; i < 32; i++) {
      const at = new Date(Date.UTC(2026, 10, 1, i));
      await insertReadyEdition(ctx, me.id, { slotAt: at, readyAt: at, title: `Edition ${i}` });
    }
    const xml = await (await ctx.call('GET', `/feed/${feedToken}.xml`)).text();
    expect(xml.match(/<item>/g)).toHaveLength(30);
    expect(xml.indexOf('Edition 31')).toBeLessThan(xml.indexOf('Edition 30'));
    expect(xml).not.toContain('Edition 1<');
  });

  it('unknown token is 404', async () => {
    expect((await ctx.call('GET', '/feed/nope.xml')).status).toBe(404);
    const { feedToken } = await ctx.signup();
    expect((await ctx.call('GET', `/feed/${feedToken}`)).status).toBe(404);
  });
});
