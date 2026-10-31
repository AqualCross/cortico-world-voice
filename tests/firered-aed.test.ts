import { describe, it, expect } from 'vitest';
import { AED_LABELS, FireRedAedClassifier, aedReady, FIRERED_AED_FILE } from '../src/firered-aed.ts';
import type { OrtModule, OrtSession } from '../src/firered.ts';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeOrt(triples: Array<[number, number, number]>): { ort: OrtModule; session: OrtSession } {
  const session: OrtSession = {
    run: async (inputs) => {
      const frames = (inputs.feat as { dims: readonly number[] }).dims[1];
      const out = new Float32Array(frames * 3);
      for (let i = 0; i < frames; i += 1) {
        const triple = triples[Math.min(i, triples.length - 1)];
        out[i * 3] = triple[0];
        out[i * 3 + 1] = triple[1];
        out[i * 3 + 2] = triple[2];
      }
      return { probs: { data: out } };
    },
  };
  const ort = {
    Tensor: class {
      constructor(readonly type: string, readonly data: Float32Array, readonly dims: readonly number[]) {}
    } as unknown as OrtModule['Tensor'],
    InferenceSession: { create: async () => session },
  };
  return { ort, session };
}

const CMVN = { dim: 80, means: new Float64Array(80), istd: new Float64Array(80).fill(1) };
const PCM = new Int16Array(16_000).fill(2000);

async function classify(triples: Array<[number, number, number]>) {
  const { ort, session } = fakeOrt(triples);
  const cls = await FireRedAedClassifier.create({ modelPath: 'x.onnx', cmvn: CMVN, ort, session });
  return cls.classify(PCM);
}

describe('FireRed AED', () => {
  it('人声帧占多数就是说话', async () => {
    const result = await classify([[0.9, 0.05, 0.05]]);
    expect(result.label).toBe('speech');
    expect(AED_LABELS[result.label]).toBe('说话');
  });

  it('唱歌帧占多数就是唱歌', async () => {
    const result = await classify([[0.1, 0.85, 0.05]]);
    expect(result.label).toBe('singing');
  });

  it('几乎没有人声帧就是音乐', async () => {
    const result = await classify([[0.02, 0.02, 0.96]]);
    expect(result.label).toBe('music');
    expect(result.voice).toBe(0);
  });

  it('模型在不在看体积下限', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aed-'));
    try {
      expect(aedReady(dir)).toBe(false);
      const file = join(dir, FIRERED_AED_FILE);
      writeFileSync(file, '');
      truncateSync(file, 2_000_000);
      expect(aedReady(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
