/**
 * Generates small 8-bit mono WAV files in memory so the mock can serve playable audio:
 * a soft two-note chime every few seconds over a quiet hum. Low sample rate keeps a
 * 14-minute "bulletin" to a few MB.
 */
export function makeWav(seconds: number, opts: { rate?: number; seed?: number } = {}): Blob {
  const rate = opts.rate ?? 4000;
  const n = Math.max(1, Math.floor(seconds * rate));
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); // byte rate
  v.setUint16(32, 1, true); // block align
  v.setUint16(34, 8, true); // bits
  str(36, 'data');
  v.setUint32(40, n, true);

  const seed = opts.seed ?? 0;
  const notes = [523.25, 659.25, 587.33, 783.99, 698.46, 880];
  const period = 4 * rate;
  const out = new Uint8Array(buf, 44);
  const tau = Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const k = Math.floor(i / period);
    const local = (i % period) / rate;
    const f1 = notes[(k + seed) % notes.length]!;
    const f2 = notes[(k + seed + 2) % notes.length]!;
    let s = 0;
    if (local < 1.6) s += Math.sin(tau * f1 * t) * Math.exp(-local * 3) * 0.32;
    if (local > 0.35 && local < 2.2) s += Math.sin(tau * f2 * t) * Math.exp(-(local - 0.35) * 3) * 0.26;
    s += Math.sin(tau * 110 * t) * 0.03;
    // fade in/out at the edges
    const edge = Math.min(1, t / 0.3, (seconds - t) / 0.3);
    out[i] = Math.max(0, Math.min(255, Math.round(128 + s * edge * 127)));
  }
  return new Blob([buf], { type: 'audio/wav' });
}
