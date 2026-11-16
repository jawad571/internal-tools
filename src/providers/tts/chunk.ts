const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });

/**
 * Packs whole sentences into chunks of at most `maxChars`. A sentence is only broken when it alone
 * exceeds the limit (then at the last comma/space before it), so prosody stays natural across chunks.
 */
export function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const { segment } of segmenter.segment(text.replace(/\s+/g, ' ').trim())) {
    if (current.length + segment.length <= maxChars) {
      current += segment;
      continue;
    }
    flush();
    let rest = segment;
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars);
      const cut = Math.max(window.lastIndexOf(', ') + 1, window.lastIndexOf(' '));
      const at = cut > maxChars / 2 ? cut : maxChars;
      chunks.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    current = rest;
  }
  flush();
  return chunks;
}
