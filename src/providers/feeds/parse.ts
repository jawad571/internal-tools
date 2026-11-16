import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
  guid: string;
  url: string | null;
  title: string;
  summary: string;
  publishedAt: Date;
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
  return { guid: guid.slice(0, 1000), url, title, summary, publishedAt: parseDate(date, fetchedAt) };
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
