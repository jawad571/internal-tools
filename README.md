# Newscast

Personalised hourly audio news: pick your sources, a voice and a tone, and get a 5–10 minute
bulletin every hour you choose (longer editions at e.g. 6am and 9pm), in the web app or any
podcast app. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Run locally

```bash
npm install
npm run web:install
npm run web:build
npm start
```

Open http://localhost:8787. With no configuration it uses an embedded database (`.data/`), a
placeholder script writer and a placeholder voice (a tone, not speech), so the whole flow works
without accounts. Copy `.env.example` to `.env` and set:

- `ANTHROPIC_API_KEY` — real bulletin scripts
- `ELEVENLABS_API_KEY` — real voices (ElevenLabs v4, the most natural); `OPENAI_API_KEY` also works
  until OpenAI retires its TTS models on 2027-01-06
- `DATABASE_URL=postgres://…`, `STORAGE=s3`, `PUBLIC_URL` — production

In production run `ROLE=web` and `ROLE=worker` as separate processes; any number of each.

## Develop

```bash
npm test
npm run typecheck
npm run dev
npm run web:dev
```

`npm --prefix web run dev:mock` runs the UI alone against an in-browser fake API.
