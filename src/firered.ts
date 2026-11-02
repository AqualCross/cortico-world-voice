/**
 * FireRed VAD（小红书开源的 DFSMN VAD，Apache-2.0）：16k、10ms 一帧，
 * 输入是 80 维 kaldi fbank（CMVN 后），模型约 2.3 MB，直接跑 ONNX。
 *
 * onnxruntime-node 只有异步 `run`，所以这里和 VAD 切分器形状一致、但交付是回调：
 * `push()` 只入队，结果经 `subscribe` 交给上层的交付回调。顺序由一条 promise 链
 * 保证——建会话、每一批推理、收尾都排在同一个队列里。
 *
 * 断句逻辑照官方 StreamVadPostprocessor 移植：平滑、概率门限、最短语音/静音、最长段。
 */
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FRAME_MS } from './capture.ts';
import { KaldiFbank, applyCmvn, cmvnFromMatrix, parseCmvnMatrix, type Cmvn } from './fbank.ts';
import { peakDb, rmsDb } from './pcm.ts';
import type { Segmenter, Utterance, VadParams } from './vad.ts';

const require = createRequire(import.meta.url);

export const FIRERED_MODEL_FILE = 'fireredvad_stream_vad_with_cache.onnx';
export const FIRERED_CMVN_FILE = 'cmvn.ark';
const MODEL_MIN_BYTES = 1_000_000;
const CMVN_MIN_BYTES = 500;

const SAMPLE_RATE = 16_000;
const FBANK_SHIFT = 160; // 10ms @ 16k
const CACHE_SHAPE = [8, 1, 128, 19] as const;
const CACHE_SIZE = CACHE_SHAPE.reduce<number>((a, b) => a * b, 1);

export interface OrtTensor {
  data: Float32Array;
}

export interface OrtSession {
  run(inputs: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}

export interface OrtModule {
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor;
  InferenceSession: { create(path: string): Promise<OrtSession> };
}

/** 加载 ONNX 运行时；失败时讲清楚装没装。 */
export function loadOnnxRuntime(): OrtModule {
  try {
    return require('onnxruntime-node') as OrtModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`载入 onnxruntime-node 失败：${detail}。FireRed 切分与 AED 需要它；请在扩展目录里安装依赖后重启应用，或改用 silero / energy。`);
  }
}

let ortLoaded = false;

/** onnxruntime-node 能不能加载。成功一次就记下；失败每次重试，装好依赖重挂 World 后即可恢复。 */
export function onnxRuntimeStatus(): { ok: boolean; detail: string | null } {
  if (ortLoaded) return { ok: true, detail: null };
  try {
    loadOnnxRuntime();
    ortLoaded = true;
    return { ok: true, detail: null };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** 模型与 CMVN 都在（按最小体积挡半个文件）。 */
export function fireRedReady(dir: string): boolean {
  try {
    if (statSync(join(dir, FIRERED_MODEL_FILE)).size < MODEL_MIN_BYTES) return false;
    if (statSync(join(dir, FIRERED_CMVN_FILE)).size < CMVN_MIN_BYTES) return false;
    return true;
  } catch {
    return false;
  }
}

/** 官方 StreamVadPostprocessor 的移植：平滑、概率门限、最短语音/静音、最长段。 */
export class StreamVadPostprocessor {
  private frameCountValue = 0;
  private window: number[] = [];
  private windowSum = 0;
  private state = 0; // 0 silence, 1 possible speech, 2 speech, 3 possible silence
  private speechCnt = 0;
  private silenceCnt = 0;
  private hitMax = false;
  private lastStartFrame = -1;
  private lastEndFrame = -1;
  private readonly smoothWindowSize: number;
  private readonly padStartFrame: number;
  private readonly threshold: number;
  private readonly minSpeechFrame: number;
  private readonly maxSpeechFrame: number;
  private readonly minSilenceFrame: number;

  constructor({ smoothWindowSize = 5, threshold = 0.5, padStartFrame = 5, minSpeechFrame = 8, maxSpeechFrame = 2000, minSilenceFrame = 20 } = {}) {
    this.smoothWindowSize = Math.max(1, smoothWindowSize);
    this.threshold = threshold;
    this.padStartFrame = Math.max(this.smoothWindowSize, padStartFrame);
    this.minSpeechFrame = minSpeechFrame;
    this.maxSpeechFrame = maxSpeechFrame;
    this.minSilenceFrame = minSilenceFrame;
  }

  get frameCount(): number {
    return this.frameCountValue;
  }

  reset(): void {
    this.frameCountValue = 0;
    this.window = [];
    this.windowSum = 0;
    this.state = 0;
    this.speechCnt = 0;
    this.silenceCnt = 0;
    this.hitMax = false;
    this.lastStartFrame = -1;
    this.lastEndFrame = -1;
  }

  get active(): boolean {
    return this.state === 2 || this.state === 3;
  }

  private smooth(prob: number): number {
    if (this.smoothWindowSize <= 1) return prob;
    this.window.push(prob);
    this.windowSum += prob;
    if (this.window.length > this.smoothWindowSize) this.windowSum -= this.window.shift()!;
    return this.windowSum / this.window.length;
  }

  process(rawProb: number): { isStart: boolean; isEnd: boolean; startFrame: number; endFrame: number } {
    this.frameCountValue += 1;
    const smoothed = this.smooth(rawProb);
    const isSpeech = smoothed >= this.threshold;
    const result = { isStart: false, isEnd: false, startFrame: -1, endFrame: -1 };

    if (this.hitMax) {
      result.isStart = true;
      result.startFrame = this.frameCountValue;
      this.lastStartFrame = result.startFrame;
      this.hitMax = false;
    }

    if (this.state === 0) {
      if (isSpeech) {
        this.state = 1;
        this.speechCnt += 1;
      } else {
        this.silenceCnt += 1;
        this.speechCnt = 0;
      }
    } else if (this.state === 1) {
      if (isSpeech) {
        this.speechCnt += 1;
        if (this.speechCnt >= this.minSpeechFrame) {
          this.state = 2;
          result.isStart = true;
          result.startFrame = Math.max(
            1,
            this.frameCountValue - this.speechCnt + 1 - this.padStartFrame,
            this.lastEndFrame + 1,
          );
          this.lastStartFrame = result.startFrame;
          this.silenceCnt = 0;
        }
      } else {
        this.state = 0;
        this.silenceCnt = 1;
        this.speechCnt = 0;
      }
    } else if (this.state === 2) {
      this.speechCnt += 1;
      if (isSpeech) {
        this.silenceCnt = 0;
        if (this.speechCnt >= this.maxSpeechFrame) {
          this.hitMax = true;
          this.speechCnt = 0;
          result.isEnd = true;
          result.endFrame = this.frameCountValue;
          result.startFrame = this.lastStartFrame;
          this.lastStartFrame = -1;
          this.lastEndFrame = result.endFrame;
        }
      } else {
        this.state = 3;
        this.silenceCnt += 1;
      }
    } else {
      this.speechCnt += 1;
      if (isSpeech) {
        this.state = 2;
        this.silenceCnt = 0;
        if (this.speechCnt >= this.maxSpeechFrame) {
          this.hitMax = true;
          this.speechCnt = 0;
          result.isEnd = true;
          result.endFrame = this.frameCountValue;
          result.startFrame = this.lastStartFrame;
          this.lastStartFrame = -1;
          this.lastEndFrame = result.endFrame;
        }
      } else {
        this.silenceCnt += 1;
        if (this.silenceCnt >= this.minSilenceFrame) {
          this.state = 0;
          result.isEnd = true;
          result.endFrame = this.frameCountValue;
          result.startFrame = this.lastStartFrame;
          this.lastEndFrame = result.endFrame;
          this.lastStartFrame = -1;
          this.speechCnt = 0;
        }
      }
    }
    return result;
  }
}

export interface FireRedOptions {
  modelPath: string;
  cmvnPath?: string;
  /** 测试用：直接给 CMVN，省掉读文件。 */
  cmvn?: Cmvn;
  /** 测试用：替换 ONNX 运行时与会话。 */
  ort?: OrtModule;
  session?: OrtSession;
  now?: () => number;
  log?: { warn?(msg: string, meta?: unknown): void };
}

/**
 * FireRed 流式切分器。异步：`push()` 入队，结果经 `subscribe` 的回调出来。
 * 与同步切分器同一个形状，引擎按 `async` 标记走回调路径。
 */
export class FireRedSegmenter implements Segmenter {
  readonly kind = 'firered';
  readonly async = true;
  dropped = 0;
  lastDb = -100;
  lastFrameAt = -1;
  private params: VadParams;
  private deliver: ((utterance: Utterance) => void) | null = null;
  private fail: ((err: Error) => void) | null = null;
  private readonly opts: FireRedOptions;
  private ort: OrtModule | null = null;
  private session: OrtSession | null = null;
  private readonly cmvn: Cmvn;
  private readonly fbank = new KaldiFbank();
  private post: StreamVadPostprocessor;
  private caches = new Float32Array(CACHE_SIZE);
  private quietFlushed = true;
  private chain: Promise<unknown>;
  private pcm: Array<{ start: number; pcm: Int16Array }> = [];
  private anchors: Array<{ sample: number; at: number }> = [];
  private samplesFed = 0;
  private frameOffset = 0;
  private segStart = -1;
  private speaking = false;
  private readonly now: () => number;

  constructor(params: VadParams, opts: FireRedOptions) {
    this.params = params;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.ort = opts.ort ?? null;
    this.session = opts.session ?? null;
    this.cmvn = opts.cmvn ?? cmvnFromMatrix(parseCmvnMatrix(readFileSync(opts.cmvnPath ?? '')));
    this.post = this.postFor();
    this.chain = (async () => {
      if (this.session && this.ort) return;
      const ort = opts.ort ?? loadOnnxRuntime();
      const session = await ort.InferenceSession.create(opts.modelPath);
      this.ort = ort;
      this.session = session;
    })();
    this.chain = this.chain.catch((err) => this.failed(err));
  }

  get level(): number {
    return this.lastDb;
  }

  get active(): boolean {
    return this.speaking;
  }

  subscribe(deliver: (utterance: Utterance) => void, onFail: (err: Error) => void): void {
    this.deliver = deliver;
    this.fail = onFail;
  }

  configure(params: VadParams): void {
    const changed = params.threshold !== this.params.threshold
      || params.minSpeechMs !== this.params.minSpeechMs
      || params.minSilenceMs !== this.params.minSilenceMs
      || params.maxUtteranceMs !== this.params.maxUtteranceMs
      || params.minUtteranceMs !== this.params.minUtteranceMs;
    this.params = params;
    if (!changed) return;
    // 热改只换后处理与缓存，模型本体不动；手上这半句丢掉。
    this.chain = this.chain.then(() => {
      this.post = this.postFor();
      this.resetStream();
    }).catch((err) => this.failed(err));
  }

  push(frame: Int16Array, atMs: number): Utterance[] {
    if (!frame?.length) return [];
    this.lastDb = rmsDb(frame);
    if (!this.anchors.length || atMs - this.lastFrameAt > FRAME_MS * 2) {
      this.anchors.push({ sample: this.samplesFed, at: atMs - (frame.length / SAMPLE_RATE) * 1000 });
    }
    const oldest = this.samplesFed - this.bufferSamples();
    while (this.anchors.length > 1 && this.anchors[1].sample <= oldest) this.anchors.shift();
    this.lastFrameAt = atMs;
    this.quietFlushed = false;

    this.pcm.push({ start: this.samplesFed, pcm: Int16Array.from(frame) });
    this.samplesFed += frame.length;

    const feats = this.fbank.accept(frame);
    if (!feats.length) return [];
    for (const feat of feats) applyCmvn(feat, this.cmvn, feat);
    const data = new Float32Array(feats.length * 80);
    feats.forEach((feat, i) => {
      for (let k = 0; k < feat.length; k += 1) data[i * 80 + k] = feat[k];
    });

    this.chain = this.chain.then(() => this.infer(data, feats.length)).catch((err) => this.failed(err));
    return [];
  }

  /** 没有新帧时的墙上时钟收尾（环回安静时不送帧）。 */
  tick(nowMs: number): Utterance[] {
    if (this.quietFlushed || this.lastFrameAt < 0) return [];
    if (nowMs - this.lastFrameAt < this.params.minSilenceMs) return [];
    this.quietFlushed = true;
    this.chain = this.chain.then(() => {
      if (this.segStart > 0) this.emit(this.segStart, this.fbank.frameCount, false);
      this.resetStream();
    }).catch((err) => this.failed(err));
    return [];
  }

  /** 停止时把手上这段交出来；等队列清空。 */
  async flush(): Promise<Utterance[]> {
    this.chain = this.chain.then(() => {
      if (this.segStart > 0) this.emit(this.segStart, this.fbank.frameCount, false);
      this.resetStream();
    }).catch((err) => this.failed(err));
    await this.chain;
    return [];
  }

  /** 等推理队列走完（测试与停止时用）。 */
  async whenIdle(): Promise<void> {
    await this.chain;
  }

  private postFor(): StreamVadPostprocessor {
    return new StreamVadPostprocessor({
      smoothWindowSize: 5,
      threshold: Math.min(Math.max(this.params.threshold, 0.1), 0.9),
      padStartFrame: 5,
      minSpeechFrame: Math.max(1, Math.round(this.params.minSpeechMs / FRAME_MS)),
      maxSpeechFrame: Math.max(1, Math.round(this.params.maxUtteranceMs / FRAME_MS)),
      minSilenceFrame: Math.max(1, Math.round(this.params.minSilenceMs / FRAME_MS)),
    });
  }

  private bufferSamples(): number {
    return Math.max(30, Math.ceil(this.params.maxUtteranceMs / 1000) + 10) * SAMPLE_RATE;
  }

  private async infer(data: Float32Array, frames: number): Promise<void> {
    const ort = this.ort!;
    const session = this.session!;
    const feat = new ort.Tensor('float32', data, [1, frames, 80]);
    const caches = new ort.Tensor('float32', this.caches, CACHE_SHAPE);
    const out = await session.run({ feat, caches_in: caches });
    this.caches = Float32Array.from(out.caches_out.data);
    const probs = out.probs.data;
    for (let i = 0; i < probs.length; i += 1) this.onProb(probs[i]);
  }

  private onProb(prob: number): void {
    const result = this.post.process(prob);
    if (result.isStart) this.segStart = result.startFrame;
    if (result.isEnd) {
      const start = result.startFrame > 0 ? result.startFrame : this.segStart;
      this.emit(start, result.endFrame, (result.endFrame - start) >= Math.round(this.params.maxUtteranceMs / FRAME_MS));
      this.segStart = -1;
    }
    this.speaking = this.post.active;
    // 按「已处理」位置修剪，而不是「已喂入」；推理落后时不丢还没切出来的段。
    const processed = (this.frameOffset + this.post.frameCount) * FBANK_SHIFT;
    const keepFrom = processed - this.bufferSamples();
    while (this.pcm.length && this.pcm[0].start + this.pcm[0].pcm.length <= keepFrom) this.pcm.shift();
    while (this.anchors.length > 1 && this.anchors[1].sample <= keepFrom) this.anchors.shift();
  }

  private emit(startFrame: number, endFrame: number, forced: boolean): void {
    if (startFrame <= 0 || endFrame <= startFrame) return;
    const startSample = (this.frameOffset + startFrame - 1) * FBANK_SHIFT;
    const endSample = (this.frameOffset + endFrame) * FBANK_SHIFT;
    const pcm = this.slice(startSample, endSample);
    if (!pcm.length) return;
    const durationMs = (pcm.length / SAMPLE_RATE) * 1000;
    if (durationMs < this.params.minUtteranceMs) {
      this.dropped += 1;
      return;
    }
    let anchor: { sample: number; at: number } | undefined;
    for (let i = this.anchors.length - 1; i >= 0; i -= 1) {
      if (this.anchors[i].sample <= startSample) {
        anchor = this.anchors[i];
        break;
      }
    }
    const startAt = anchor
      ? anchor.at + ((startSample - anchor.sample) / SAMPLE_RATE) * 1000
      : this.now() - ((this.samplesFed - startSample) / SAMPLE_RATE) * 1000;
    this.deliver?.({ pcm, startAt, durationMs, forced, peakDb: peakDb(pcm) });
  }

  private slice(startSample: number, endSample: number): Int16Array {
    const a = Math.max(0, Math.round(startSample));
    const b = Math.max(a, Math.round(endSample));
    const out = new Int16Array(Math.max(0, b - a));
    let at = 0;
    for (const chunk of this.pcm) {
      const cs = chunk.start;
      const ce = cs + chunk.pcm.length;
      if (ce <= a || cs >= b) continue;
      const from = Math.max(a, cs) - cs;
      const to = Math.min(b, ce) - cs;
      out.set(chunk.pcm.subarray(from, to), at);
      at += to - from;
    }
    return at === out.length ? out : out.subarray(0, at);
  }

  private resetStream(): void {
    this.frameOffset += this.fbank.frameCount;
    this.fbank.reset();
    this.post = this.postFor();
    this.caches = new Float32Array(CACHE_SIZE);
    this.segStart = -1;
    this.speaking = false;
    this.pcm = [];
    this.anchors = [];
  }

  private failed(err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    this.opts.log?.warn?.('听：FireRed 推理出错', { err: detail });
    try {
      this.fail?.(err instanceof Error ? err : new Error(detail));
    } catch {
      // 回调自己出错就吞掉。
    }
    this.resetStream();
  }
}
