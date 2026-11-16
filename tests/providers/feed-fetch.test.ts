import { describe, expect, it } from 'vitest';
import { FeedFetcher, isBlockedAddress, type LookupFn } from '../../src/providers/feeds/fetch.ts';
import { FeedProbeError } from '../../src/shared/deps.ts';
import { fakeFetch, publicLookup } from '../pipeline/helpers.ts';

const RSS = `<rss version="2.0"><channel><title>Good Feed</title><link>https://good.example.com/</link>
<item><title>Hello</title><guid>1</guid></item></channel></rss>`;

const lookupTable =
  (table: Record<string, string>): LookupFn =>
  async (host) => {
    const address = table[host];
    if (!address) throw new Error('ENOTFOUND');
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  };

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
    '64:ff9b::a00:1',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('FeedFetcher SSRF protection', () => {
  const origin = fakeFetch({ 'https://good.example.com/feed': () => new Response(RSS) });

  it.each([
    'http://127.0.0.1/feed',
    'http://10.0.0.5/feed',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/feed',
    'http://[::ffff:127.0.0.1]/feed',
  ])('refuses %s without making a request', async (url) => {
    const f = fakeFetch({});
    const fetcher = new FeedFetcher({ fetch: f.fetch, lookup: publicLookup });
    await expect(fetcher.probe(url)).rejects.toThrow(FeedProbeError);
    expect(f.calls).toHaveLength(0);
  });

  it('refuses hostnames that resolve to private addresses', async () => {
    const fetcher = new FeedFetcher({ fetch: origin.fetch, lookup: lookupTable({ 'intranet.example.com': '10.0.0.7' }) });
    await expect(fetcher.probe('https://intranet.example.com/feed')).rejects.toThrow('not publicly reachable');
  });

  it('refuses non-http schemes', async () => {
    const fetcher = new FeedFetcher({ fetch: origin.fetch, lookup: publicLookup });
    for (const url of ['file:///etc/passwd', 'ftp://example.com/feed', 'gopher://example.com/', 'javascript:alert(1)']) {
      await expect(fetcher.probe(url)).rejects.toThrow('Only http and https');
    }
  });

  it('re-checks every redirect hop and refuses a public host that redirects to a private one', async () => {
    const f = fakeFetch({
      'https://public.example.com/feed': () => new Response(null, { status: 302, headers: { location: 'http://internal.example.com/admin' } }),
    });
    const fetcher = new FeedFetcher({
      fetch: f.fetch,
      lookup: lookupTable({ 'public.example.com': '93.184.216.34', 'internal.example.com': '192.168.0.10' }),
    });
    await expect(fetcher.probe('https://public.example.com/feed')).rejects.toThrow('not publicly reachable');
    expect(f.calls.map((c) => c.url)).toEqual(['https://public.example.com/feed']);
  });

  it('refuses a redirect to a literal metadata IP', async () => {
    const f = fakeFetch({
      'https://public.example.com/feed': () => new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/' } }),
    });
    const fetcher = new FeedFetcher({ fetch: f.fetch, lookup: publicLookup });
    await expect(fetcher.probe('https://public.example.com/feed')).rejects.toThrow(FeedProbeError);
  });

  it('follows safe redirects (relative too) and reports the final URL', async () => {
    const f = fakeFetch({
      'http://a.example.com/rss': () => new Response(null, { status: 301, headers: { location: 'https://b.example.com/x' } }),
      'https://b.example.com/x': () => new Response(null, { status: 307, headers: { location: '/feed.xml#frag' } }),
      'https://b.example.com/feed.xml': () => new Response(RSS),
    });
    const fetcher = new FeedFetcher({ fetch: f.fetch, lookup: publicLookup });
    await expect(fetcher.probe('http://a.example.com/rss')).resolves.toEqual({
      url: 'https://b.example.com/feed.xml',
      title: 'Good Feed',
      siteUrl: 'https://good.example.com/',
    });
  });

  it('gives up after 5 redirects', async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 10; i++) routes[`https://loop.example.com/${i}`] = () => new Response(null, { status: 302, headers: { location: `/${i + 1}` } });
    const fetcher = new FeedFetcher({ fetch: fakeFetch(routes).fetch, lookup: publicLookup });
    await expect(fetcher.probe('https://loop.example.com/0')).rejects.toThrow('Too many redirects');
  });
});

describe('FeedFetcher limits and HTTP behaviour', () => {
  it('enforces the body cap while streaming, even without content-length', async () => {
    let pulled = 0;
    const f = fakeFetch({
      'https://big.example.com/feed': () =>
        new Response(
          new ReadableStream({
            pull(c) {
              pulled++;
              c.enqueue(new Uint8Array(64 * 1024));
              if (pulled > 1000) c.close();
            },
          }),
        ),
    });
    const fetcher = new FeedFetcher({ fetch: f.fetch, lookup: publicLookup, maxBytes: 256 * 1024 });
    await expect(fetcher.fetchFeed('https://big.example.com/feed')).rejects.toThrow('too large');
    expect(pulled).toBeLessThan(10);
  });

  it('rejects early on an oversized content-length', async () => {
    const f = fakeFetch({ 'https://big.example.com/feed': () => new Response('x', { headers: { 'content-length': String(10 * 1024 * 1024) } }) });
    const fetcher = new FeedFetcher({ fetch: f.fetch, lookup: publicLookup });
    await expect(fetcher.fetchFeed('https://big.example.com/feed')).rejects.toThrow('too large');
  });

  it('times out slow servers', async () => {
    const slow = (async (_u: string | URL | Request, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const fetcher = new FeedFetcher({ fetch: slow, lookup: publicLookup, timeoutMs: 50 });
    await expect(fetcher.fetchFeed('https://slow.example.com/feed')).rejects.toThrow('too long');
  });

  it('sends a User-Agent and conditional headers, and handles 304', async () => {
    const f = fakeFetch({ 'https://good.example.com/feed': () => new Response(null, { status: 304 }) });
    const fetcher = new FeedFetcher({ fetch: f.fetch, lookup: publicLookup });
    const res = await fetcher.fetchFeed('https://good.example.com/feed', { etag: '"abc"', lastModified: 'Mon, 16 Nov 2026 07:00:00 GMT' });
    expect(res.notModified).toBe(true);
    const h = f.calls[0]!.headers;
    expect(h.get('user-agent')).toMatch(/Newscast/);
    expect(h.get('if-none-match')).toBe('"abc"');
    expect(h.get('if-modified-since')).toBe('Mon, 16 Nov 2026 07:00:00 GMT');
  });

  it('returns validators and reports HTTP errors and non-feeds clearly', async () => {
    const f = fakeFetch({
      'https://good.example.com/feed': () => new Response(RSS, { headers: { etag: '"v2"', 'last-modified': 'Mon, 16 Nov 2026 08:00:00 GMT' } }),
      'https://good.example.com/gone': () => new Response('nope', { status: 410 }),
      'https://good.example.com/page': () => new Response('<html><body>hello</body></html>'),
    });
    const fetcher = new FeedFetcher({ fetch: f.fetch, lookup: publicLookup });
    const res = await fetcher.fetchFeed('https://good.example.com/feed');
    expect(res).toMatchObject({ notModified: false, etag: '"v2"', lastModified: 'Mon, 16 Nov 2026 08:00:00 GMT' });
    expect(res.feed?.items).toHaveLength(1);
    await expect(fetcher.probe('https://good.example.com/gone')).rejects.toThrow('HTTP 410');
    await expect(fetcher.probe('https://good.example.com/page')).rejects.toThrow("doesn't look like an RSS or Atom feed");
  });
});
