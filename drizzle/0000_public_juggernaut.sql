CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"guid" text NOT NULL,
	"url" text,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edition_articles" (
	"edition_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "edition_articles_edition_id_article_id_pk" PRIMARY KEY("edition_id","article_id")
);
--> statement-breakpoint
CREATE TABLE "editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"local_hour" smallint NOT NULL,
	"kind" text NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"target_seconds" integer NOT NULL,
	"voice_id" text NOT NULL,
	"tone" text NOT NULL,
	"title" text,
	"script" text,
	"audio_key" text,
	"audio_mime" text,
	"audio_bytes" integer,
	"duration_seconds" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"listened_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"voice_id" text NOT NULL,
	"tone" text DEFAULT 'neutral' NOT NULL,
	"tone_note" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"standard_minutes" smallint DEFAULT 7 NOT NULL,
	"extended_minutes" smallint DEFAULT 15 NOT NULL,
	"active_hours" smallint[] DEFAULT '{6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21}' NOT NULL,
	"extended_hours" smallint[] DEFAULT '{6,21}' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'rss' NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"site_url" text,
	"category" text DEFAULT 'general' NOT NULL,
	"is_curated" boolean DEFAULT false NOT NULL,
	"etag" text,
	"last_modified" text,
	"last_fetched_at" timestamp with time zone,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "user_sources" (
	"user_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"weight" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sources_user_id_source_id_pk" PRIMARY KEY("user_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"feed_token" text NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_feed_token_unique" UNIQUE("feed_token")
);
--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_articles" ADD CONSTRAINT "edition_articles_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_articles" ADD CONSTRAINT "edition_articles_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editions" ADD CONSTRAINT "editions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sources" ADD CONSTRAINT "user_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sources" ADD CONSTRAINT "user_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "articles_source_guid_uq" ON "articles" USING btree ("source_id","guid");--> statement-breakpoint
CREATE INDEX "articles_source_published_idx" ON "articles" USING btree ("source_id","published_at");--> statement-breakpoint
CREATE INDEX "edition_articles_article_idx" ON "edition_articles" USING btree ("article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "editions_user_slot_uq" ON "editions" USING btree ("user_id","slot_at");--> statement-breakpoint
CREATE INDEX "editions_status_slot_idx" ON "editions" USING btree ("status","slot_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sources_source_idx" ON "user_sources" USING btree ("source_id");