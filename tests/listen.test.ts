import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIO_DEFAULTS, type AudioConfigSection } from '../src/config.ts';
import { EnergySegmenter } from '../src/vad.ts';
import { readLanes, setLane, writeLanes } from '../src/lanes.ts';
import { ListenEngine, type CaptureLike, type ListenDeps } from '../src/listen.ts';
import type { CaptureStatusEvent, CaptureTarget } from '../src/capture.ts';
import type { Segmenter, Utterance, VadParams } from '../src/vad.ts';

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'audio-listen-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

/** 方波帧：振幅足够越过能量门限；amp=0 就是静音帧。 */
function frame(amp = 12_000): Int16Array {
  const out = new Int16Array(320);
  if (!amp) return out;
  for (let i = 0; i < out.length; i += 1) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}

class FakeCapture implements CaptureLike {
  running = false;
  feed: (frame: Int16Array) => void = () => {};
  status: (event: CaptureStatusEvent) => void = () => {};
  target: CaptureTarget | null = null;
  stopped = 0;

  start(target: CaptureTarget): void {
    this.target = target;
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.stopped += 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setup(overrides: {
  busy?: () => boolean;
  transcribe?: (pcm: Int16Array) => Promise<string>;
  listen?: Partial<AudioConfigSection['listen']>;
  realSegmenter?: boolean;
  segmenter?: (params: VadParams) => Segmenter;
  titleOf?: (pid: number) => Promise<string>;
  classify?: (pcm: Int16Array) => Promise<{ label: 'speech' | 'singing' | 'music' } | null>;
} = {}) {
  const cfg = structuredClone(AUDIO_DEFAULTS) as AudioConfigSection;
  cfg.listen = {
    ...cfg.listen,
    vad: {
      kind: 'energy',
      threshold: 0.5,
      thresholdDb: -40,
      minSpeechMs: 60,
      minSilenceMs: 100,
      maxUtteranceMs: 2000,
      minUtteranceMs: 100,
    },
    transcribe: true,
    ...overrides.listen,
  };
  let clock = 1_000_000;
  const captures: FakeCapture[] = [];
  const ship = vi.fn();
  const deps: ListenDeps = {
    lanesFile: join(scratchDir, 'lanes.json'),
    cfg: () => cfg,
    sileroModel: () => '',
    streamModel: () => join(scratchDir, 'paraformer'),
    fireRedDir: () => join(scratchDir, 'firered'),
    log: { info: () => {}, warn: () => {} },
    transcribe: overrides.transcribe ?? (async () => '你好呀'),
    ship: (chunk, text, info) => { ship(chunk, text, info); },
    titleOf: overrides.titleOf,
    busy: overrides.busy ?? (() => false),
    ...(overrides.classify ? { classify: overrides.classify } : {}),
    createCapture: (hooks) => {
      const capture = new FakeCapture();
      capture.feed = hooks.onFrame;
      capture.status = hooks.onStatus;
      captures.push(capture);
      return capture;
    },
    createSegmenter: overrides.segmenter
      ?? (overrides.realSegmenter
        ? undefined
        : (params: VadParams) => new EnergySegmenter(params) as Segmenter),
    now: () => clock,
    tickMs: 10,
  };
  const engine = new ListenEngine(deps);
  return {
    engine,
    cfg,
    captures,
    ship,
    lanesFile: deps.lanesFile,
    advance: (ms: number) => { clock += ms; },
    clock: () => clock,
  };
}

describe('监听引擎', () => {
  it('按 lanes.json 开始采集，切出一块就转写并交出去', async () => {
    const { engine, captures, ship, lanesFile, advance } = setup();
    writeLanes(lanesFile, [{ id: 'system', vad: '' }]);
    engine.start();
    expect(captures).toHaveLength(1);
    expect(captures[0].target).toEqual({ source: 'system' });
    expect(engine.listening).toBe(true);

    const feed = captures[0].feed;
    // 说 400ms，然后安静下来；收尾靠 tick 的墙上时钟。
    for (let i = 0; i < 20; i += 1) {
      advance(20);
      feed(frame());
    }
    advance(200);
    await sleep(30);
    await sleep(20);

    expect(ship).toHaveBeenCalledTimes(1);
    const [record, text] = ship.mock.calls[0];
    expect(record.target).toBe('系统声音');
    expect(record.durationMs).toBeGreaterThanOrEqual(100);
    expect(text).toBe('你好呀');
    engine.dispose();
  });

  it('应用车道用窗口标题当名字，查不到就退回应用 PID', async () => {
    const pid = process.pid;
    const { engine, captures, ship, lanesFile, advance } = setup({
      titleOf: async (queried) => (queried === pid ? 'Door · 高橋李依' : ''),
    });
    writeLanes(lanesFile, [{ id: `app:${pid}`, vad: '' }]);
    engine.start();
    const feed = captures[0].feed;
    for (let i = 0; i < 20; i += 1) {
      advance(20);
      feed(frame());
    }
    advance(200);
    await sleep(40);
    expect(ship.mock.calls[0][0].target).toBe('Door · 高橋李依');
    engine.dispose();
  });

  it('查不到窗口标题时仍用应用 PID', async () => {
    const pid = process.pid;
    const { engine, captures, ship, lanesFile, advance } = setup({ titleOf: async () => '' });
    writeLanes(lanesFile, [{ id: `app:${pid}`, vad: '' }]);
    engine.start();
    const feed = captures[0].feed;
    for (let i = 0; i < 20; i += 1) {
      advance(20);
      feed(frame());
    }
    advance(200);
    await sleep(40);
    expect(ship.mock.calls[0][0].target).toBe(`应用 ${pid}`);
    engine.dispose();
  });

  it('自己在播放时听到的块直接丢掉', async () => {
    let busy = true;
    const { engine, captures, ship, lanesFile, advance } = setup({ busy: () => busy });
    writeLanes(lanesFile, [{ id: 'system', vad: '' }]);
    engine.start();
    const feed = captures[0].feed;
    for (let i = 0; i < 20; i += 1) {
      advance(20);
      feed(frame());
    }
    advance(200);
    await sleep(40);
    expect(ship).not.toHaveBeenCalled();

    busy = false;
    for (let i = 0; i < 20; i += 1) {
      advance(20);
      feed(frame());
    }
    advance(200);
    await sleep(40);
    expect(ship).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it('取消勾选就停下这一路，收尾那块也交出去', async () => {
    const { engine, captures, lanesFile, advance } = setup();
    writeLanes(lanesFile, [{ id: 'system', vad: '' }]);
    engine.start();
    const feed = captures[0].feed;
    for (let i = 0; i < 10; i += 1) {
      advance(20);
      feed(frame());
    }
    writeLanes(lanesFile, []);
    engine.sync();
    expect(captures[0].stopped).toBe(1);
    expect(engine.listening).toBe(false);
    await sleep(40);
    expect(engine.views()).toHaveLength(0);
    engine.dispose();
  });

  it('电平随帧更新，停下后按 30dB/秒 回落', () => {
    const { engine, captures, lanesFile, advance } = setup();
    writeLanes(lanesFile, [{ id: 'system', vad: '' }]);
    engine.start();
    const feed = captures[0].feed;
    advance(20);
    feed(frame());
    const first = engine.views()[0].level;
    expect(first).toBeGreaterThan(-40);
    advance(1000);
    const later = engine.views()[0].level;
    expect(later).toBeLessThan(first - 20);
    engine.dispose();
  });

  it('pause 停下采集但保留勾选，start 按勾选恢复', () => {
    const { engine, captures, lanesFile } = setup();
    writeLanes(lanesFile, [{ id: 'system', vad: '' }]);
    engine.start();
    expect(captures).toHaveLength(1);
    engine.stop();
    expect(captures[0].stopped).toBe(1);
    expect(engine.isPaused).toBe(true);
    expect(readLanes(lanesFile)).toHaveLength(1);
    engine.start();
    expect(captures).toHaveLength(2);
    expect(engine.isPaused).toBe(false);
    engine.dispose();
  });

  it('应用 PID 不在了就不开这一路，给出说明', () => {
    const { engine, lanesFile } = setup();
    engine.stop(); // 先停掉，避免挂载时真的去开系统声音
    writeLanes(lanesFile, [{ id: 'app:4000001', vad: '' }]);
    engine.start();
    const [lane] = engine.views();
    expect(lane.listening).toBe(false);
    expect(lane.error).toContain('进程不在了');
    engine.dispose();
  });

  it('流式转文本缺模型时不开采集，并指出去依赖页获取', () => {
    const { engine, lanesFile, cfg } = setup({ realSegmenter: true });
    cfg.listen.vad.kind = 'stream';
    writeLanes(lanesFile, [{ id: 'system', vad: 'stream' }]);
    engine.start();
    const [lane] = engine.views();
    expect(lane.listening).toBe(false);
    expect(lane.error).toContain('Paraformer 流式模型还没下载');
    engine.dispose();
  });

  it('流式来源自带的正文直接进块，不再调用整段转写', async () => {
    const transcribe = vi.fn(async () => '不该调用');
    let sent = false;
    const streamer: Segmenter = {
      kind: 'stream',
      dropped: 0,
      level: -20,
      active: true,
      configure: () => {},
      tick: () => [],
      flush: () => [],
      push: (_frame: Int16Array, at: number): Utterance[] => {
        if (sent) return [];
        sent = true;
        return [{
          pcm: new Int16Array(320 * 10),
          startAt: at - 180,
          durationMs: 200,
          forced: false,
          peakDb: -20,
          text: '流式出来的句子',
        }];
      },
    };
    const { engine, captures, ship, lanesFile, advance } = setup({ transcribe, segmenter: () => streamer });
    writeLanes(lanesFile, [{ id: 'system', vad: 'stream' }]);
    engine.start();
    expect(captures[0].target).toEqual({ source: 'system' });
    advance(20);
    captures[0].feed(frame());
    await sleep(40);
    expect(ship).toHaveBeenCalledTimes(1);
    expect(ship.mock.calls[0][1]).toBe('流式出来的句子');
    expect(transcribe).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('流式来源不做细分：AED 不调用，正文照收', async () => {
    const classify = vi.fn(async () => ({ label: 'music' as const }));
    let sent = false;
    const streamer: Segmenter = {
      kind: 'stream',
      dropped: 0,
      level: -20,
      active: true,
      configure: () => {},
      tick: () => [],
      flush: () => [],
      push: (_frame: Int16Array, at: number): Utterance[] => {
        if (sent) return [];
        sent = true;
        return [{ pcm: new Int16Array(320 * 10), startAt: at - 180, durationMs: 200, forced: false, peakDb: -20, text: '流式的句子' }];
      },
    };
    const { engine, cfg, captures, ship, lanesFile, advance } = setup({ classify, segmenter: () => streamer });
    cfg.listen.classify = 'aed';
    writeLanes(lanesFile, [{ id: 'system', vad: 'stream' }]);
    engine.start();
    advance(20);
    captures[0].feed(frame());
    await sleep(40);
    expect(classify).not.toHaveBeenCalled();
    expect(ship.mock.calls[0][1]).toBe('流式的句子');
    expect(ship.mock.calls[0][2].aedLabel).toBe('');
    engine.dispose();
  });

  it('FireRed 缺模型时不开采集，并指出去依赖页获取', () => {
    const { engine, lanesFile, cfg } = setup({ realSegmenter: true });
    cfg.listen.vad.kind = 'firered';
    writeLanes(lanesFile, [{ id: 'system', vad: 'firered' }]);
    engine.start();
    const [lane] = engine.views();
    expect(lane.listening).toBe(false);
    expect(lane.error).toContain('FireRed 模型还没下载');
    engine.dispose();
  });

  it('细分选 AED 时，音乐块不转写，只交描述与标签', async () => {
    const transcribe = vi.fn(async () => '不该调用');
    const { engine, cfg, captures, ship, lanesFile, advance } = setup({
      transcribe,
      classify: async () => ({ label: 'music' }),
    });
    cfg.listen.classify = 'aed';
    writeLanes(lanesFile, [{ id: 'system', vad: '' }]);
    engine.start();
    const feed = captures[0].feed;
    for (let i = 0; i < 20; i += 1) {
      advance(20);
      feed(frame());
    }
    advance(200);
    await sleep(60);
    expect(ship).toHaveBeenCalledTimes(1);
    expect(ship.mock.calls[0][1]).toBe('');
    expect(ship.mock.calls[0][2].aedLabel).toBe('音乐');
    expect(transcribe).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('不认识的切分方式报出方向，不偷偷退回能量门限', () => {
    const { engine, lanesFile, cfg } = setup({ realSegmenter: true });
    cfg.listen.vad.kind = 'weird';
    writeLanes(lanesFile, [{ id: 'system', vad: 'weird' }]);
    engine.start();
    const [lane] = engine.views();
    expect(lane.listening).toBe(false);
    expect(lane.error).toContain('不认识的切分方式');
    engine.dispose();
  });
});

describe('能量切分器', () => {
  const params: VadParams = {
    kind: 'energy',
    threshold: 0.5,
    thresholdDb: -40,
    minSpeechMs: 60,
    minSilenceMs: 100,
    maxUtteranceMs: 400,
    minUtteranceMs: 100,
  };

  it('开口、收尾与强切', () => {
    const seg = new EnergySegmenter(params);
    let at = 0;
    const out = [];
    // 说 500ms：够到 400ms 上限强切一次。
    for (let i = 0; i < 25; i += 1) {
      at += 20;
      out.push(...seg.push(frame(), at));
    }
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].forced).toBe(true);
    expect(out[0].durationMs).toBeGreaterThanOrEqual(400);

    // 再喂 200ms 静音帧收尾。
    for (let i = 0; i < 10; i += 1) {
      at += 20;
      out.push(...seg.push(frame(0), at));
    }
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it('没有新帧时 tick 也算静音', () => {
    const seg = new EnergySegmenter(params);
    const out: unknown[] = [];
    for (let i = 0; i < 10; i += 1) out.push(...seg.push(frame(), 1000 + i * 20));
    expect(out).toHaveLength(0);
    const tail = seg.tick(2000);
    expect(tail).toHaveLength(1);
    expect(seg.active).toBe(false);
  });

  it('太短的片段丢掉', () => {
    const seg = new EnergySegmenter({ ...params, minUtteranceMs: 300 });
    let at = 0;
    for (let i = 0; i < 8; i += 1) {
      at += 20;
      seg.push(frame(), at);
    }
    const tail = seg.tick(at + 500);
    expect(tail).toHaveLength(0);
    expect(seg.dropped).toBe(1);
  });
});
