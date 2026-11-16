import type { VoiceDto } from '../../shared/contracts.ts';
import type { SynthesisResult, TtsProvider } from '../../shared/deps.ts';
import { chunkText } from './chunk.ts';

const SAMPLE_RATE = 8000; // 8 kHz, 8-bit mono: ~480 KB per minute
const PERIOD = 20; // 400 Hz tone
const TONE = Buffer.from(Array.from({ length: PERIOD }, (_, i) => 128 + Math.round(6 * Math.sin((2 * Math.PI * i) / PERIOD))));

const VOICES: VoiceDto[] = [
  { id: 'mock-ava', name: 'Ava', description: 'Test voice (a quiet tone).', gender: 'female' },
  { id: 'mock-ben', name: 'Ben', description: 'Test voice (a quiet tone).', gender: 'male' },
  { id: 'mock-cam', name: 'Cam', description: 'Test voice (a quiet tone).', gender: 'neutral' },
  { id: 'mock-dee', name: 'Dee', description: 'Test voice (a quiet tone).', gender: 'female' },
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

/** A valid WAV whose length matches the text read at `wordsPerMinute`. No network, deterministic. */
export class MockTts implements TtsProvider {
  readonly id = 'mock';

  constructor(private readonly wordsPerMinute: number) {}

  voices() {
    return VOICES;
  }

  defaultVoiceId() {
    return VOICES[0]!.id;
  }

  async synthesize({ text }: Parameters<TtsProvider['synthesize']>[0]): Promise<SynthesisResult> {
    const pcm = chunkText(text, 4000).map((chunk) => {
      const words = chunk.split(/\s+/).filter(Boolean).length;
      return Buffer.alloc(Math.round((words / this.wordsPerMinute) * 60 * SAMPLE_RATE)).fill(TONE);
    });
    const data = Buffer.concat(pcm);
    return { audio: Buffer.concat([wavHeader(data.length), data]), mime: 'audio/wav', durationSeconds: data.length / SAMPLE_RATE };
  }
}
