import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIRERED_CMVN_FILE, FIRERED_MODEL_FILE, FIRERED_SESSION_OPTIONS, FireRedSegmenter, fireRedReady, type OrtModule, type OrtSession } from '../src/firered.ts';
import { KaldiFbank } from '../src/fbank.ts';
import type { Utterance, VadParams } from '../src/vad.ts';

const CACHE_SIZE = 8 * 1 * 128 * 19;

function frame(amp: number): Int16Array {
  const out = new Int16Array(320);
  if (!amp) return out;
  for (let i = 0; i < out.length; i += 1) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}

const PARAMS: VadParams = {
  kind: 'firered',
  threshold: 0.5,
  thresholdDb: -42,
  minSpeechMs: 200,
  minSilenceMs: 200,
  maxUtteranceMs: 2000,
  minUtteranceMs: 100,
};

function fakeOrt(prob: () => number): { ort: OrtModule; session: OrtSession; runs: () => number } {
  let runs = 0;
  const session: OrtSession = {
    run: async (inputs) => {
      runs += 1;
      const frames = (inputs.feat as { dims: readonly number[] }).dims[1];
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) out[i] = prob();
      return { caches_out: { data: new Float32Array(CACHE_SIZE) }, probs: { data: out } };
    },
  };
  const ort = {
    Tensor: class {
      constructor(readonly type: string, readonly data: Float32Array, readonly dims: readonly number[]) {}
    } as unknown as OrtModule['Tensor'],
    InferenceSession: { create: async () => session },
  };
  return { ort, session, runs: () => runs };
}

const CMVN = { dim: 80, means: new Float64Array(80), istd: new Float64Array(80).fill(1) };

describe('FireRed 切分器', () => {
  it('语音帧连成一段，静音够了才交付', async () => {
    let prob = 0.9;
    const { ort, session, runs } = fakeOrt(() => prob);
    const seg = new FireRedSegmenter(PARAMS, { modelPath: 'x.onnx', cmvn: CMVN, ort, session });
    const out: Utterance[] = [];
    seg.subscribe((utterance) => out.push(utterance), (err) => { throw err; });

    let at = 1000;
    for (let i = 0; i < 40; i += 1) {
      at += 20;
      seg.push(frame(12_000), at);
    }
    await seg.whenIdle();
    expect(out).toHaveLength(0);
    expect(seg.active).toBe(true);

    prob = 0.1;
    for (let i = 0; i < 40; i += 1) {
      at += 20;
      seg.push(frame(0), at);
    }
    await seg.whenIdle();
    expect(out).toHaveLength(1);
    expect(out[0].durationMs).toBeGreaterThanOrEqual(PARAMS.minUtteranceMs);
    expect(out[0].text).toBeUndefined();
    expect(seg.active).toBe(false);
    expect(runs()).toBeGreaterThan(10);
  });

  it('纯音乐（概率一直低）不产出片段', async () => {
    const { ort, session } = fakeOrt(() => 0.05);
    const seg = new FireRedSegmenter(PARAMS, { modelPath: 'x.onnx', cmvn: CMVN, ort, session });
    const out: Utterance[] = [];
    seg.subscribe((utterance) => out.push(utterance), (err) => { throw err; });
    let at = 0;
    for (let i = 0; i < 80; i += 1) {
      at += 20;
      seg.push(frame(12_000), at);
    }
    await seg.whenIdle();
    expect(out).toHaveLength(0);
  });

  it('墙上时钟 tick 在没有新帧时收尾', async () => {
    const { ort, session } = fakeOrt(() => 0.9);
    const seg = new FireRedSegmenter(PARAMS, { modelPath: 'x.onnx', cmvn: CMVN, ort, session });
    const out: Utterance[] = [];
    seg.subscribe((utterance) => out.push(utterance), (err) => { throw err; });
    let at = 0;
    for (let i = 0; i < 40; i += 1) {
      at += 20;
      seg.push(frame(12_000), at);
    }
    await seg.whenIdle();
    seg.tick(at + 400);
    await seg.whenIdle();
    expect(out).toHaveLength(1);
  });

  it('自建会话时限定单线程并关自旋', async () => {
    let seen: unknown;
    const ort = {
      Tensor: class {} as unknown as OrtModule['Tensor'],
      InferenceSession: {
        create: async (_path: string, options?: unknown) => {
          seen = options;
          return { run: async () => ({}) } as unknown as OrtSession;
        },
      },
    };
    const seg = new FireRedSegmenter(PARAMS, { modelPath: 'x.onnx', cmvn: CMVN, ort });
    await seg.whenIdle();
    expect(seen).toEqual(FIRERED_SESSION_OPTIONS);
  });

  it('模型两个文件都在才算就绪', () => {
    const dir = mkdtempSync(join(tmpdir(), 'firered-'));
    try {
      expect(fireRedReady(dir)).toBe(false);
      const model = join(dir, FIRERED_MODEL_FILE);
      writeFileSync(model, '');
      truncateSync(model, 2_000_000);
      expect(fireRedReady(dir)).toBe(false);
      const cmvn = join(dir, FIRERED_CMVN_FILE);
      writeFileSync(cmvn, '');
      truncateSync(cmvn, 2_000);
      expect(fireRedReady(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Kaldi fbank', () => {
  it('400 个样本出一帧 80 维，帧数按 10ms 步长走', () => {
    const fbank = new KaldiFbank();
    const first = fbank.accept(new Int16Array(400).fill(1000));
    expect(first).toHaveLength(1);
    expect(first[0]).toHaveLength(80);
    expect(first[0].every((v) => Number.isFinite(v))).toBe(true);
    const more = fbank.accept(new Int16Array(320));
    expect(fbank.frameCount).toBe(1 + more.length);
    expect(more).toHaveLength(2);
  });
});
