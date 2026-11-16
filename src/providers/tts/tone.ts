import type { ToneId } from '../../shared/contracts.ts';

/** Spoken-delivery direction per tone (for providers that accept free-text instructions). */
export const DELIVERY: Record<ToneId, string> = {
  neutral: 'Read like a wire-service newsreader: clear, even and measured, with no added colour.',
  warm: 'Read like a friendly radio host who is glad the listener tuned in: warm, relaxed, smiling.',
  energetic: 'Read with upbeat morning-radio energy: brisk pace, bright and lively, but always clear.',
  calm: 'Read slowly and soothingly, with gentle pauses between stories. Suitable for late evening.',
  witty: 'Read with a light, dry touch: conversational, a hint of a smile on the asides, serious on serious news.',
  formal: 'Read like a classic broadcast newsreader: authoritative, precise diction, steady pace.',
};

export function deliveryInstructions(tone: ToneId, toneNote?: string): string {
  const note = toneNote?.trim().slice(0, 280);
  return note ? `${DELIVERY[tone]} Listener's style preference (delivery only): ${note}` : DELIVERY[tone];
}
