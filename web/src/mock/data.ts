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
  { id: 'ada', name: 'Ada', description: 'Clear and measured, with a light British accent.', gender: 'female' },
  { id: 'marcus', name: 'Marcus', description: 'A warm baritone. Easy to follow at speed.', gender: 'male' },
  { id: 'juno', name: 'Juno', description: 'Bright and quick — suits an energetic tone.', gender: 'female' },
  { id: 'sol', name: 'Sol', description: 'Even, unhurried and neutral.', gender: 'neutral' },
  { id: 'theo', name: 'Theo', description: 'Classic newsreader gravitas.', gender: 'male' },
  { id: 'imogen', name: 'Imogen', description: 'Soft-spoken; lovely late in the evening.', gender: 'female' },
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
