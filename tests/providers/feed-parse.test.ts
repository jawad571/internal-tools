import { describe, expect, it } from 'vitest';
import { htmlToText, parseFeed, SUMMARY_MAX } from '../../src/providers/feeds/parse.ts';

const FETCHED = new Date('2026-11-16T08:00:00Z');

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Example &amp; Co News</title>
  <link>https://example.com/</link>
  <atom:link href="https://example.com/feed.xml" rel="self"/>
  <item>
    <title>Council approves &lt;b&gt;new&lt;/b&gt; budget</title>
    <link>https://example.com/budget</link>
    <guid isPermaLink="false">budget-123</guid>
    <pubDate>Mon, 16 Nov 2026 07:30:00 GMT</pubDate>
    <description><![CDATA[<p>The council <strong>approved</strong> a &pound;2.4m budget &mdash; the largest ever.</p><script>alert(1)</script>]]></description>
  </item>
  <item>
    <title>No date or guid here</title>
    <link>https://example.com/nodate</link>
    <description>Plain   text
      summary.</description>
    <content:encoded><![CDATA[<div><p>Longer full body&nbsp;text with <a href="x">a link</a> &#8212; and more.</p></div>]]></content:encoded>
  </item>
  <item>
    <title>2026</title>
    <description>Title only numbers</description>
  </item>
  <item>
    <title>Future dated</title>
    <guid>future</guid>
    <pubDate>Fri, 01 Jan 2100 00:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Atom Example</title>
  <link rel="self" href="https://atom.example.org/feed"/>
  <link rel="alternate" href="https://atom.example.org/"/>
  <entry>
    <title type="html">Rocket &amp;lt;em&amp;gt;launch&amp;lt;/em&amp;gt; succeeds</title>
    <link rel="alternate" type="text/html" href="https://atom.example.org/rocket"/>
    <link rel="enclosure" href="https://atom.example.org/rocket.mp3"/>
    <id>tag:atom.example.org,2026:rocket</id>
    <published>2026-11-16T06:00:00Z</published>
    <updated>2026-11-16T07:00:00Z</updated>
    <summary type="html">&lt;p&gt;A short &lt;i&gt;summary&lt;/i&gt;.&lt;/p&gt;</summary>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>The rocket lifted off at dawn.</p><p>All stages performed nominally.</p></div></content>
  </entry>
  <entry>
    <title>Updated only</title>
    <id>urn:uuid:2</id>
    <updated>2026-11-15T22:00:00Z</updated>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example.net/"><title>RDF Example</title><link>https://rdf.example.net/</link></channel>
  <item rdf:about="https://rdf.example.net/a">
    <title>RDF item</title><link>https://rdf.example.net/a</link>
    <dc:date>2026-11-16T05:00:00Z</dc:date>
    <description>RDF description</description>
  </item>
</rdf:RDF>`;

describe('parseFeed', () => {
  it('parses RSS 2.0 with HTML stripping, entity decoding and fallbacks', () => {
    const feed = parseFeed(RSS, FETCHED)!;
    expect(feed.format).toBe('rss');
    expect(feed.title).toBe('Example & Co News');
    expect(feed.siteUrl).toBe('https://example.com/');
    expect(feed.items).toHaveLength(4);

    const [a, b, c, d] = feed.items;
    expect(a).toMatchObject({ guid: 'budget-123', url: 'https://example.com/budget', title: 'Council approves new budget' });
    expect(a!.publishedAt.toISOString()).toBe('2026-11-16T07:30:00.000Z');
    expect(a!.summary).toBe('The council approved a £2.4m budget — the largest ever.');

    // guid falls back to link; missing date falls back to fetch time; longest body wins
    expect(b!.guid).toBe('https://example.com/nodate');
    expect(b!.publishedAt).toEqual(FETCHED);
    expect(b!.summary).toBe('Longer full body text with a link — and more.');

    // no guid, no link -> title hash; numeric titles stay strings
    expect(c!.title).toBe('2026');
    expect(c!.guid).toMatch(/^title:[0-9a-f]{40}$/);
    expect(c!.url).toBeNull();

    // future dates are clamped to fetch time
    expect(d!.publishedAt).toEqual(FETCHED);
  });

  it('parses Atom including xhtml content and alternate links', () => {
    const feed = parseFeed(ATOM, FETCHED)!;
    expect(feed.format).toBe('atom');
    expect(feed.title).toBe('Atom Example');
    expect(feed.siteUrl).toBe('https://atom.example.org/');
    const [a, b] = feed.items;
    expect(a).toMatchObject({ guid: 'tag:atom.example.org,2026:rocket', url: 'https://atom.example.org/rocket', title: 'Rocket launch succeeds' });
    expect(a!.publishedAt.toISOString()).toBe('2026-11-16T06:00:00.000Z');
    expect(a!.summary).toBe('The rocket lifted off at dawn. All stages performed nominally.');
    expect(b!.publishedAt.toISOString()).toBe('2026-11-15T22:00:00.000Z');
    expect(b!.summary).toBe('');
  });

  it('parses RSS 1.0 / RDF', () => {
    const feed = parseFeed(RDF, FETCHED)!;
    expect(feed.format).toBe('rdf');
    expect(feed.title).toBe('RDF Example');
    expect(feed.items[0]).toMatchObject({ guid: 'https://rdf.example.net/a', title: 'RDF item', summary: 'RDF description' });
    expect(feed.items[0]!.publishedAt.toISOString()).toBe('2026-11-16T05:00:00.000Z');
  });

  it('returns null for non-feeds', () => {
    expect(parseFeed('<html><body>hi</body></html>')).toBeNull();
    expect(parseFeed('not xml at all')).toBeNull();
  });

  it('caps summaries', () => {
    expect(htmlToText(`<p>${'word '.repeat(1000)}</p>`).length).toBeLessThanOrEqual(SUMMARY_MAX);
  });
});

describe('story images', () => {
  const rss = (items: string) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>Img</title><link>https://img.example/</link>${items}</channel></rss>`;
  const images = (xml: string) => parseFeed(xml, FETCHED)!.items.map((i) => i.imageUrl);

  it('prefers the largest Media RSS image, including inside media:group', () => {
    expect(
      images(
        rss(`
      <item><title>a</title><link>https://img.example/a</link>
        <media:thumbnail url="https://cdn.example/a-thumb.jpg" width="144" height="81"/>
        <media:content url="https://cdn.example/a-small.jpg" medium="image" width="320" height="180"/>
        <media:content url="https://cdn.example/a-large.jpg" medium="image" width="1600" height="900"/>
        <media:content url="https://cdn.example/a.mp4" medium="video" width="3840" height="2160"/>
      </item>
      <item><title>b</title>
        <media:group>
          <media:content url="https://cdn.example/b-640.jpg" type="image/jpeg" width="640" height="360"/>
          <media:content url="https://cdn.example/b-1280.jpg" type="image/jpeg" width="1280" height="720"/>
        </media:group>
      </item>
      <item><title>c</title>
        <media:thumbnail url="https://cdn.example/c-thumb.jpg" width="150" height="150"/>
        <media:content url="https://cdn.example/c-full.jpg"/>
      </item>`),
      ),
    ).toEqual(['https://cdn.example/a-large.jpg', 'https://cdn.example/b-1280.jpg', 'https://cdn.example/c-full.jpg']);
  });

  it('falls back to image enclosures, itunes:image, then the first <img> in the body', () => {
    expect(
      images(
        rss(`
      <item><title>enclosure</title>
        <enclosure url="https://cdn.example/audio.mp3" type="audio/mpeg" length="1"/>
        <enclosure url="https://cdn.example/pic.png" type="image/png" length="1"/>
      </item>
      <item><title>itunes</title><itunes:image href="https://cdn.example/cover.jpg"/></item>
      <item><title>html</title><link>https://site.example/news/story</link>
        <description><![CDATA[<img src="https://track.example/p.gif" width="1" height="1"><p>Hi <img alt="x" src='/img/lead.jpg?w=800&amp;h=450'></p>]]></description>
      </item>
      <item><title>escaped html</title>
        <description>&lt;p&gt;&lt;img src="https://cdn.example/esc.jpg"&gt;&lt;/p&gt;</description>
      </item>
      <item><title>none</title><description>No pictures.</description></item>`),
      ),
    ).toEqual([
      'https://cdn.example/pic.png',
      'https://cdn.example/cover.jpg',
      'https://site.example/img/lead.jpg?w=800&h=450',
      'https://cdn.example/esc.jpg',
      null,
    ]);
  });

  it('rejects non-http(s) and data URLs', () => {
    expect(
      images(
        rss(`
      <item><title>a</title><media:content url="javascript:alert(1)" medium="image"/>
        <description><![CDATA[<img src="data:image/png;base64,AAAA"><img src="ftp://x.example/a.jpg">]]></description></item>
      <item><title>b</title><media:content url="file:///etc/passwd" medium="image"/><itunes:image href="https://cdn.example/ok.jpg"/></item>`),
      ),
    ).toEqual([null, 'https://cdn.example/ok.jpg']);
  });

  it('reads Atom image enclosures and xhtml content images', () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
      <entry><title>one</title><id>1</id><link rel="alternate" href="https://atom.example/1"/>
        <link rel="enclosure" type="image/jpeg" href="https://atom.example/1.jpg"/></entry>
      <entry><title>two</title><id>2</id><link rel="alternate" href="https://atom.example/2"/>
        <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Text</p><img src="pics/2.webp"/></div></content></entry>
    </feed>`;
    expect(images(atom)).toEqual(['https://atom.example/1.jpg', 'https://atom.example/pics/2.webp']);
  });
});
