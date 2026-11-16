/**
 * In-browser mock of the Newscast API for development and UI verification (VITE_MOCK=1 only).
 * Requests are validated with the real contract schemas and answered with contract-shaped
 * data. State lives in sessionStorage so reloads keep you signed in.
 *
 *   Demo account: demo@newscast.test / newscast  (sources, history, one failed edition)
 *   A new signup starts empty; its first "generate" also backfills some history so the
 *   Listen screen can be seen populated.
 *   Feed URLs: anything without rss/feed/atom/xml in it → 422; containing "broken" → unhealthy.
 */
import { SUPPORTED_LANGUAGES, isSupportedLanguage, urduHourLabel, voicesForLanguage } from '@shared/constants';
import {
  AddSourceBody,
  GenerateNowBody,
  LIMITS,
  LoginBody,
  SignupBody,
  UpdateMeBody,
  UpdatePreferencesBody,
  UpdateSourceBody,
  VoicePreviewBody,
  type EditionDetailDto,
  type EditionDto,
  type Me,
  type MySourceDto,
  type PreferencesDto,
  type SourceDto,
} from '@shared/contracts';
import { setTransport } from '../lib/api';
import { currentHourIn, hourLabel } from '../lib/format';
import { CATALOG, SCRIPT, SCRIPT_UR, STORY_POOL, TITLES, TITLES_UR, VOICES } from './data';
import { makeWav } from './wav';
// Rendered by the real ffmpeg renderer (src/providers/video/ffmpeg.ts) at 640x360.
import sampleVideo from './sample.mp4';

type MockEdition = EditionDto & { createdAt: number; stories: number[]; failError?: string; wantsVideo?: boolean };
type MockUser = {
  id: string;
  email: string;
  password: string;
  displayName: string;
  timezone: string;
  plan: 'free' | 'pro';
  feedToken: string;
  prefs: PreferencesDto;
  subs: { sourceId: string; weight: number }[];
  custom: (SourceDto & { unhealthy: boolean })[];
  editions: MockEdition[];
  onDemand: { day: string; count: number };
  seeded: boolean;
};
type Db = { users: MockUser[]; session: string | null; v: 1 };

const KEY = 'nc.mock.v3'; // v2: video + story images; v3: bulletin language
const rid = () => crypto.randomUUID();
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

function defaultPrefs(plan: 'free' | 'pro'): PreferencesDto {
  return {
    voiceId: 'ada',
    tone: 'warm',
    toneNote: '',
    language: 'en',
    standardMinutes: LIMITS.standardMinutes.default,
    extendedMinutes: LIMITS.extendedMinutes.default,
    activeHours: [...LIMITS.plans[plan].defaultActiveHours],
    extendedHours: [6, 21],
    paused: false,
    videoBulletins: false,
    videoAvailable: true,
  };
}

function newUser(email: string, password: string, displayName: string, timezone: string): MockUser {
  return {
    id: rid(),
    email,
    password,
    displayName,
    timezone,
    plan: 'free',
    feedToken: token(),
    prefs: defaultPrefs('free'),
    subs: [],
    custom: [],
    editions: [],
    onDemand: { day: '', count: 0 },
    seeded: false,
  };
}

const DURATIONS = { standard: [402, 431, 447], extended: [845, 871] };

function seedHistory(u: MockUser, now = Date.now()) {
  const top = Math.floor(now / 3_600_000) * 3_600_000;
  const plan: { hoursAgo: number; kind: 'standard' | 'extended'; status: EditionDto['status']; listened: boolean }[] = [
    { hoursAgo: 1, kind: 'standard', status: 'ready', listened: false },
    { hoursAgo: 3, kind: 'extended', status: 'ready', listened: false },
    { hoursAgo: 5, kind: 'standard', status: 'failed', listened: false },
    { hoursAgo: 7, kind: 'standard', status: 'skipped', listened: false },
    { hoursAgo: 9, kind: 'standard', status: 'ready', listened: true },
    { hoursAgo: 22, kind: 'extended', status: 'ready', listened: true },
    { hoursAgo: 26, kind: 'standard', status: 'ready', listened: true },
    { hoursAgo: 30, kind: 'standard', status: 'ready', listened: false },
  ];
  plan.forEach((p, i) => {
    const slot = new Date(top - p.hoursAgo * 3_600_000);
    const durs = DURATIONS[p.kind];
    u.editions.push({
      id: rid(),
      slotAt: slot.toISOString(),
      localHour: currentHourIn(u.timezone, slot),
      kind: p.kind,
      trigger: 'scheduled',
      status: p.status,
      // One Urdu edition in the history, so the RTL title/transcript can be seen without switching.
      language: i === 1 ? 'ur' : 'en',
      title: p.status === 'ready' ? (i === 1 ? TITLES_UR[0]! : TITLES[i % TITLES.length]!) : null,
      durationSeconds: p.status === 'ready' ? durs[i % durs.length]! : null,
      audioUrl: null,
      listened: p.listened,
      storyCount: p.status === 'ready' ? (p.kind === 'extended' ? 9 : 5) : 0,
      videoStatus: p.status === 'ready' && i < 3 ? 'ready' : 'none',
      videoUrl: null,
      createdAt: slot.getTime() - 600_000,
      stories: pick(i, p.kind === 'extended' ? 9 : 5),
      failError: p.status === 'failed' ? 'The voice service timed out twice. This did not count towards your daily allowance.' : undefined,
    });
  });
  u.seeded = true;
}

function pick(seed: number, n: number): number[] {
  return Array.from({ length: n }, (_, k) => (seed * 3 + k * 5) % STORY_POOL.length).filter((v, i, a) => a.indexOf(v) === i);
}

function seedDb(): Db {
  const demo = newUser('demo@newscast.test', 'newscast', 'Sam', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  demo.subs = [
    { sourceId: CATALOG[0]!.id, weight: 3 },
    { sourceId: CATALOG[3]!.id, weight: 2 },
    { sourceId: CATALOG[6]!.id, weight: 1 },
    { sourceId: CATALOG[9]!.id, weight: 1 },
    { sourceId: CATALOG[11]!.id, weight: 2 },
  ];
  demo.custom.push({
    id: rid(),
    title: 'Riverside Gazette',
    url: 'https://riverside-gazette.example/feed.xml',
    siteUrl: 'https://riverside-gazette.example',
    category: 'Local',
    isCurated: false,
    unhealthy: true,
  });
  seedHistory(demo);
  return { users: [demo], session: null, v: 1 };
}

let db: Db = load();
function load(): Db {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw) as Db;
      if (d.v === 1) return d;
    }
  } catch {
    /* fall through */
  }
  return seedDb();
}
function persist() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* ignore */
  }
}

// ---- audio (blob URLs are per page load, so they're derived, never stored) ----
const audioCache = new Map<number, string>();
function audioUrlFor(seconds: number): string {
  let u = audioCache.get(seconds);
  if (!u) {
    u = URL.createObjectURL(makeWav(seconds, { seed: seconds % 7 }));
    audioCache.set(seconds, u);
  }
  return u;
}

// ---- edition lifecycle ----
function advance(e: MockEdition, u: MockUser) {
  const t = Date.now() - e.createdAt;
  // Video renders after the audio is ready, independently of it.
  if (e.status === 'ready' && e.wantsVideo && (e.videoStatus === 'pending' || e.videoStatus === 'rendering')) {
    e.videoStatus = t < 11000 ? 'pending' : t < 16000 ? 'rendering' : 'ready';
  }
  if (e.status !== 'pending' && e.status !== 'scripting' && e.status !== 'synthesizing') return;
  if (t < 2500) e.status = 'pending';
  else if (t < 5500) e.status = 'scripting';
  else if (t < 9000) e.status = 'synthesizing';
  else {
    e.status = 'ready';
    const durs = DURATIONS[e.kind];
    e.durationSeconds = durs[u.editions.length % durs.length]!;
    e.title = e.language === 'ur' ? TITLES_UR[u.editions.length % TITLES_UR.length]! : TITLES[(u.editions.length + 3) % TITLES.length]!;
    e.storyCount = e.stories.length;
    if (e.wantsVideo) e.videoStatus = 'pending';
  }
}

function toDto(e: MockEdition): EditionDto {
  return {
    id: e.id,
    slotAt: e.slotAt,
    localHour: e.localHour,
    kind: e.kind,
    trigger: e.trigger,
    status: e.status,
    language: e.language ?? 'en',
    title: e.title,
    durationSeconds: e.durationSeconds,
    audioUrl: e.status === 'ready' && e.durationSeconds ? audioUrlFor(e.durationSeconds) : null,
    listened: e.listened,
    storyCount: e.storyCount,
    videoStatus: e.videoStatus ?? 'none',
    videoUrl: e.status === 'ready' && e.videoStatus === 'ready' ? sampleVideo : null,
  };
}

/** Placeholder story art: an SVG data URL (no network), for every other story. */
function storyImage(n: number): string | null {
  if (n % 3 === 2) return null;
  const hues = [210, 15, 160, 280, 45, 340];
  const h = hues[n % hues.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 70% 45%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360} 70% 25%)"/></linearGradient></defs><rect width="160" height="90" fill="url(#g)"/><circle cx="${40 + (n * 23) % 80}" cy="45" r="28" fill="rgba(255,255,255,.18)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function toDetail(e: MockEdition, u: MockUser): EditionDetailDto {
  const ready = e.status === 'ready';
  return {
    ...toDto(e),
    script: ready
      ? e.language === 'ur'
        ? SCRIPT_UR(u.displayName, urduHourLabel(e.localHour))
        : SCRIPT(u.displayName, hourLabel(e.localHour).replace(/ /g, ' '))
      : null,
    error: e.failError ?? null,
    stories: ready
      ? e.stories.map((s, i) => {
          const src = CATALOG[(s + i) % CATALOG.length]!;
          const per = ((e.durationSeconds ?? 0) - 20) / Math.max(1, e.stories.length);
          return {
            title: STORY_POOL[s]!,
            url: `${src.siteUrl}/news/${s + 100}`,
            sourceTitle: src.title,
            publishedAt: new Date(new Date(e.slotAt).getTime() - (i + 1) * 17 * 60_000).toISOString(),
            imageUrl: storyImage(s),
            startSeconds: Math.round(8 + i * per),
          };
        })
      : [],
  };
}

// ---- helpers ----
function meOf(u: MockUser): Me {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    timezone: u.timezone,
    plan: u.plan,
    podcastFeedUrl: `${location.origin}/feed/${u.feedToken}.xml`,
  };
}

function mySources(u: MockUser): MySourceDto[] {
  const fromCatalog = u.subs
    .map((s) => {
      const c = CATALOG.find((x) => x.id === s.sourceId);
      return c ? { ...c, weight: s.weight, unhealthy: false } : null;
    })
    .filter((x): x is MySourceDto => !!x);
  const custom = u.custom.map((c) => ({ ...c, weight: u.subs.find((s) => s.sourceId === c.id)?.weight ?? 1 }));
  return [...fromCatalog, ...custom];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { message: string; path: PropertyKey[] }[] } } }, body: unknown) {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true as const, data: r.data };
  const issue = r.error.issues[0];
  const field = issue?.path?.length ? `${String(issue.path[0])}: ` : '';
  return { ok: false as const, res: fail(400, 'validation', `${field}${issue?.message ?? 'Invalid request'}`) };
}

function isPrivateHost(h: string) {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

// ---- router ----
async function handle(path: string, init: RequestInit): Promise<Response> {
  const url = new URL(path, location.origin);
  const method = (init.method ?? 'GET').toUpperCase();
  const p = url.pathname;
  let body: unknown;
  try {
    body = init.body ? JSON.parse(String(init.body)) : undefined;
  } catch {
    return fail(400, 'bad_json', 'Malformed JSON');
  }

  // auth
  if (p === '/api/auth/signup' && method === 'POST') {
    const r = parse(SignupBody, body);
    if (!r.ok) return r.res;
    if (db.users.some((u) => u.email.toLowerCase() === r.data.email.toLowerCase()))
      return fail(409, 'email_taken', 'An account with that email already exists. Try logging in.');
    const u = newUser(r.data.email, r.data.password, r.data.displayName, r.data.timezone);
    db.users.push(u);
    db.session = u.id;
    return json({ me: meOf(u) });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const r = parse(LoginBody, body);
    if (!r.ok) return r.res;
    const u = db.users.find((x) => x.email.toLowerCase() === r.data.email.toLowerCase() && x.password === r.data.password);
    if (!u) return fail(401, 'invalid_credentials', 'That email and password don’t match.');
    db.session = u.id;
    return json({ me: meOf(u) });
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    db.session = null;
    return json({ ok: true });
  }

  const u = db.users.find((x) => x.id === db.session);
  if (!u) return fail(401, 'unauthorized', 'Please log in.');

  // me
  if (p === '/api/me' && method === 'GET') return json({ me: meOf(u) });
  if (p === '/api/me' && method === 'PATCH') {
    const r = parse(UpdateMeBody, body);
    if (!r.ok) return r.res;
    if (r.data.timezone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: r.data.timezone });
      } catch {
        return fail(422, 'bad_timezone', 'That time zone isn’t recognised.');
      }
      u.timezone = r.data.timezone;
    }
    if (r.data.displayName) u.displayName = r.data.displayName;
    return json({ me: meOf(u) });
  }
  if (p === '/api/me/rotate-feed-token' && method === 'POST') {
    u.feedToken = token();
    return json({ me: meOf(u) });
  }

  // sources
  if (p === '/api/sources/catalog' && method === 'GET') return json({ sources: CATALOG });
  if (p === '/api/sources' && method === 'GET') return json({ sources: mySources(u) });
  if (p === '/api/sources' && method === 'POST') {
    const r = parse(AddSourceBody, body);
    if (!r.ok) return r.res;
    const max = LIMITS.plans[u.plan].maxSources;
    if (mySources(u).length >= max)
      return fail(422, 'source_limit', `Your ${u.plan === 'free' ? 'Free' : 'Pro'} plan includes up to ${max} sources. Remove one to add another.`);
    if ('sourceId' in r.data) {
      const sourceId = r.data.sourceId;
      const c = CATALOG.find((x) => x.id === sourceId);
      if (!c) return fail(404, 'not_found', 'That source is no longer in the catalog.');
      if (!u.subs.some((s) => s.sourceId === c.id)) u.subs.push({ sourceId: c.id, weight: 1 });
      return json({ source: { ...c, weight: 1, unhealthy: false } }, 201);
    }
    const feedUrl = new URL(r.data.url);
    await sleep(600);
    if (!/^https?:$/.test(feedUrl.protocol) || isPrivateHost(feedUrl.hostname))
      return fail(422, 'url_not_allowed', 'That address can’t be used. Feeds must be on the public internet.');
    if (!/(rss|feed|atom|xml)/i.test(feedUrl.href))
      return fail(422, 'not_a_feed', 'We couldn’t find an RSS or Atom feed at that address. Try the site’s feed link instead.');
    if (mySources(u).some((s) => s.url === feedUrl.href)) return fail(409, 'duplicate', 'You already follow that feed.');
    const s = {
      id: rid(),
      title: feedUrl.hostname.replace(/^www\./, '').split('.')[0]!.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
      url: feedUrl.href,
      siteUrl: feedUrl.origin,
      category: 'Custom',
      isCurated: false,
      unhealthy: /broken/i.test(feedUrl.href),
    };
    u.custom.push(s);
    u.subs.push({ sourceId: s.id, weight: 1 });
    return json({ source: { ...s, weight: 1 } }, 201);
  }
  const srcMatch = p.match(/^\/api\/sources\/([^/]+)$/);
  if (srcMatch) {
    const sid = decodeURIComponent(srcMatch[1]!);
    const mine = mySources(u).find((s) => s.id === sid);
    if (!mine) return fail(404, 'not_found', 'You don’t follow that source.');
    if (method === 'PATCH') {
      const r = parse(UpdateSourceBody, body);
      if (!r.ok) return r.res;
      const sub = u.subs.find((s) => s.sourceId === sid);
      if (sub) sub.weight = r.data.weight;
      return json({ source: { ...mine, weight: r.data.weight } });
    }
    if (method === 'DELETE') {
      u.subs = u.subs.filter((s) => s.sourceId !== sid);
      u.custom = u.custom.filter((s) => s.id !== sid);
      return json({ ok: true });
    }
  }

  // voices & prefs
  if (p === '/api/voices' && method === 'GET') return json({ voices: VOICES });
  if (p === '/api/preferences' && method === 'GET') return json({ preferences: u.prefs });
  if (p === '/api/preferences' && method === 'PUT') {
    const r = parse(UpdatePreferencesBody, body);
    if (!r.ok) return r.res;
    if (r.data.language !== undefined && !isSupportedLanguage(r.data.language)) {
      const options = SUPPORTED_LANGUAGES.map((l) => `${l.name} (${l.code})`).join(', ');
      return fail(422, 'unsupported_language', `Bulletins can't be read in "${r.data.language}" yet. Choose one of: ${options}`);
    }
    const next = { ...u.prefs, ...r.data, videoAvailable: true };
    // Same rule as the server: a language change without a voice moves to that language's first voice.
    if (r.data.voiceId === undefined && r.data.language !== undefined && r.data.language !== u.prefs.language) {
      const fits = VOICES.some((v) => v.id === next.voiceId && v.languages.includes(next.language));
      if (!fits) next.voiceId = voicesForLanguage(VOICES, next.language)[0]?.id ?? next.voiceId;
    }
    const max = LIMITS.plans[u.plan].maxActiveHours;
    if (next.activeHours.length > max)
      return fail(422, 'hour_limit', `Your plan includes up to ${max} bulletin hours a day.`);
    if (r.data.voiceId && !VOICES.some((v) => v.id === r.data.voiceId)) return fail(422, 'bad_voice', 'That voice isn’t available.');
    next.extendedHours = next.extendedHours.filter((h) => next.activeHours.includes(h));
    u.prefs = next;
    return json({ preferences: u.prefs });
  }
  if (p === '/api/preferences/preview' && method === 'POST') {
    const r = parse(VoicePreviewBody, body);
    if (!r.ok) return r.res;
    await sleep(700);
    const blob = makeWav(4, { rate: 8000, seed: r.data.voiceId.length + r.data.tone.length });
    return new Response(blob, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  }

  // editions
  if (p === '/api/editions' && method === 'GET') {
    const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 30) || 30);
    const before = url.searchParams.get('before');
    u.editions.forEach((e) => advance(e, u));
    const list = u.editions
      .filter((e) => e.status !== 'skipped' && (!before || e.slotAt < before))
      .sort((a, b) => (a.slotAt < b.slotAt ? 1 : -1))
      .slice(0, limit)
      .map(toDto);
    return json({ editions: list });
  }
  if (p === '/api/editions/generate' && method === 'POST') {
    const r = parse(GenerateNowBody, body ?? {});
    if (!r.ok) return r.res;
    if (mySources(u).length === 0) return fail(422, 'no_sources', 'Add at least one source before generating a bulletin.');
    const day = new Date().toDateString();
    if (u.onDemand.day !== day) u.onDemand = { day, count: 0 };
    const allowance = LIMITS.plans[u.plan].onDemandPerDay;
    if (u.onDemand.count >= allowance)
      return fail(429, 'on_demand_limit', `You’ve used today’s ${allowance} on-demand bulletins. Scheduled ones will keep coming.`);
    u.onDemand.count++;
    if (!u.seeded && u.editions.length === 0) seedHistory(u);
    const now = new Date();
    const e: MockEdition = {
      id: rid(),
      slotAt: now.toISOString(),
      localHour: currentHourIn(u.timezone, now),
      kind: r.data.kind,
      trigger: 'on_demand',
      status: 'pending',
      language: u.prefs.language,
      title: null,
      durationSeconds: null,
      audioUrl: null,
      listened: false,
      storyCount: 0,
      videoStatus: 'none',
      videoUrl: null,
      wantsVideo: u.prefs.videoBulletins,
      createdAt: Date.now(),
      stories: pick(u.editions.length + 1, r.data.kind === 'extended' ? 9 : 5),
    };
    u.editions.push(e);
    return json({ edition: toDto(e) }, 202);
  }
  const edMatch = p.match(/^\/api\/editions\/([^/]+)(\/listened)?$/);
  if (edMatch) {
    const e = u.editions.find((x) => x.id === decodeURIComponent(edMatch[1]!));
    if (!e) return fail(404, 'not_found', 'That bulletin could not be found.');
    advance(e, u);
    if (edMatch[2] && method === 'POST') {
      e.listened = true;
      return json({ ok: true });
    }
    if (!edMatch[2] && method === 'GET') return json({ edition: toDetail(e, u) });
  }

  return fail(404, 'not_found', `No mock route for ${method} ${p}`);
}

export function installMock() {
  console.info('[newscast] API mock enabled — demo login: demo@newscast.test / newscast');
  setTransport(async (path, init) => {
    await sleep(120 + Math.random() * 200);
    const res = await handle(path, init);
    persist();
    return res;
  });
}
