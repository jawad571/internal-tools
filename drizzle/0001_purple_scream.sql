ALTER TABLE "articles" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "editions" ADD COLUMN "segments" jsonb;--> statement-breakpoint
ALTER TABLE "editions" ADD COLUMN "video_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "editions" ADD COLUMN "video_key" text;--> statement-breakpoint
ALTER TABLE "editions" ADD COLUMN "video_bytes" integer;--> statement-breakpoint
ALTER TABLE "editions" ADD COLUMN "video_error" text;--> statement-breakpoint
ALTER TABLE "editions" ADD COLUMN "video_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "video_bulletins" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "editions_video_status_idx" ON "editions" USING btree ("video_status");