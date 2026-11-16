/** Zod-free constants, so the browser bundle can use them without pulling in the schemas. */

export const TONES = [
  { id: 'neutral', label: 'Neutral', blurb: 'Straight wire-service delivery. Facts first, no colour.' },
  { id: 'warm', label: 'Warm', blurb: 'A friendly host who is glad you tuned in.' },
  { id: 'energetic', label: 'Energetic', blurb: 'Upbeat morning-radio pace.' },
  { id: 'calm', label: 'Calm', blurb: 'Unhurried and soothing. Good for late evening.' },
  { id: 'witty', label: 'Witty', blurb: 'Dry asides between stories; never at the expense of accuracy.' },
  { id: 'formal', label: 'Formal', blurb: 'Classic broadcast newsreader.' },
] as const;

export const LIMITS = {
  standardMinutes: { min: 5, max: 10, default: 7 },
  extendedMinutes: { min: 10, max: 20, default: 15 },
  toneNoteMax: 280,
  plans: {
    free: { maxSources: 8, maxActiveHours: 6, onDemandPerDay: 2, defaultActiveHours: [6, 9, 12, 15, 18, 21] },
    pro: { maxSources: 60, maxActiveHours: 24, onDemandPerDay: 12, defaultActiveHours: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21] },
  },
} as const;
