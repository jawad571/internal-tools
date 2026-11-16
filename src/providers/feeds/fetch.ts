import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { FeedProbeError, type FeedProber, type ProbedFeed } from '../../shared/deps.ts';
import { parseFeed, type ParsedFeed } from './parse.ts';

export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface FetchedFeed {
  /** Final URL after redirects. */
  url: string;
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
  feed: ParsedFeed | null;
}

export interface FetchFeedOptions {
  etag?: string | null;
  lastModified?: string | null;
  /** Fetch time; undated items get this date. */
  now?: Date;
}

/** What the ingest loop needs beyond probing. */
export interface FeedReader extends FeedProber {
  fetchFeed(url: string, opts?: FetchFeedOptions): Promise<FetchedFeed>;
}

export const USER_AGENT = 'NewscastFeedFetcher/0.1 (+personal audio news bulletins; fetches each feed at most every few minutes)';
const MAX_REDIRECTS = 5;

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** True for loopback, private, link-local, CGNAT, multicast, reserved and IPv4-mapped/translated forms of those. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family !== 6) return true;
  // ::ffff:a.b.c.d / ::ffff:7f00:1 (and the deprecated ::a.b.c.d) embed an IPv4 address.
  const mapped = ip.toLowerCase().match(/^::(?:ffff:)?(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    const v4 = mapped[1] ?? [mapped[2]!, mapped[3]!].flatMap((h) => {
      const n = parseInt(h, 16);
      return [n >> 8, n & 255];
    }).join('.');
    return blocked.check(v4, 'ipv4');
  }
  return blocked.check(ip, 'ipv6');
}

const systemLookup: LookupFn = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

/**
 * Production fetch: the socket's own DNS resolution refuses blocked addresses, so a hostname that
 * re-resolves between our check and the connect (DNS rebinding) still can't reach the inside.
 */
const guardedAgent = new Agent({
  connect: {
    lookup: ((hostname, options, cb) => {
      dnsLookup(hostname, { all: true }, (err, addrs) => {
        if (err) return cb(err, '', 0);
        const ok = addrs.filter((a) => !isBlockedAddress(a.address));
        if (ok.length !== addrs.length || !ok.length) return cb(new Error(`Refusing private address for ${hostname}`), '', 0);
        if (options.all) (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, ok);
        else cb(null, ok[0]!.address, ok[0]!.family);
      });
    }) satisfies LookupFunction,
  },
});
const guardedFetch = ((url: string, init?: RequestInit) =>
  undiciFetch(url, { ...(init as object), dispatcher: guardedAgent })) as unknown as typeof fetch;

export interface FeedFetcherOptions {
  fetch?: typeof fetch;
  lookup?: LookupFn;
  timeoutMs?: number;
  maxBytes?: number;
}

export class FeedFetcher implements FeedReader {
  private readonly fetchImpl: typeof fetch;
  private readonly lookup: LookupFn;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(opts: FeedFetcherOptions = {}) {
    this.fetchImpl = opts.fetch ?? guardedFetch;
    this.lookup = opts.lookup ?? systemLookup;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxBytes = opts.maxBytes ?? 3 * 1024 * 1024;
  }

  private async assertPublicUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new FeedProbeError('That is not a valid URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FeedProbeError('Only http and https feed URLs are supported.');
    if (url.username || url.password) throw new FeedProbeError('Feed URLs with embedded credentials are not supported.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    if (isIP(host)) addresses = [host];
    else {
      try {
        addresses = (await this.lookup(host)).map((a) => a.address);
      } catch {
        throw new FeedProbeError(`Could not resolve ${host}.`);
      }
    }
    if (!addresses.length || addresses.some(isBlockedAddress)) throw new FeedProbeError('That address is not publicly reachable.');
    url.hash = '';
    return url;
  }

  private async readCapped(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (declared > this.maxBytes) throw new FeedProbeError('The feed is too large.');
    if (!res.body) return '';
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new FeedProbeError('The feed is too large.');
      }
      parts.push(value);
    }
    return Buffer.concat(parts).toString('utf8');
  }

  async fetchFeed(rawUrl: string, conditional: FetchFeedOptions = {}): Promise<FetchedFeed> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      let url = await this.assertPublicUrl(rawUrl);
      for (let hop = 0; ; hop++) {
        const headers: Record<string, string> = {
          'user-agent': USER_AGENT,
          accept: 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
        };
        if (conditional.etag) headers['if-none-match'] = conditional.etag;
        if (conditional.lastModified) headers['if-modified-since'] = conditional.lastModified;
        const res = await this.fetchImpl(url.toString(), { headers, redirect: 'manual', signal });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
          await res.body?.cancel().catch(() => {});
          if (hop >= MAX_REDIRECTS) throw new FeedProbeError('Too many redirects.');
          url = await this.assertPublicUrl(new URL(location, url).toString());
          continue;
        }
        const meta = { url: url.toString(), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
        if (res.status === 304) {
          await res.body?.cancel().catch(() => {});
          return { ...meta, notModified: true, feed: null };
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new FeedProbeError(`The feed server responded with HTTP ${res.status}.`);
        }
        const body = await this.readCapped(res);
        return { ...meta, notModified: false, feed: parseFeed(body, conditional.now) };
      }
    } catch (e) {
      if (e instanceof FeedProbeError) throw e;
      if (signal.aborted) throw new FeedProbeError('The feed took too long to respond.');
      throw new FeedProbeError(`Could not fetch the feed (${e instanceof Error ? e.message : String(e)}).`);
    }
  }

  async probe(url: string): Promise<ProbedFeed> {
    const res = await this.fetchFeed(url);
    if (!res.feed) throw new FeedProbeError("That URL doesn't look like an RSS or Atom feed.");
    return { url: res.url, title: res.feed.title || new URL(res.url).hostname, siteUrl: res.feed.siteUrl };
  }
}

export function asFeedReader(feeds: FeedProber): FeedReader {
  if ('fetchFeed' in feeds && typeof feeds.fetchFeed === 'function') return feeds as FeedReader;
  throw new Error('deps.feeds must implement fetchFeed (use FeedFetcher) for ingest');
}
