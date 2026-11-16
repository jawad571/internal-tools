# Newscast — architecture

Personalised hourly audio news. Users pick sources, a voice and a tone; every hour they have
opted into, a 5–10 minute bulletin (longer "extended" editions at chosen hours, default 6am and
9pm local) is written and voiced for them, playable in the web app or any podcast app.

## Shape

One TypeScript codebase, one Postgres database, two roles (`ROLE=web|worker|all`):

```
            ┌────────── web (Hono) ──────────┐        ┌──────────── worker ────────────┐
 browser ──▶│ /api/*  auth, sources, prefs,  │        │ ingest loop   feeds → articles │
 podcast ──▶│         editions, audio/video  │        │ scheduler     due slots → rows │
   apps     │         (Range)                │        │ generator     row → script →   │
            │ /feed/:token.xml  private RSS  │        │               audio → ready    │
            │ static SPA (web/dist)          │        │ video queue   ready → MP4      │
            └──────────────┬─────────────────┘        └───────────────┬────────────────┘
                           └──────────── Postgres + blob store ───────┘
```

- `src/shared/` — contracts (zod, shared with the browser), config, time helpers, ports (`deps.ts`).
- `src/db/` — Drizzle schema + client. `DATABASE_URL=postgres://…` in prod; otherwise in-process
  PGlite, so dev and tests need no database server. Migrations in `drizzle/` run at startup.
- `src/server/` — HTTP API. Depends only on the `Deps` ports.
- `src/pipeline/` — ingest, story selection, scheduler, edition generator, worker loop.
- `src/providers/` — implementations of the ports: Anthropic script writer, OpenAI / ElevenLabs
  TTS, ffmpeg video renderer, local / S3 blob store, feed fetcher; each with a mock so everything
  runs with no API keys.
- `web/` — Vite + React PWA.

## Decisions that matter

1. **Feeds are shared, bulletins are personal.** A `sources` row is fetched once however many
   users subscribe; only feeds with ≥1 subscriber are fetched. Per-user cost is one LLM call and
   one TTS job per edition.
2. **The `editions(user_id, slot_at)` unique index is the scheduler lock.** The scheduler inserts
   `pending` rows with ON CONFLICT DO NOTHING; workers claim rows with
   `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`. Any number of workers can run; no
   separate queue to operate.
3. **Slots are local top-of-hour instants** (`nextSlot` in `shared/time.ts`), so :30/:45-offset
   zones and DST behave. Generation starts `SCHEDULE_LEAD_MINUTES` early so audio is ready on the hour.
4. **Duration is a word budget.** minutes × `WORDS_PER_MINUTE` → target words handed to the
   script writer; actual duration is measured from the audio.
5. **No repeats.** `edition_articles` records what each edition covered; selection excludes those
   and clusters near-duplicate headlines across sources. No fresh stories → edition is `skipped`,
   not padded.
6. **Idle users cost nothing.** No activity for `IDLE_PAUSE_DAYS` → scheduled generation stops;
   on-demand generation still works and reactivates them. Podcast-app audio fetches count as activity.
7. **Tone is applied twice**: in the script (word choice, structure) and, where the TTS provider
   supports it, in delivery instructions.
8. **User-supplied feed URLs are untrusted**: http(s) only, private/loopback addresses refused,
   size and time capped.
9. **Video is a best-effort second output.** The script writer returns per-story segments; TTS
   returns character timings (ElevenLabs `with-timestamps`; OpenAI and mock estimate within each
   chunk, anchored on each chunk's measured length). `pipeline/timeline.ts` turns those into a
   contiguous `editions.segments` timeline (story start/end seconds), stored with the audio.
   When `VIDEO_ENABLED` and the user opted in, the edition is marked `video_status = pending`
   once the audio is ready; a separate worker queue (same SKIP LOCKED pattern) renders it with
   ffmpeg-static: each story's feed image with a Ken Burns move (or a title card), a lower third
   for the current story, a ticker of the others, intro/outro cards. All text goes through
   drawtext `textfile=` with expansion off, so headlines never touch the filtergraph. A failed or
   abandoned render only sets `video_status = failed`; the audio edition is never affected.
   Story images are untrusted URLs fetched under the same rules as feeds (decision 8), sniffed
   by magic bytes and re-encoded; any failure falls back to a title card.
10. **Spoken language is per user; on-screen text is always English.** `SUPPORTED_LANGUAGES`
   (`shared/constants.ts`, shared with the web app) lists en and ur; adding a language is one
   line there plus voices for it. The language is snapshotted on the edition with the voice.
   The script writer translates the (usually English) stories into the spoken language and also
   returns an English title (`titleEn`); the video uses that, the feed headlines and an English
   slot label, never the script, because drawtext can't shape Urdu. No English title → a generic
   "Newscast · Monday 16 November, 6 PM" card. Each language has its own speaking rate for the
   word budget (Urdu 160 vs English 150 wpm, scaled by `WORDS_PER_MINUTE`). Voices declare the
   languages they are for: changing language without picking a voice moves to that language's
   first voice, a voice sent with the change is kept (an explicit choice), and generation only
   substitutes a voice the provider no longer has, with the language's default. ElevenLabs gets
   `language_code` on models that take it (v3/v4, flash/turbo v2.5; not multilingual_v2). Its
   Urdu voices are Voice Library voices used by id; if the API refuses one, it is added to the
   account once (`POST /v1/voices/add/…`) and the request retried. Timeline matching counts base
   characters only (no whitespace, combining marks or zero-width joiners, after NFKD), so Urdu
   alignment lines up however the provider splits diacritics.
