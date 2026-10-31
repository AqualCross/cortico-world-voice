/**
 * 切分（VAD）：把连续采集帧切成一块块「有人在说」的音频。
 *
 * 两种形状相同：`push(frame, atMs)` 喂帧、`tick(nowMs)` 走墙上时钟、`flush()` 收尾；
 * 返回的都是完整的语音块。差别只在判据：
 * - energy：看这一帧的 RMS 电平（dBFS）是否过门限；不用模型，零依赖。
 * - silero：看 sherpa-onnx 里 silero 模型给的概率（0–1）；音乐、提示音里更稳。
 *
 * 环回在安静时不送帧，所以「说完了」不能只数静音帧：`tick()` 把「一段时间没有新帧」
 * 也算静音。麦克风一直有帧，两种判据都照常工作。
 */
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FRAME_MS } from './capture.ts';
import { joinInt16, peakDb, peakOfFrames, rmsDb } from './pcm.ts';
import { StreamSegmenter, paraformerReady } from './stream-asr.ts';
import { FIRERED_CMVN_FILE, FIRERED_MODEL_FILE, FireRedSegmenter, fireRedReady } from './firered.ts';

const require = createRequire(import.meta.url);

/** 开口之前多带一段，避免把第一个字切掉（只对能源门限有意义）。 */
const PRE_ROLL_MS = 240;
/** 模型最小合理体积；比它小多半是半个文件或错误页。 */
const SILERO_MIN_BYTES = 100_000;

export interface Utterance {
  /** 16 kHz 单声道 PCM16。 */
  pcm: Int16Array;
  /** 第一帧的墙上时钟时间戳（毫秒，与 push 的 atMs 同基准）。 */
  startAt: number;
  durationMs: number;
  /** 说得太长被强切，而不是自然收尾。 */
  forced: boolean;
  peakDb: number;
  /** 流式识别已经给出的正文；VAD 切出来的块没有这一项，交给上层再转写。 */
  text?: string;
}

export interface VadParams {
  kind: string;
  /** 神经 VAD 的概率门限 0–1。 */
  threshold: number;
  /** 能量门限的 dBFS。 */
  thresholdDb: number;
  minSpeechMs: number;
  minSilenceMs: number;
  maxUtteranceMs: number;
  minUtteranceMs: number;
}

export interface Segmenter {
  readonly kind: string;
  /** 最近一帧的电平（dBFS）；面板的电平条读它。 */
  readonly level: number;
  /** 此刻是否正在说。 */
  readonly active: boolean;
  /** 太短被丢掉的片段数。 */
  readonly dropped: number;
  /** true = push/tick 只入队，结果经 subscribe 的回调交付（ONNX 推理是异步的）。 */
  readonly async?: boolean;
  /** 异步切分器注册交付与失败回调。 */
  subscribe?(deliver: (utterance: Utterance) => void, onFail: (err: Error) => void): void;
  push(frame: Int16Array, atMs: number): Utterance[];
  tick(nowMs: number): Utterance[];
  flush(): Utterance[] | Promise<Utterance[]>;
  configure(params: VadParams): void;
}

/** 一帧的 RMS 电平（dBFS）；全零帧记 -100。 */
export { rmsDb, peakDb };
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(Number(v) || 0, lo), hi);

/**
 * 能量门限切分器。
 * - 闲置：留一小段 preRoll；连续过门限累计到 `minSpeechMs` 才算开口。
 * - 说中：攒帧；静音（低于门限的帧，或没有帧）到 `minSilenceMs` 收尾；
 *   攒满 `maxUtteranceMs` 强切，然后接着收下一段。
 * - 短于 `minUtteranceMs` 的片段丢掉。
 */
export class EnergySegmenter implements Segmenter {
  readonly kind = 'energy';
  dropped = 0;
  lastDb = -100;
  lastFrameAt = -1;
  private preRoll: Int16Array[] = [];
  private collected: Int16Array[] = [];
  private speaking = false;
  private aboveMs = 0;
  private belowMs = 0;
  private startAt = 0;
  private params: VadParams;

  constructor(params: VadParams) {
    this.params = params;
  }

  get level(): number {
    return this.lastDb;
  }

  get active(): boolean {
    return this.speaking;
  }

  get heldMs(): number {
    return this.collected.length * FRAME_MS;
  }

  configure(params: VadParams): void {
    this.params = params;
  }

  push(frame: Int16Array, atMs: number): Utterance[] {
    const db = rmsDb(frame);
    this.lastDb = db;
    const loud = db >= this.params.thresholdDb;
    const out: Utterance[] = [];

    // 久违的帧（安静期环回没有包送来）：把上辈子的计数清掉。
    if (this.lastFrameAt >= 0 && atMs - this.lastFrameAt > this.params.minSilenceMs) {
      this.aboveMs = 0;
    }
    this.lastFrameAt = atMs;

    if (!this.speaking) {
      this.preRoll.push(frame);
      const keep = Math.max(1, Math.ceil(PRE_ROLL_MS / FRAME_MS));
      while (this.preRoll.length > keep) this.preRoll.shift();
      this.aboveMs = loud ? this.aboveMs + FRAME_MS : 0;
      if (this.aboveMs >= this.params.minSpeechMs) {
        this.speaking = true;
        this.belowMs = 0;
        this.collected = [...this.preRoll];
        this.preRoll = [];
        this.startAt = atMs - (this.collected.length - 1) * FRAME_MS;
      }
      return out;
    }

    this.collected.push(frame);
    this.belowMs = loud ? 0 : this.belowMs + FRAME_MS;

    if (this.belowMs >= this.params.minSilenceMs) {
      const done = this.finish(false);
      if (done) out.push(done);
    } else if (this.heldMs >= this.params.maxUtteranceMs) {
      const done = this.finish(true);
      if (done) out.push(done);
      // 强切之后照旧在「说中」：下一段从这里接着收。
      this.speaking = true;
      this.collected = [];
      this.belowMs = 0;
      this.startAt = atMs + FRAME_MS;
    }
    return out;
  }

  /** 墙上时钟：安静够久（没有新帧）就把手上这块收尾。 */
  tick(nowMs: number): Utterance[] {
    const out: Utterance[] = [];
    if (this.speaking && this.lastFrameAt >= 0 && nowMs - this.lastFrameAt >= this.params.minSilenceMs) {
      const done = this.finish(false);
      if (done) out.push(done);
    } else if (!this.speaking && this.aboveMs > 0 && this.lastFrameAt >= 0 && nowMs - this.lastFrameAt > this.params.minSilenceMs) {
      // 起说判定中途没了下文（咳嗽被掐断）：清掉，别攒到下辈子。
      this.aboveMs = 0;
    }
    return out;
  }

  /** 停止采集时把手上这块交出来（够长的话）。 */
  flush(): Utterance[] {
    const done = this.speaking ? this.finish(false) : null;
    this.aboveMs = 0;
    this.belowMs = 0;
    this.preRoll = [];
    return done ? [done] : [];
  }

  private finish(forced: boolean): Utterance | null {
    const frames = this.collected;
    this.collected = [];
    this.speaking = false;
    this.aboveMs = 0;
    const durationMs = frames.length * FRAME_MS;
    if (durationMs < this.params.minUtteranceMs) {
      this.dropped += 1;
      return null;
    }
    return { pcm: joinInt16(frames), startAt: this.startAt, durationMs, forced, peakDb: peakOfFrames(frames) };
  }
}

// ---------------------------------------------------------------------------
// Silero（sherpa-onnx-node）
// ---------------------------------------------------------------------------

interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(copy: boolean): { samples: Float32Array; start: number };
  pop(): void;
  flush(): void;
  isDetected(): boolean;
}

interface SherpaModule {
  Vad: new (cfg: unknown, bufferSeconds: number) => SherpaVad;
}

/** 加载 sherpa-onnx-node；失败时把「装没装」讲成人话。 */
export function loadSherpa(): SherpaModule {
  try {
    return require('sherpa-onnx-node') as SherpaModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`载入 sherpa-onnx-node 失败：${detail}。请在扩展目录里安装依赖后重启应用；只用能量门限（切分方式 energy）不需要它。`);
  }
}

/** 模型在不在：依赖页把 silero_vad.onnx 装在这个目录。 */
export function sileroModelUsable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size >= SILERO_MIN_BYTES;
  } catch {
    return false;
  }
}

/**
 * Silero 切分器。参数热改会重建 VAD（模型重载，短暂空档）；模型本身的脾气是
 * 收尾要「有静音帧」，而环回安静时没有帧，所以 `tick()` 用墙上时钟兜底。
 */
export class SileroSegmenter implements Segmenter {
  readonly kind = 'silero';
  dropped = 0;
  lastDb = -100;
  lastFrameAt = -1;
  private vad: SherpaVad;
  private samplesFed = 0;
  private anchors: Array<{ sample: number; at: number }> = [];
  private baseAt: number;
  private quietFlushed = true;
  private signature = '';
  private params: VadParams;

  constructor(
    params: VadParams,
    private readonly opts: { modelPath: string; loadSherpa?: () => SherpaModule; now?: () => number; log?: { warn?(msg: string, meta?: unknown): void } },
  ) {
    this.params = params;
    this.baseAt = (opts.now ?? Date.now)();
    this.vad = this.create();
    this.signature = this.signatureOf();
  }

  get level(): number {
    return this.lastDb;
  }

  get active(): boolean {
    try {
      return this.vad.isDetected();
    } catch {
      return false;
    }
  }

  configure(params: VadParams): void {
    this.params = params;
    if (this.signatureOf() === this.signature) return;
    try {
      this.vad = this.create();
      this.signature = this.signatureOf();
    } catch (err) {
      this.opts.log?.warn?.('听：silero 参数变了但切分器重建失败', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  push(frame: Int16Array, atMs: number): Utterance[] {
    this.lastDb = rmsDb(frame);
    // 环回会省掉静音包：把恢复后的音频锚回墙上时钟。
    if (!this.anchors.length || atMs - this.lastFrameAt > FRAME_MS * 2) {
      this.anchors.push({ sample: this.samplesFed, at: atMs - (frame.length / 16_000) * 1000 });
    }
    const oldest = this.samplesFed - this.bufferSeconds() * 16_000;
    while (this.anchors.length > 1 && this.anchors[1].sample <= oldest) this.anchors.shift();
    this.lastFrameAt = atMs;
    this.quietFlushed = false;
    const f32 = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i += 1) f32[i] = frame[i] / 32768;
    this.vad.acceptWaveform(f32);
    this.samplesFed += frame.length;
    return this.drain();
  }

  tick(nowMs: number): Utterance[] {
    if (this.quietFlushed || this.lastFrameAt < 0 || nowMs - this.lastFrameAt < this.params.minSilenceMs) return [];
    const out: Utterance[] = [];
    try {
      this.vad.flush();
      out.push(...this.drain());
    } catch (err) {
      this.opts.log?.warn?.('听：silero 收尾时出错', { err: err instanceof Error ? err.message : String(err) });
    }
    this.quietFlushed = true;
    return out;
  }

  flush(): Utterance[] {
    const out: Utterance[] = [];
    try {
      this.vad.flush();
      out.push(...this.drain());
    } catch (err) {
      this.opts.log?.warn?.('听：silero 收尾时出错', { err: err instanceof Error ? err.message : String(err) });
    }
    return out;
  }

  private bufferSeconds(): number {
    return Math.max(30, Math.ceil(this.params.maxUtteranceMs / 1000) + 10);
  }

  private signatureOf(): string {
    const p = this.params;
    return [this.opts.modelPath, clamp(p.threshold, 0.1, 0.9), p.minSpeechMs, p.minSilenceMs, p.maxUtteranceMs].join('|');
  }

  private create(): SherpaVad {
    const sherpa = (this.opts.loadSherpa ?? loadSherpa)();
    if (typeof sherpa?.Vad !== 'function') throw new Error('sherpa-onnx-node 里没有 Vad：版本不符或不完整。');
    const p = this.params;
    this.baseAt = (this.opts.now ?? Date.now)();
    this.samplesFed = 0;
    this.anchors = [];
    return new sherpa.Vad({
      sileroVad: {
        model: this.opts.modelPath,
        threshold: clamp(p.threshold, 0.1, 0.9),
        minSilenceDuration: p.minSilenceMs / 1000,
        minSpeechDuration: p.minSpeechMs / 1000,
        maxSpeechDuration: p.maxUtteranceMs / 1000,
        windowSize: 512,
      },
      sampleRate: 16_000,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    }, this.bufferSeconds());
  }

  private drain(): Utterance[] {
    const out: Utterance[] = [];
    while (!this.vad.isEmpty()) {
      // front(true) 建的是外部缓冲，Electron 的 V8 内存笼禁止；false 让它复制进普通 ArrayBuffer。
      const seg = this.vad.front(false);
      this.vad.pop();
      const samples = seg?.samples;
      if (!samples?.length) continue;
      const durationMs = (samples.length / 16_000) * 1000;
      if (durationMs < this.params.minUtteranceMs) {
        this.dropped += 1;
        continue;
      }
      const pcm = new Int16Array(samples.length);
      let peak = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const v = samples[i];
        pcm[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
      }
      const startSamples = Number(seg.start) || 0;
      let startAt = this.baseAt + (startSamples / 16_000) * 1000;
      for (let i = this.anchors.length - 1; i >= 0; i -= 1) {
        const anchor = this.anchors[i];
        if (anchor.sample <= startSamples) {
          startAt = anchor.at + ((startSamples - anchor.sample) / 16_000) * 1000;
          break;
        }
      }
      out.push({
        pcm,
        startAt,
        durationMs,
        // 够到单块上限的多半是 silero 在 maxSpeechDuration 处强切的。
        forced: durationMs >= this.params.maxUtteranceMs - FRAME_MS,
        peakDb: peak <= 0 ? -100 : Math.max(-100, 20 * Math.log10(peak)),
      });
    }
    return out;
  }
}

export interface SegmenterOptions {
  /** silero 模型路径；模型不在时报错，不偷偷退回能量门限。 */
  sileroModel: string;
  /** Paraformer 流式模型目录（只有切分方式为 stream 时用）。 */
  streamModel?: string;
  /** FireRed 模型目录（fireredvad_stream_vad_with_cache.onnx + cmvn.ark）。 */
  fireRedDir?: string;
  loadSherpa?: () => SherpaModule;
  now?: () => number;
  log?: { warn?(msg: string, meta?: unknown): void };
}

/** 按参数造一个切分器；不认识的类型与缺模型都直接报出方向。 */
export function createSegmenter(params: VadParams, opts: SegmenterOptions): Segmenter {
  if (params.kind === 'energy') return new EnergySegmenter(params);
  if (params.kind === 'silero') {
    if (!existsSync(opts.sileroModel) || !sileroModelUsable(opts.sileroModel)) {
      throw new Error(`Silero VAD 模型还没下载（${opts.sileroModel}）：去「依赖」页对 Silero VAD 点「获取」，或把切分方式改成能量门限。`);
    }
    return new SileroSegmenter(params, {
      modelPath: opts.sileroModel,
      loadSherpa: opts.loadSherpa,
      now: opts.now,
      log: opts.log,
    });
  }
  if (params.kind === 'firered') {
    const dir = opts.fireRedDir ?? '';
    if (!dir || !fireRedReady(dir)) {
      throw new Error(`FireRed 模型还没下载（${dir || '未配置目录'}）：去「依赖」页对「FireRed VAD」点「获取」（约 2.3 MB）。`);
    }
    return new FireRedSegmenter(params, {
      modelPath: join(dir, FIRERED_MODEL_FILE),
      cmvnPath: join(dir, FIRERED_CMVN_FILE),
      now: opts.now,
      log: opts.log,
    });
  }
  if (params.kind === 'stream') {
    if (!opts.streamModel) throw new Error('流式转文本需要 Paraformer 流式模型目录。');
    if (!paraformerReady(opts.streamModel)) {
      throw new Error(`Paraformer 流式模型还没下载（${opts.streamModel}）：去「依赖」页对「Paraformer 流式」点「获取」（约 226 MB）。`);
    }
    return new StreamSegmenter(params, { modelDir: opts.streamModel });
  }
  throw new Error(`不认识的切分方式：${params.kind || '（空）'}。`);
}
