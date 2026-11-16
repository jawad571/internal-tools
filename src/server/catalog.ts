import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { sources } from '../db/schema.ts';

interface CatalogFeed {
  title: string;
  url: string;
  siteUrl: string;
  category: string;
}

const bbc = (path: string, title: string, category: string, site = path): CatalogFeed => ({
  title,
  url: `https://feeds.bbci.co.uk/${path}/rss.xml`,
  siteUrl: `https://www.bbc.co.uk/${site}`,
  category,
});
const guardian = (section: string, title: string, category: string): CatalogFeed => ({
  title,
  url: `https://www.theguardian.com/${section}/rss`,
  siteUrl: `https://www.theguardian.com/${section}`,
  category,
});
const npr = (id: number, title: string, category: string): CatalogFeed => ({
  title,
  url: `https://feeds.npr.org/${id}/rss.xml`,
  siteUrl: 'https://www.npr.org',
  category,
});

export const CATALOG: CatalogFeed[] = [
  // world
  bbc('news/world', 'BBC News – World', 'world'),
  guardian('world', 'The Guardian – World', 'world'),
  { title: 'The New York Times – World', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', siteUrl: 'https://www.nytimes.com/section/world', category: 'world' },
  { title: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', siteUrl: 'https://news.un.org/en/', category: 'world' },
  npr(1004, 'NPR – World', 'world'),
  // business
  bbc('news/business', 'BBC News – Business', 'business'),
  guardian('business', 'The Guardian – Business', 'business'),
  { title: 'The New York Times – Business', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', siteUrl: 'https://www.nytimes.com/section/business', category: 'business' },
  { title: 'CNBC – Top News', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', siteUrl: 'https://www.cnbc.com', category: 'business' },
  // technology
  { title: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', siteUrl: 'https://arstechnica.com', category: 'technology' },
  { title: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', siteUrl: 'https://www.theverge.com', category: 'technology' },
  { title: 'Hacker News – Front Page', url: 'https://news.ycombinator.com/rss', siteUrl: 'https://news.ycombinator.com', category: 'technology' },
  { title: 'Wired', url: 'https://www.wired.com/feed/rss', siteUrl: 'https://www.wired.com', category: 'technology' },
  { title: 'TechCrunch', url: 'https://techcrunch.com/feed/', siteUrl: 'https://techcrunch.com', category: 'technology' },
  bbc('news/technology', 'BBC News – Technology', 'technology'),
  // science
  { title: 'Nature', url: 'https://www.nature.com/nature.rss', siteUrl: 'https://www.nature.com', category: 'science' },
  { title: 'New Scientist', url: 'https://www.newscientist.com/feed/home/', siteUrl: 'https://www.newscientist.com', category: 'science' },
  { title: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml', siteUrl: 'https://www.sciencedaily.com', category: 'science' },
  bbc('news/science_and_environment', 'BBC News – Science & Environment', 'science'),
  guardian('science', 'The Guardian – Science', 'science'),
  // sport
  bbc('sport', 'BBC Sport', 'sport'),
  { title: 'ESPN – Top Headlines', url: 'https://www.espn.com/espn/rss/news', siteUrl: 'https://www.espn.com', category: 'sport' },
  guardian('sport', 'The Guardian – Sport', 'sport'),
  // politics
  { title: 'Politico', url: 'https://rss.politico.com/politics-news.xml', siteUrl: 'https://www.politico.com', category: 'politics' },
  npr(1014, 'NPR – Politics', 'politics'),
  bbc('news/politics', 'BBC News – UK Politics', 'politics'),
  guardian('politics', 'The Guardian – Politics', 'politics'),
  // culture
  guardian('culture', 'The Guardian – Culture', 'culture'),
  bbc('news/entertainment_and_arts', 'BBC News – Entertainment & Arts', 'culture'),
  npr(1008, 'NPR – Arts & Life', 'culture'),
  // regional
  bbc('news/uk', 'BBC News – UK', 'uk'),
  guardian('uk-news', 'The Guardian – UK News', 'uk'),
  npr(1001, 'NPR – News', 'us'),
  bbc('news/world/us_and_canada', 'BBC News – US & Canada', 'us'),
  guardian('us-news', 'The Guardian – US News', 'us'),
  bbc('news/world/europe', 'BBC News – Europe', 'europe'),
  { title: 'DW – News', url: 'https://rss.dw.com/rdf/rss-en-all', siteUrl: 'https://www.dw.com/en/', category: 'europe' },
  { title: 'France 24 – English', url: 'https://www.france24.com/en/rss', siteUrl: 'https://www.france24.com/en/', category: 'europe' },
  { title: 'Dawn', url: 'https://www.dawn.com/feeds/home', siteUrl: 'https://www.dawn.com', category: 'south-asia' },
  { title: 'The Hindu – National', url: 'https://www.thehindu.com/news/national/feeder/default.rss', siteUrl: 'https://www.thehindu.com', category: 'south-asia' },
  bbc('news/world/asia', 'BBC News – Asia', 'south-asia'),
  { title: 'Al Jazeera – All News', url: 'https://www.aljazeera.com/xml/rss/all.xml', siteUrl: 'https://www.aljazeera.com', category: 'middle-east' },
  bbc('news/world/middle_east', 'BBC News – Middle East', 'middle-east'),
];

/** Idempotent: safe to run at every startup. Keeps fetch state (etag, failCount) of existing rows. */
export async function seedCatalog(db: Db): Promise<void> {
  await db
    .insert(sources)
    .values(CATALOG.map((f) => ({ ...f, isCurated: true })))
    .onConflictDoUpdate({
      target: sources.url,
      set: {
        title: sql`excluded.title`,
        siteUrl: sql`excluded.site_url`,
        category: sql`excluded.category`,
        isCurated: true,
      },
    });
}
