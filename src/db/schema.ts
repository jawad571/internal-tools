import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  /** IANA zone, e.g. "Europe/London". All scheduling is done in the user's local time. */
  timezone: text('timezone').notNull().default('UTC'),
  plan: text('plan', { enum: ['free', 'pro'] }).notNull().default('free'),
  /** Secret token that authenticates the private podcast feed and its audio URLs. */
  feedToken: text('feed_token').notNull().unique(),
  /** Bumped on any authenticated API call or audio fetch; idle users stop getting scheduled editions. */
  lastActiveAt: ts('last_active_at').notNull().defaultNow(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 hex of the cookie token; the raw token is never stored. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** A feed, shared by every user who subscribes to it. Fetched once regardless of subscriber count. */
export const sources = pgTable('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: ['rss'] }).notNull().default('rss'),
  /** Normalised feed URL. */
  url: text('url').notNull().unique(),
  title: text('title').notNull(),
  siteUrl: text('site_url'),
  category: text('category').notNull().default('general'),
  /** Shown in the public catalog. Custom user-added feeds are false. */
  isCurated: boolean('is_curated').notNull().default(false),
  etag: text('etag'),
  lastModified: text('last_modified'),
  lastFetchedAt: ts('last_fetched_at'),
  failCount: integer('fail_count').notNull().default(0),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const userSources = pgTable(
  'user_sources',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    /** 1 = normal, 2 = prefer, 3 = always lead with. */
    weight: smallint('weight').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sourceId] }), index('user_sources_source_idx').on(t.sourceId)],
);

export const articles = pgTable(
  'articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    /** Feed guid, falling back to the link, then a hash of the title. */
    guid: text('guid').notNull(),
    url: text('url'),
    title: text('title').notNull(),
    /** Plain-text excerpt/body from the feed, tags stripped, capped at ~2000 chars. */
    summary: text('summary').notNull().default(''),
    publishedAt: ts('published_at').notNull(),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('articles_source_guid_uq').on(t.sourceId, t.guid),
    index('articles_source_published_idx').on(t.sourceId, t.publishedAt),
  ],
);

export const preferences = pgTable('preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Voice id from the active TTS provider's catalog. */
  voiceId: text('voice_id').notNull(),
  tone: text('tone').notNull().default('neutral'),
  /** Optional free-text steer, e.g. "dry humour, no sports metaphors". */
  toneNote: text('tone_note').notNull().default(''),
  language: text('language').notNull().default('en'),
  standardMinutes: smallint('standard_minutes').notNull().default(7),
  extendedMinutes: smallint('extended_minutes').notNull().default(15),
  /** Local hours (0-23) at which the user wants a bulletin. */
  activeHours: smallint('active_hours')
    .array()
    .notNull()
    .default(sql`'{6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21}'`),
  /** Subset of activeHours that get the longer edition. */
  extendedHours: smallint('extended_hours').array().notNull().default(sql`'{6,21}'`),
  paused: boolean('paused').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** One bulletin for one user for one local top-of-hour. The unique index is the scheduling lock. */
export const editions = pgTable(
  'editions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Instant of the local top-of-hour this edition is for (on-demand editions use the request instant). */
    slotAt: ts('slot_at').notNull(),
    localHour: smallint('local_hour').notNull(),
    kind: text('kind', { enum: ['standard', 'extended'] }).notNull(),
    trigger: text('trigger', { enum: ['scheduled', 'on_demand'] }).notNull().default('scheduled'),
    status: text('status', {
      enum: ['pending', 'scripting', 'synthesizing', 'ready', 'skipped', 'failed'],
    })
      .notNull()
      .default('pending'),
    targetSeconds: integer('target_seconds').notNull(),
    /** Snapshot of the prefs used, so later pref changes don't rewrite history. */
    voiceId: text('voice_id').notNull(),
    tone: text('tone').notNull(),
    title: text('title'),
    script: text('script'),
    audioKey: text('audio_key'),
    audioMime: text('audio_mime'),
    audioBytes: integer('audio_bytes'),
    durationSeconds: integer('duration_seconds'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    /** Set when a worker claims the row; stale claims are retried. */
    claimedAt: ts('claimed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    readyAt: ts('ready_at'),
    listenedAt: ts('listened_at'),
  },
  (t) => [
    uniqueIndex('editions_user_slot_uq').on(t.userId, t.slotAt),
    index('editions_status_slot_idx').on(t.status, t.slotAt),
  ],
);

/** Which stories an edition covered — for attribution in the UI and to avoid repeating stories. */
export const editionArticles = pgTable(
  'edition_articles',
  {
    editionId: uuid('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.editionId, t.articleId] }), index('edition_articles_article_idx').on(t.articleId)],
);

export type User = typeof users.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type Article = typeof articles.$inferSelect;
export type Preferences = typeof preferences.$inferSelect;
export type Edition = typeof editions.$inferSelect;
