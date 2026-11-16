# Newscast — architecture

Personalised hourly audio news. Users pick sources, a voice and a tone; every hour they have
opted into, a 5–10 minute bulletin (longer "extended" editions at chosen hours, default 6am and
9pm local) is written and voiced for them, playable in the web app or any podcast app.

## Shape

One TypeScript codebase, one Postgres database, two roles (`ROLE=web|worker|all`):

```
            ┌────────── web (Hono) ──────────┐        ┌──────────── worker ────────────┐
 browser ──▶│ /api/*  auth, sources, prefs,  │        │ ingest loop   feeds → articles │
 podcast ──▶│         editions, audio(Range) │        │ scheduler     due slots → rows │
   apps     │ /feed/:token.xml  private RSS  │        │ generator     row → script →   │
            │ static SPA (web/dist)          │        │               audio → ready    │
            └──────────────┬─────────────────┘        └───────────────┬────────────────┘
                           └──────────── Postgres + blob store ───────┘
```

- `src/shared/` — contracts (zod, shared with the browser), config, time helpers, ports (`deps.ts`).
- `src/db/` — Drizzle schema + client. `DATABASE_URL=postgres://…` in prod; otherwise in-process
  PGlite, so dev and tests need no database server. Migrations in `drizzle/` run at startup.
- `src/server/` — HTTP API. Depends only on the `Deps` ports.
- `src/pipeline/` — ingest, story selection, scheduler, edition generator, worker loop.
- `src/providers/` — implementations of the ports: Anthropic script writer, OpenAI / ElevenLabs
  TTS, local / S3 blob store, feed fetcher; each with a mock so everything runs with no API keys.
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
