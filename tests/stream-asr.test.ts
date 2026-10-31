import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamSegmenter, paraformerReady, type SherpaOnlineModule, type SherpaOnlineRecognizer, type SherpaOnlineStream } from '../src/stream-asr.ts';
import type { VadParams } from '../src/vad.ts';

function frame(amp = 12_000): Int16Array {
  const out = new Int16Array(320);
  if (!amp) return out;
  for (let i = 0; i < out.length; i += 1) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}

interface FakeState {
  text: string;
  nextText: string | null;
  endpoint: boolean;
  resets: number;
  decoded: number;
  accepted: number;
  ready: boolean;
  config: unknown;
}

function fakeSherpa() {
  const state: FakeState = { text: '', nextText: null, endpoint: false, resets: 0, decoded: 0, accepted: 0, ready: false, config: null };
  const stream: SherpaOnlineStream = {
    acceptWaveform: () => { state.accepted += 1; state.ready = true; },
  };
  const recognizer: SherpaOnlineRecognizer = {
    createStream: () => stream,
    isReady: () => state.ready,
    decode: () => {
      state.ready = false;
      state.decoded += 1;
      if (state.nextText !== null) {
        state.text = state.nextText;
        state.nextText = null;
      }
    },
    isEndpoint: () => state.endpoint,
    reset: () => {
      state.resets += 1;
      state.text = '';
      state.endpoint = false;
    },
    getResult: () => ({ text: state.text }),
  };
  const mod = {
    OnlineRecognizer: function OnlineRecognizer(config: unknown) {
      state.config = config;
      return recognizer;
    },
  } as unknown as SherpaOnlineModule;
  return { state, load: () => mod };
}

const PARAMS: VadParams = {
  kind: 'stream',
  threshold: 0.5,
  thresholdDb: -42,
  minSpeechMs: 250,
  minSilenceMs: 100,
  maxUtteranceMs: 2000,
  minUtteranceMs: 100,
};

describe('流式切分器（Paraformer）', () => {
  it('连续静音够了才交出一句：正文随块给出，随后重置', () => {
    const { state, load } = fakeSherpa();
    const seg = new StreamSegmenter(PARAMS, { modelDir: 'D:/models/paraformer', load });
    // 引擎自带的端点是「没解出新字」，会切碎连续说话；这里必须关掉，断句由电平来判。
    expect((state.config as { enableEndpoint?: boolean }).enableEndpoint).toBe(false);

    state.nextText = '你好呀';
    let at = 1000;
    const out = [];
    for (let i = 0; i < 5; i += 1) {
      at += 20;
      out.push(...seg.push(frame(), at));
    }
    expect(out).toHaveLength(0);
    expect(seg.active).toBe(true);
    expect(seg.level).toBeGreaterThan(-40);

    // 300ms 静音（门限 -42 dBFS，最短静音 100ms）：第 5 帧时断句。
    for (let i = 0; i < 15; i += 1) {
      at += 20;
      out.push(...seg.push(frame(0), at));
    }
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('你好呀');
    expect(out[0].durationMs).toBe(200);
    expect(out[0].pcm.length).toBe(320 * 10);
    expect(out[0].forced).toBe(false);
    expect(state.resets).toBe(1);
    expect(seg.active).toBe(false);
  });

  it('没有新帧时 tick 补静音，把端点推出来', () => {
    const { state, load } = fakeSherpa();
    const seg = new StreamSegmenter(PARAMS, { modelDir: 'D:/models/paraformer', load });
    state.nextText = '收到';
    let at = 1000;
    for (let i = 0; i < 5; i += 1) {
      at += 20;
      seg.push(frame(), at);
    }
    const accepted = state.accepted;
    state.endpoint = true;
    const out = seg.tick(at + 600);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('收到');
    expect(state.accepted).toBeGreaterThan(accepted);
  });

  it('没解出字（纯音乐）到上限才丢，不留空记录', () => {
    const { state, load } = fakeSherpa();
    const seg = new StreamSegmenter(PARAMS, { modelDir: 'D:/models/paraformer', load });
    let at = 0;
    const out = [];
    for (let i = 0; i < 100; i += 1) {
      at += 20;
      out.push(...seg.push(frame(), at));
    }
    expect(out).toHaveLength(0);
    expect(seg.dropped).toBe(1);
  });

  it('到单块上限强切', () => {
    const { state, load } = fakeSherpa();
    const seg = new StreamSegmenter(PARAMS, { modelDir: 'D:/models/paraformer', load });
    state.nextText = '一直在说';
    let at = 0;
    const out = [];
    for (let i = 0; i < 110; i += 1) {
      at += 20;
      out.push(...seg.push(frame(), at));
    }
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].forced).toBe(true);
    expect(out[0].durationMs).toBeGreaterThanOrEqual(2000);
  });

  it('模型三个文件齐了才算就绪', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paraformer-'));
    try {
      expect(paraformerReady(dir)).toBe(false);
      mkdirSync(dir, { recursive: true });
      for (const [file, size] of [['encoder.int8.onnx', 100_000_000], ['decoder.int8.onnx', 40_000_000], ['tokens.txt', 20_000]] as const) {
        const path = join(dir, file);
        writeFileSync(path, '');
        truncateSync(path, size);
      }
      expect(paraformerReady(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
