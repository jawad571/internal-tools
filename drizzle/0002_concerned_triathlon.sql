ALTER TABLE "editions" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "editions" ADD COLUMN "title_en" text;--> statement-breakpoint
-- Only en/ur are supported from here on; any other stored code becomes the default.
UPDATE "preferences" SET "language" = 'en' WHERE "language" NOT IN ('en', 'ur');