/**
 * 流式识别：sherpa-onnx `OnlineRecognizer` + Paraformer 中英流式模型。
 *
 * 这一路不做 VAD：16 kHz 的帧直接喂引擎，引擎只负责解码；断句由这里按帧电平判断
 * ——连续低于「能量门限」达到「最短静音」就算一句说完（sherpa 自带的端点是「多久没
 * 解出新字」，连续说话时会把句子切碎，所以关掉它）。一句一条记录，正文随块给出。
 *
 * 环回在安静时不送帧，所以 `tick()` 用墙上时钟补静音帧：按真实时间一帧一帧地补，
 * 补出来的静音同样计入断句判定。
 *
 * 与 VAD 切分器同一个形状（`push` / `tick` / `flush` / `configure`），只是切出来的
 * 块自带 `text`，上层不再调用整段转写。
 */
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FRAME_MS } from './capture.ts';
import { joinInt16, peakOfFrames, rmsDb } from './pcm.ts';
import type { Segmenter, Utterance, VadParams } from './vad.ts';

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320;
/** 模型文件的体积下限：挡住下载了一半的文件。 */
const MIN_BYTES: ReadonlyArray<[file: string, bytes: number]> = [
  ['encoder.int8.onnx', 100_000_000],
  ['decoder.int8.onnx', 40_000_000],
  ['tokens.txt', 10_000],
];
/** 补静音时一次最多算多长：更长的安静没必要都喂进去。 */
const MAX_SILENCE_MS = 2000;
const SILENCE_FRAME = new Int16Array(FRAME_SAMPLES);

export interface SherpaOnlineStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
}

export interface SherpaOnlineRecognizer {
  createStream(): SherpaOnlineStream;
  isReady(stream: SherpaOnlineStream): boolean;
  decode(stream: SherpaOnlineStream): void;
  isEndpoint(stream: SherpaOnlineStream): boolean;
  reset(stream: SherpaOnlineStream): void;
  getResult(stream: SherpaOnlineStream): { text?: string };
}

export interface SherpaOnlineModule {
  OnlineRecognizer: new (config: unknown) => SherpaOnlineRecognizer;
}

/** 加载 sherpa 的流式识别；失败时把「装没装」讲成人话。 */
export function loadSherpaOnline(): SherpaOnlineModule {
  try {
    return require('sherpa-onnx-node') as SherpaOnlineModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`载入 sherpa-onnx-node 失败：${detail}。请在扩展目录里安装依赖后重启应用。`);
  }
}

/** Paraformer 流式模型在不在（三个文件、按最小体积挡半个文件）。 */
export function paraformerReady(dir: string): boolean {
  for (const [file, min] of MIN_BYTES) {
    try {
      if (statSync(join(dir, file)).size < min) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface StreamOptions {
  modelDir: string;
  load?: () => SherpaOnlineModule;
  threads?: number;
}

/**
 * 流式切分器：`push` 返回已经定稿的句子（可能 0 句），`tick` 负责在没有新帧时
 * 补静音把端点推出来。
 */
export class StreamSegmenter implements Segmenter {
  readonly kind = 'stream';
  dropped = 0;
  private params: VadParams;
  private rec: SherpaOnlineRecognizer;
  private stream: SherpaOnlineStream;
  private frames: Int16Array[] = [];
  private bufferedMs = 0;
  private startAt = 0;
  private lastDb = -100;
  private lastFrameAt = -1;
  private silenceFedMs = 0;
  /** 连续低于能量门限的时长；够了就断句。 */
  private silentMs = 0;
  private text = '';
  private readonly load: () => SherpaOnlineModule;

  constructor(params: VadParams, private readonly opts: StreamOptions) {
    this.params = params;
    this.load = opts.load ?? loadSherpaOnline;
    this.rec = this.create();
    this.stream = this.rec.createStream();
  }

  get level(): number {
    return this.lastDb;
  }

  /** 引擎已经解出字，就算「正在说」。 */
  get active(): boolean {
    return this.text.length > 0;
  }

  configure(params: VadParams): void {
    // 断句与强切都由本类按帧电平判断，改参数不用重建识别器，也不用丢手上这半句。
    this.params = params;
  }

  push(frame: Int16Array, atMs: number): Utterance[] {
    const db = rmsDb(frame);
    this.lastDb = db;
    this.lastFrameAt = atMs;
    if (!this.frames.length) this.startAt = atMs;
    this.frames.push(frame);
    this.bufferedMs += FRAME_MS;
    this.silenceFedMs = 0;
    this.silentMs = db < this.params.thresholdDb ? this.silentMs + FRAME_MS : 0;
    this.feed(frame);
    return this.drain();
  }

  tick(nowMs: number): Utterance[] {
    if (!this.frames.length || this.lastFrameAt < 0) return [];
    const gap = nowMs - this.lastFrameAt - this.silenceFedMs;
    if (gap < FRAME_MS * 2) return [];
    const budget = Math.min(gap, MAX_SILENCE_MS);
    for (let fed = 0; fed + FRAME_MS <= budget; fed += FRAME_MS) {
      this.feed(SILENCE_FRAME);
      this.silenceFedMs += FRAME_MS;
      this.bufferedMs += FRAME_MS;
      this.silentMs += FRAME_MS;
    }
    return this.drain();
  }

  /** 停止采集：把手上这句交出来（引擎已经解出的字照用）。 */
  flush(): Utterance[] {
    if (!this.frames.length) return [];
    return this.finish(false);
  }

  private drain(): Utterance[] {
    if (this.text && this.silentMs >= this.params.minSilenceMs) return this.finish(false);
    if (this.bufferedMs >= this.params.maxUtteranceMs) return this.finish(true);
    return [];
  }

  private feed(frame: Int16Array): void {
    const f32 = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i += 1) f32[i] = frame[i] / 32768;
    this.stream.acceptWaveform({ samples: f32, sampleRate: SAMPLE_RATE });
    while (this.rec.isReady(this.stream)) this.rec.decode(this.stream);
    this.text = (this.rec.getResult(this.stream).text ?? '').trim();
  }

  private finish(forced: boolean): Utterance[] {
    const frames = this.frames;
    const durationMs = this.bufferedMs;
    const startAt = this.startAt;
    const text = this.text;
    this.frames = [];
    this.bufferedMs = 0;
    this.text = '';
    this.silenceFedMs = 0;
    this.silentMs = 0;
    this.lastDb = -100;
    try {
      this.rec.reset(this.stream);
    } catch {
      // 引擎在错误态里时 reset 可能抛；这句就当结束了。
    }
    // 没解出字（纯音乐、噪声）或太短：只计数，不落记录。
    if (!frames.length || !text || durationMs < this.params.minUtteranceMs) {
      if (frames.length) this.dropped += 1;
      return [];
    }
    return [{ pcm: joinInt16(frames), startAt, durationMs, forced, peakDb: peakOfFrames(frames), text }];
  }

  private create(): SherpaOnlineRecognizer {
    const mod = this.load();
    if (typeof mod?.OnlineRecognizer !== 'function') throw new Error('sherpa-onnx-node 里没有 OnlineRecognizer：版本不符或不完整。');
    const dir = this.opts.modelDir;
    const rec = new mod.OnlineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        paraformer: {
          encoder: join(dir, 'encoder.int8.onnx'),
          decoder: join(dir, 'decoder.int8.onnx'),
        },
        tokens: join(dir, 'tokens.txt'),
        numThreads: this.opts.threads ?? 2,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      // 断句由本类按帧电平做（见文件头）：引擎自带的端点是「没解出新字」，连续说话会切碎。
      enableEndpoint: false,
    });
    return rec;
  }
}
