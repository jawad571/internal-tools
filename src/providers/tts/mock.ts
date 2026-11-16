import { wordsPerMinuteFor } from '../../shared/constants.ts';
import type { VoiceDto } from '../../shared/contracts.ts';
import { defaultVoiceFor, type SynthesisResult, type TtsProvider } from '../../shared/deps.ts';
import { chunkText } from './chunk.ts';
import { estimateChunkAlignment, joinAlignments } from './timing.ts';

const SAMPLE_RATE = 8000; // 8 kHz, 8-bit mono: ~480 KB per minute
const PERIOD = 20; // 400 Hz tone
const TONE = Buffer.from(Array.from({ length: PERIOD }, (_, i) => 128 + Math.round(6 * Math.sin((2 * Math.PI * i) / PERIOD))));

// Per-language like the ElevenLabs catalog, so the language-aware voice flow can be exercised offline.
const VOICES: VoiceDto[] = [
  { id: 'mock-ava', name: 'Ava', description: 'Test voice (a quiet tone).', gender: 'female', languages: ['en'] },
  { id: 'mock-ben', name: 'Ben', description: 'Test voice (a quiet tone).', gender: 'male', languages: ['en'] },
  { id: 'mock-cam', name: 'Cam', description: 'Test voice (a quiet tone).', gender: 'neutral', languages: ['en'] },
  { id: 'mock-dee', name: 'Dee', description: 'Test voice (a quiet tone).', gender: 'female', languages: ['en'] },
  { id: 'mock-zara', name: 'Zara', description: 'Urdu test voice (a quiet tone).', gender: 'female', languages: ['ur'] },
  { id: 'mock-omar', name: 'Omar', description: 'Urdu test voice (a quiet tone).', gender: 'male', languages: ['ur'] },
];

export function wavHeader(dataBytes: number, sampleRate = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16); // PCM fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate, 28); // byte rate
  h.writeUInt16LE(1, 32); // block align
  h.writeUInt16LE(8, 34); // bits per sample
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** A valid WAV whose length matches the text read at `wordsPerMinute` (English; scaled per language). No network, deterministic. */
export class MockTts implements TtsProvider {
  readonly id = 'mock';

  constructor(private readonly wordsPerMinute: number) {}

  voices() {
    return VOICES;
  }

  defaultVoiceId(language?: string) {
    return defaultVoiceFor(VOICES, language);
  }

  async synthesize({ text, language = 'en' }: Parameters<TtsProvider['synthesize']>[0]): Promise<SynthesisResult> {
    const wpm = wordsPerMinuteFor(language, this.wordsPerMinute);
    const chunks = chunkText(text, 4000);
    const pcm = chunks.map((chunk) => {
      const words = chunk.split(/\s+/).filter(Boolean).length;
      return Buffer.alloc(Math.round((words / wpm) * 60 * SAMPLE_RATE)).fill(TONE);
    });
    const data = Buffer.concat(pcm);
    const alignment = joinAlignments(
      pcm.map((p, i) => ({ durationSeconds: p.length / SAMPLE_RATE, alignment: estimateChunkAlignment(chunks[i]!, p.length / SAMPLE_RATE) })),
      false,
    );
    return {
      audio: Buffer.concat([wavHeader(data.length), data]),
      mime: 'audio/wav',
      durationSeconds: data.length / SAMPLE_RATE,
      alignment,
    };
  }
}
