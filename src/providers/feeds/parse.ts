import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
  guid: string;
  url: string | null;
  title: string;
  summary: string;
  publishedAt: Date;
  /** Absolute http(s) URL of the story's lead image, if the feed offers one. */
  imageUrl: string | null;
}

export interface ParsedFeed {
  format: 'rss' | 'atom' | 'rdf';
  title: string;
  siteUrl: string | null;
  items: FeedItem[];
}

export const SUMMARY_MAX = 2000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false, // keep "2024" a string title, not a number
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
});

type Node = unknown;

/** All text under a node (handles plain strings, `#text`, CDATA and Atom xhtml subtrees). */
function textOf(node: Node): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') {
    return Object.entries(node)
      .filter(([k]) => !k.startsWith('@_'))
      .map(([, v]) => textOf(v))
      .join(' ');
  }
  return '';
}

const first = (node: Node): Node => (Array.isArray(node) ? node[0] : node);
const clean = (node: Node) => textOf(first(node)).replace(/\s+/g, ' ').trim();

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', middot: '·', bull: '•', times: '×', eacute: 'é',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

/** HTML fragment → plain text: tags and entities removed, whitespace collapsed, capped. */
export function htmlToText(html: string, max = SUMMARY_MAX): string {
  const text = decodeEntities(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/<[^>]*>/g, ' ') // tags that were entity-escaped twice
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function atomLink(links: Node): string | null {
  const list = (Array.isArray(links) ? links : [links]) as Array<Record<string, string> | string | undefined>;
  const pick = list.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate')) ?? list[0];
  if (!pick) return null;
  return typeof pick === 'string' ? pick : (pick['@_href'] ?? null);
}

/** First plain string among RSS <link> values (skipping any attribute-only variants). */
function rssLink(links: Node): string | null {
  const list = Array.isArray(links) ? links : [links];
  for (const l of list) {
    const s = typeof l === 'string' ? l : l && typeof l === 'object' ? ((l as Record<string, string>)['@_href'] ?? textOf(l)) : '';
    if (s.trim()) return s.trim();
  }
  return null;
}

type Attrs = Record<string, unknown>;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i;
const URL_MAX = 2000;

const objects = (node: Node): Attrs[] =>
  (Array.isArray(node) ? node : node == null ? [] : [node]).filter((n): n is Attrs => !!n && typeof n === 'object');
const attr = (n: Attrs, k: string) => (typeof n[`@_${k}`] === 'string' ? (n[`@_${k}`] as string).trim() : '');
const dim = (n: Attrs, k: string) => Number(attr(n, k)) || 0;

/** Resolves against the item link; only absolute http(s) URLs survive. */
function absoluteImageUrl(raw: string, base: string | null): string | null {
  if (!raw || raw.startsWith('data:')) return null;
  try {
    const u = base ? new URL(decodeEntities(raw), base) : new URL(decodeEntities(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const s = u.toString();
    return s.length <= URL_MAX ? s : null;
  } catch {
    return null;
  }
}

/** First <img src> in an HTML string (skipping 1x1 tracking pixels), or in a parsed Atom xhtml subtree. */
function firstHtmlImage(node: Node): string | null {
  if (typeof node === 'string') {
    for (const m of node.matchAll(/<img\b[^>]*>/gi)) {
      const tag = m[0];
      const src = tag.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (/\s(width|height)\s*=\s*["']?1["'\s/>]/i.test(tag)) continue;
      const v = src?.[1] ?? src?.[2] ?? src?.[3];
      if (v) return v;
    }
    return null;
  }
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = firstHtmlImage(n);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const img of objects((node as Attrs).img)) if (attr(img, 'src')) return attr(img, 'src');
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('@_') || k === 'img') continue;
      const found = firstHtmlImage(v);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The story's lead image. Preference: Media RSS (largest by declared size; media:content over
 * thumbnails when sizes are missing), then an image enclosure, then itunes:image, then the first
 * <img> in the body HTML.
 */
export function itemImage(raw: Record<string, Node>, itemUrl: string | null): string | null {
  const groups = objects(raw['media:group']);
  const media: Array<{ url: string; area: number }> = [];
  for (const m of [...objects(raw['media:content']), ...groups.flatMap((g) => objects(g['media:content']))]) {
    const url = attr(m, 'url');
    const type = attr(m, 'type');
    const medium = attr(m, 'medium');
    const isImage = medium === 'image' || type.startsWith('image/') || (!medium && !type && IMAGE_EXT.test(url));
    // Undeclared size: assume a full-size image, so it still beats a declared small thumbnail.
    if (url && isImage) media.push({ url, area: dim(m, 'width') * dim(m, 'height') || 1_000_000 });
  }
  for (const t of [...objects(raw['media:thumbnail']), ...groups.flatMap((g) => objects(g['media:thumbnail']))]) {
    const url = attr(t, 'url');
    if (url) media.push({ url, area: dim(t, 'width') * dim(t, 'height') });
  }
  media.sort((a, b) => b.area - a.area);

  const enclosures = [...objects(raw.enclosure), ...objects(raw.link).filter((l) => attr(l, 'rel') === 'enclosure')]
    .filter((e) => attr(e, 'type').startsWith('image/'))
    .map((e) => attr(e, 'url') || attr(e, 'href'));
  const itunes = objects(raw['itunes:image']).map((i) => attr(i, 'href'));
  const html = ['content:encoded', 'description', 'content', 'summary'].map((k) => firstHtmlImage(first(raw[k])));

  for (const candidate of [...media.map((m) => m.url), ...enclosures, ...itunes, ...html]) {
    const url = candidate ? absoluteImageUrl(candidate, itemUrl) : null;
    if (url) return url;
  }
  return null;
}

function parseDate(raw: string, fetchedAt: Date): Date {
  const d = raw ? new Date(raw) : null;
  // Missing, unparseable and future-dated items count as "seen now" so they can't pin the top of the ranking.
  return d && !Number.isNaN(d.getTime()) && d <= fetchedAt ? d : fetchedAt;
}

function toItem(raw: Record<string, Node>, format: ParsedFeed['format'], fetchedAt: Date): FeedItem | null {
  const url = format === 'atom' ? atomLink(raw.link) : rssLink(raw.link);
  const bodies = ['description', 'content:encoded', 'summary', 'content']
    .map((k) => htmlToText(textOf(first(raw[k])), Infinity))
    .sort((a, b) => b.length - a.length);
  const summary = htmlToText(bodies[0] ?? '');
  const title = htmlToText(clean(raw.title), 300) || summary.slice(0, 120);
  if (!title) return null;
  const guid =
    clean(raw.guid) ||
    clean(raw.id) ||
    String((raw as Record<string, unknown>)['@_rdf:about'] ?? '') ||
    url ||
    `title:${createHash('sha1').update(title).digest('hex')}`;
  const date = clean(raw.pubDate) || clean(raw['dc:date']) || clean(raw.published) || clean(raw.updated);
  return { guid: guid.slice(0, 1000), url, title, summary, publishedAt: parseDate(date, fetchedAt), imageUrl: itemImage(raw, url) };
}

/** Parses RSS 2.0, Atom 1.0 and RSS 1.0 (RDF). Returns null if the document is none of them. */
export function parseFeed(xml: string, fetchedAt = new Date()): ParsedFeed | null {
  let doc: Record<string, Record<string, Node>>;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  let format: ParsedFeed['format'];
  let channel: Record<string, Node>;
  let items: Node[];
  if (doc.rss?.channel) {
    format = 'rss';
    channel = first(doc.rss.channel) as Record<string, Node>;
    items = (channel.item as Node[]) ?? [];
  } else if (doc.feed) {
    format = 'atom';
    channel = doc.feed;
    items = (channel.entry as Node[]) ?? [];
  } else if (doc['rdf:RDF']) {
    format = 'rdf';
    const rdf = doc['rdf:RDF'];
    channel = (first(rdf.channel) as Record<string, Node>) ?? {};
    items = (rdf.item as Node[]) ?? [];
  } else {
    return null;
  }
  return {
    format,
    title: htmlToText(clean(channel.title), 300),
    siteUrl: format === 'atom' ? atomLink(channel.link) : rssLink(channel.link),
    items: items.flatMap((it) => (it && typeof it === 'object' ? (toItem(it as Record<string, Node>, format, fetchedAt) ?? []) : [])),
  };
}
