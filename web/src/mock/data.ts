import type { SourceDto, VoiceDto } from '@shared/contracts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Seed = [title: string, site: string, category: string];
const SEEDS: Seed[] = [
  ['The Morning Ledger', 'morningledger.example', 'Business'],
  ['Market Wire', 'marketwire.example', 'Business'],
  ['Fieldnotes Economics', 'fieldnotes.example', 'Business'],
  ['Northern Chronicle', 'northernchronicle.example', 'National'],
  ['Capital Dispatch', 'capitaldispatch.example', 'National'],
  ['City Desk Daily', 'citydesk.example', 'National'],
  ['Global Briefing', 'globalbriefing.example', 'World'],
  ['Atlas Report', 'atlasreport.example', 'World'],
  ['Harbour Post', 'harbourpost.example', 'World'],
  ['Circuit & Code', 'circuitcode.example', 'Technology'],
  ['The Patch Notes', 'patchnotes.example', 'Technology'],
  ['Open Lab', 'openlab.example', 'Science'],
  ['Orbit Weekly', 'orbitweekly.example', 'Science'],
  ['Climate Desk', 'climatedesk.example', 'Science'],
  ['Final Whistle', 'finalwhistle.example', 'Sport'],
  ['Track & Field Times', 'trackfield.example', 'Sport'],
  ['The Long Table', 'longtable.example', 'Culture'],
  ['Matinee', 'matinee.example', 'Culture'],
  ['Ward Round', 'wardround.example', 'Health'],
];

export const CATALOG: SourceDto[] = SEEDS.map(([title, site, category], i) => ({
  id: id(i + 1),
  title,
  url: `https://${site}/rss`,
  siteUrl: `https://${site}`,
  category,
  isCurated: true,
}));

export const VOICES: VoiceDto[] = [
  { id: 'ada', name: 'Ada', description: 'Clear and measured, with a light British accent.', gender: 'female', languages: ['en'] },
  { id: 'marcus', name: 'Marcus', description: 'A warm baritone. Easy to follow at speed.', gender: 'male', languages: ['en'] },
  { id: 'juno', name: 'Juno', description: 'Bright and quick — suits an energetic tone.', gender: 'female', languages: ['en'] },
  { id: 'sol', name: 'Sol', description: 'Even, unhurried and neutral.', gender: 'neutral', languages: ['en'] },
  { id: 'theo', name: 'Theo', description: 'Classic newsreader gravitas.', gender: 'male', languages: ['en'] },
  { id: 'imogen', name: 'Imogen', description: 'Soft-spoken; lovely late in the evening.', gender: 'female', languages: ['en'] },
  { id: 'amjid', name: 'Amjid', description: 'Urdu, deep and clear documentary narrator.', gender: 'male', languages: ['ur'] },
  { id: 'reva', name: 'Reva', description: 'Urdu, warm and unhurried narrator.', gender: 'female', languages: ['ur'] },
  { id: 'naqsh', name: 'Naqsh', description: 'Urdu, relaxed documentary voice.', gender: 'male', languages: ['ur'] },
];

export const TITLES = [
  'Rates held, a bridge reopens and a late winner in the cup',
  'Talks resume overnight; chip makers rally; frost warning',
  'Budget week begins, a new comet, and the transfer window',
  'Ceasefire holds, rail strike called off, record harvest',
  'Markets steady as inflation eases; museum reopens',
  'Storm clean-up continues; a landmark ruling; tennis upset',
  'Housing figures, a satellite launch and the derby preview',
  'Parliament returns, energy bills fall, a quiet day in tech',
];

/** Titles in Urdu, for editions whose bulletin language is Urdu. */
export const TITLES_UR = [
  'شرح سود برقرار، پل دوبارہ کھل گیا اور کپ میں آخری لمحے کی جیت',
  'رات بھر مذاکرات، چپ کمپنیوں میں تیزی اور پالے کی وارننگ',
  'بجٹ کا ہفتہ شروع، نیا دمدار ستارہ اور ٹرانسفر ونڈو',
  'جنگ بندی برقرار، ریل ہڑتال ختم اور ریکارڈ فصل',
];

export const STORY_POOL = [
  'Central bank holds rates for a third month',
  'Coastal bridge reopens after two-year repair',
  'Late goal sends underdogs into the quarter-finals',
  'Overnight talks resume with new mediators',
  'Chip makers rally on stronger demand outlook',
  'Frost warning issued for northern regions',
  'Astronomers confirm a new long-period comet',
  'City council approves expanded cycle network',
  'Rail strike called off after last-minute deal',
  'Record harvest expected despite dry summer',
  'Museum reopens with restored east wing',
  'Regulator opens consultation on app store fees',
  'Hospital waiting lists fall for the first time this year',
  'Wind farm cleared for construction offshore',
];

export const SCRIPT = (name: string, hour: string) => `Good ${hour.includes('PM') ? 'evening' : 'morning'}, ${name}. This is your ${hour} Newscast — here’s what’s happened since your last bulletin.

The central bank has held interest rates for a third month running. In a short statement, policymakers said inflation was easing more slowly than hoped, but that the labour market remained resilient. Markets had expected the decision, and the currency barely moved.

On the coast, the harbour bridge has reopened to traffic after a two-year repair programme that ran several months over schedule. Local businesses say the closure cost them dearly; the council says the new deck should last half a century.

Overseas, talks resumed overnight with a fresh team of mediators. Both delegations described the first session as constructive — diplomatic language, perhaps, but a change in tone from last week.

In technology, chip makers rallied after one of the industry’s largest suppliers raised its forecast for the rest of the year, pointing to demand from data centres and, more quietly, from carmakers.

And finally, sport. A goal deep into stoppage time sent the underdogs through to the quarter-finals for the first time in their history. Their manager called it the best night of his career. The draw is tomorrow at noon.

That’s your Newscast for ${hour}. Your next bulletin will be ready on the hour.`;

/** `slot` is already in Urdu, e.g. "شام 6 بجے". */
export const SCRIPT_UR = (name: string, slot: string) => `السلام علیکم ${name}۔ یہ ہے ${slot} کا نیوزکاسٹ، آپ کے پچھلے خبرنامے کے بعد کی اہم خبریں۔

مرکزی بینک نے مسلسل تیسرے مہینے شرح سود میں کوئی تبدیلی نہیں کی۔ ایک مختصر بیان میں پالیسی سازوں نے کہا کہ مہنگائی توقع سے کم رفتار سے کم ہو رہی ہے، لیکن روزگار کی منڈی مضبوط ہے۔ مارکیٹ کو اسی فیصلے کی توقع تھی، اور کرنسی پر کوئی خاص اثر نہیں پڑا۔

ساحلی علاقے میں ہاربر برج دو سال کی مرمت کے بعد ٹریفک کے لیے دوبارہ کھول دیا گیا ہے۔ مقامی تاجروں کا کہنا ہے کہ بندش سے انہیں بھاری نقصان ہوا، جبکہ کونسل کے مطابق نیا پل پچاس سال تک چلے گا۔

بیرون ملک، ثالثوں کی نئی ٹیم کے ساتھ رات بھر مذاکرات دوبارہ شروع ہوئے۔ دونوں وفود نے پہلے اجلاس کو تعمیری قرار دیا، جو پچھلے ہفتے کے مقابلے میں لہجے کی تبدیلی ہے۔

ٹیکنالوجی کی دنیا میں، چپ بنانے والی کمپنیوں کے حصص میں تیزی آئی، جب ایک بڑی سپلائر کمپنی نے سال کے باقی حصے کے لیے اپنی پیش گوئی بڑھا دی۔

اور آخر میں کھیل۔ اضافی وقت کے آخری لمحات میں کیے گئے گول نے کمزور سمجھی جانے والی ٹیم کو تاریخ میں پہلی بار کوارٹر فائنل میں پہنچا دیا۔ ٹیم کے مینیجر نے اسے اپنے کیریئر کی بہترین رات قرار دیا۔

یہ تھا ${slot} کا نیوزکاسٹ۔ اپنا خیال رکھیے، اللہ حافظ۔`;
