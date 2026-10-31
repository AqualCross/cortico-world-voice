/**
 * 监听：按 `lanes.json` 对账「哪几路在听」，每路一个采集器 + 一个切分器；
 * 切出来的块不落盘，只把描述连同正文交给 World（存转写记录、写 audio.heard）。
 *
 * 车道就是配置：勾选一路 = 开始听这一路，取消 = 停下；`pause()` 只停采集、
 * 保留勾选（工具里的「停止」），`resume()` 按勾选重新开始。
 *
 * 自己正在播放的声音不算「听到」：播放期间切出来的块直接丢掉，免得自己说一句、
 * 听一句、再回一句。
 */
import type { AudioConfigSection } from './config.ts';
import { Capturer, FRAME_MS, captureModuleStatus, type CaptureStatusEvent, type CaptureTarget } from './capture.ts';
import { createSegmenter, type Segmenter, type Utterance, type VadParams } from './vad.ts';
import { readLanes } from './lanes.ts';
import { AED_LABELS } from './firered-aed.ts';

export interface CaptureLike {
  readonly running: boolean;
  start(target: CaptureTarget): void;
  stop(): void;
}

export interface LaneView {
  id: string;
  vad: string;
  source: string;
  app: string;
  pid: number;
  label: string;
  listening: boolean;
  level: number;
  active: boolean;
  frames: number;
  audioMs: number;
  chunks: number;
  error: string;
  lastChunkAt: string;
}

/** 一块听来的声音：不落盘，只把描述交出去。 */
export interface HeardChunk {
  /** 处理完的时刻（本地墙钟串）。 */
  at: string;
  /** 开口时刻（ISO）。 */
  startedAt: string;
  durationMs: number;
  source: string;
  app: string;
  target: string;
  forced: boolean;
  peakDb: number | null;
}

export interface ListenDeps {
  lanesFile: string;
  cfg: () => AudioConfigSection;
  /** silero 模型路径；没下载时启动那一路会报出方向。 */
  sileroModel: () => string;
  /** Paraformer 流式模型目录；切分方式为 stream 的那一路用它。 */
  streamModel: () => string;
  /** FireRed 模型目录（onnx + cmvn.ark）。 */
  fireRedDir: () => string;
  log: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void; debug?(msg: string, meta?: unknown): void };
  /** 转写一段 16k 单声道 PCM；引擎没配好时抛错（那一块就没有正文）。 */
  transcribe: (pcm: Int16Array) => Promise<string>;
  /** 块级细分（FireRed AED）：音乐 / 说话 / 唱歌；没开或不可用时返回 null。 */
  classify?: (pcm: Int16Array) => Promise<{ label: 'speech' | 'singing' | 'music' } | null>;
  /** 一块处理完：描述与正文交出去（存记录、投递）。 */
  ship: (chunk: HeardChunk, text: string, info: { transcribeError: string; aedLabel?: string }) => void | Promise<void>;
  /** 按应用的 PID 查此刻的窗口标题；查不到返回空串。 */
  titleOf?: (pid: number) => Promise<string>;
  /** 我们自己在播放：这段时间听到的差不多是自己的声音。 */
  busy: () => boolean;
  createCapture?: (hooks: { onFrame(frame: Int16Array): void; onStatus(event: CaptureStatusEvent): void }) => CaptureLike;
  createSegmenter?: (params: VadParams) => Segmenter;
  now?: () => number;
  /** 记录时间的写法（本地墙钟串）；不给就用 UTC ISO。 */
  clock?: () => string;
  tickMs?: number;
  aliveCheckMs?: number;
}

interface Lane {
  id: string;
  vad: string;
  source: 'system' | 'app' | 'mic';
  app: string;
  pid: number;
  label: string;
  capture: CaptureLike | null;
  segmenter: Segmenter | null;
  frames: number;
  audioMs: number;
  chunks: number;
  lastFrameAt: number;
  rawLevel: number;
  active: boolean;
  error: string;
  lastChunkAt: string;
}

const LABEL: Record<'system' | 'mic', string> = { system: '系统声音', mic: '麦克风' };
/** 电平条按 30 dB/秒 回落：环回安静时不送帧，读数要自己掉下来。 */
const DECAY_DB_PER_SEC = 30;
const ALIVE_CHECK_MS = 5000;
const TRANSCRIBE_TIMEOUT_MS = 90_000;

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** 车道 id → 采集目标；id 不合形状时报出方向。 */
function targetOf(id: string): CaptureTarget {
  if (id === 'system') return { source: 'system' };
  if (id === 'mic') return { source: 'mic' };
  const pid = Number(/^app:(\d+)$/.exec(id)?.[1] ?? '');
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`不认得的来源：${id}（应当是 system、mic 或 app:<PID>）。`);
  return { source: 'app', pid };
}

export class ListenEngine {
  private lanes = new Map<string, Lane>();
  private paused = false;
  private timer: NodeJS.Timeout | null = null;
  private lastAliveAt = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly deps: ListenDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** 面板与工具看到的配置态：车道来自 lanes.json，运行态来自这里。 */
  get listening(): boolean {
    return [...this.lanes.values()].some((lane) => lane.capture?.running);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  module(): { ok: boolean; error: string } {
    return captureModuleStatus();
  }

  /** 挂载时恢复：有勾选就开始听。 */
  start(): void {
    this.paused = false;
    this.sync();
  }

  /** 工具里的「停止」：停下采集，勾选留着；`start()` 再按勾选恢复。 */
  stop(): void {
    this.paused = true;
    for (const id of [...this.lanes.keys()]) this.stopLane(id);
    this.ensureTimer();
  }

  /** 按 lanes.json 对账：新增的开始、取消的停下、换了切分方式的重启。 */
  sync(): void {
    const wanted = readLanes(this.deps.lanesFile);
    const keep = new Set(wanted.map((lane) => lane.id));
    for (const id of [...this.lanes.keys()]) {
      if (!keep.has(id)) this.stopLane(id);
    }
    if (!this.paused) {
      for (const lane of wanted) {
        const kind = lane.vad || this.deps.cfg().listen.vad.kind;
        const current = this.lanes.get(lane.id);
        if (current && current.vad === kind && current.capture?.running) continue;
        if (current) this.stopLane(lane.id);
        this.startLane(lane.id, kind);
      }
    }
    this.ensureTimer();
  }

  /** 每路现在的电平与状态；面板的条读这个。 */
  levels(): { listening: boolean; paused: boolean; lanes: Array<{ id: string; level: number; active: boolean; listening: boolean; error: string }> } {
    const now = this.now();
    return {
      listening: this.listening,
      paused: this.paused,
      lanes: this.views(now).map((lane) => ({
        id: lane.id,
        level: lane.level,
        active: lane.active,
        listening: lane.listening,
        error: lane.error,
      })),
    };
  }

  views(now = this.now()): LaneView[] {
    return [...this.lanes.values()].map((lane) => ({
      id: lane.id,
      vad: lane.vad,
      source: lane.source,
      app: lane.app,
      pid: lane.pid,
      label: lane.label,
      listening: Boolean(lane.capture?.running),
      level: this.levelOf(lane, now),
      active: lane.active,
      frames: lane.frames,
      audioMs: lane.audioMs,
      chunks: lane.chunks,
      error: lane.error,
      lastChunkAt: lane.lastChunkAt,
    }));
  }

  dispose(): void {
    this.paused = true;
    for (const id of [...this.lanes.keys()]) this.stopLane(id);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startLane(id: string, kind: string): void {
    const target = (() => {
      try {
        return targetOf(id);
      } catch (err) {
        this.deps.log.warn('听：这一路不认得，跳过', { id, err: msg(err) });
        return null;
      }
    })();
    if (!target) return;
    const pid = target.source === 'app' ? target.pid : 0;
    const label = target.source === 'app' ? `应用 ${target.pid}` : LABEL[target.source];
    const lane: Lane = {
      id,
      vad: kind,
      source: target.source,
      app: target.source === 'app' ? id : '',
      pid,
      label,
      capture: null,
      segmenter: null,
      frames: 0,
      audioMs: 0,
      chunks: 0,
      lastFrameAt: -1,
      rawLevel: -100,
      active: false,
      error: '',
      lastChunkAt: '',
    };
    this.lanes.set(id, lane);

    if (pid && !pidAlive(pid)) {
      lane.error = `进程不在了（PID ${pid}）：应用退出后请重新勾选。`;
      return;
    }
    try {
      lane.segmenter = this.deps.createSegmenter
        ? this.deps.createSegmenter(this.paramsOf(kind))
        : createSegmenter(this.paramsOf(kind), {
          sileroModel: this.deps.sileroModel(),
          streamModel: this.deps.streamModel(),
          fireRedDir: this.deps.fireRedDir(),
          log: this.deps.log,
        });
      // 异步切分器（FireRed 的 ONNX 推理）通过回调交付，出错只停这一路。
      if (lane.segmenter.async && lane.segmenter.subscribe) {
        lane.segmenter.subscribe(
          (utterance) => this.queueUtterance(lane, utterance),
          (err) => this.failLane(lane, `切分出错：${msg(err)}`),
        );
      }
      const hooks = {
        onFrame: (frame: Int16Array) => this.onFrame(lane, frame),
        onStatus: (event: CaptureStatusEvent) => this.onStatus(lane, event),
      };
      const capture = this.deps.createCapture ? this.deps.createCapture(hooks) : new Capturer(hooks);
      lane.capture = capture;
      capture.start(target);
      this.deps.log.info('听：开始这一路', { id, vad: kind });
    } catch (err) {
      lane.error = msg(err);
      lane.segmenter = null;
      lane.capture = null;
      this.deps.log.warn('听：这一路没起来', { id, err: lane.error });
    }
  }

  private stopLane(id: string): void {
    const lane = this.lanes.get(id);
    if (!lane) return;
    this.lanes.delete(id);
    const capture = lane.capture;
    lane.capture = null;
    if (capture) {
      try {
        capture.stop();
      } catch (err) {
        this.deps.log.warn('听：停止采集时报了错', { id, err: msg(err) });
      }
    }
    const segmenter = lane.segmenter;
    lane.segmenter = null;
    if (!segmenter) return;
    try {
      const tail = segmenter.flush();
      if (tail instanceof Promise) void tail.catch(() => {});
      else for (const utterance of tail) this.queueUtterance(lane, utterance);
    } catch (err) {
      this.deps.log.warn('听：收尾时切分出错', { id, err: msg(err) });
    }
  }

  private onFrame(lane: Lane, frame: Int16Array): void {
    const segmenter = lane.segmenter;
    if (!segmenter || !lane.capture) return;
    const now = this.now();
    lane.frames += 1;
    lane.audioMs += FRAME_MS;
    lane.lastFrameAt = now;
    try {
      segmenter.configure(this.paramsOf(lane.vad));
      for (const utterance of segmenter.push(frame, now)) this.queueUtterance(lane, utterance);
      lane.rawLevel = segmenter.level;
      lane.active = segmenter.active;
    } catch (err) {
      this.failLane(lane, `切分出错：${msg(err)}`);
    }
  }

  private onStatus(lane: Lane, event: CaptureStatusEvent): void {
    if (event.type === 'capture-error') {
      this.failLane(lane, event.detail || '采集出错');
      return;
    }
    this.deps.log.warn('听：停止采集时报了错', { id: lane.id, detail: event.detail });
  }

  /** 一路坏了只停这一路；别把别的车道一起拖下水。 */
  private failLane(lane: Lane, detail: string): void {
    lane.error = `${new Date(this.now()).toISOString()} ${detail}`;
    this.deps.log.warn('听：这一路出错，已停', { id: lane.id, detail });
    const capture = lane.capture;
    lane.capture = null;
    lane.segmenter = null;
    lane.active = false;
    try {
      capture?.stop();
    } catch {
      // 已经在错误态里了。
    }
    this.ensureTimer();
  }

  private tick(): void {
    const now = this.now();
    for (const lane of this.lanes.values()) {
      const segmenter = lane.segmenter;
      if (!segmenter) continue;
      try {
        segmenter.configure(this.paramsOf(lane.vad));
        for (const utterance of segmenter.tick(now)) this.queueUtterance(lane, utterance);
        lane.active = segmenter.active;
      } catch (err) {
        this.failLane(lane, `切分出错：${msg(err)}`);
      }
    }
    this.checkAlive(now);
    this.ensureTimer();
  }

  /** 应用退出：这一路就没有意义了；留一条说明在面板上。 */
  private checkAlive(now: number): void {
    if (now - this.lastAliveAt < (this.deps.aliveCheckMs ?? ALIVE_CHECK_MS)) return;
    this.lastAliveAt = now;
    for (const lane of [...this.lanes.values()]) {
      if (lane.source !== 'app' || !lane.pid) continue;
      if (pidAlive(lane.pid)) continue;
      const label = lane.label;
      this.stopLane(lane.id);
      this.lanes.set(lane.id, {
        ...lane,
        capture: null,
        segmenter: null,
        active: false,
        rawLevel: -100,
        error: `${label} 已退出（PID ${lane.pid}）：重新勾选可再听。`,
      });
      this.deps.log.info('听：来源进程已退出', { id: lane.id, pid: lane.pid });
    }
  }

  private queueUtterance(lane: Lane, utterance: Utterance): void {
    if (this.deps.busy()) {
      // 自己在播放：多半是自己的声音，丢掉不记。
      this.deps.log.debug?.('听：播放期间听到的块已丢弃', { id: lane.id, ms: utterance.durationMs });
      return;
    }
    this.chain = this.chain
      .then(() => this.shipUtterance(lane, utterance))
      .catch((err) => this.deps.log.warn('听：处理一块时出错', { id: lane.id, err: msg(err) }));
  }

  /** 应用车道用此刻的窗口标题当名字；查不到就退回「应用 PID」。 */
  private async targetOf(lane: Lane): Promise<string> {
    if (!lane.pid || !this.deps.titleOf) return lane.label;
    try {
      return (await this.deps.titleOf(lane.pid)).trim() || lane.label;
    } catch {
      return lane.label;
    }
  }

  private async shipUtterance(lane: Lane, utterance: Utterance): Promise<void> {
    const at = this.deps.clock?.() ?? new Date(this.now()).toISOString();
    const chunk: HeardChunk = {
      at,
      startedAt: new Date(utterance.startAt).toISOString(),
      durationMs: utterance.durationMs,
      source: lane.source,
      app: lane.app,
      target: await this.targetOf(lane),
      forced: utterance.forced,
      peakDb: utterance.peakDb,
    };
    lane.chunks += 1;
    lane.lastChunkAt = chunk.at;

    // 细分：音乐块不转写、不唤醒，只写事件。
    let aedLabel = '';
    let music = false;
    // 流式来源不切分，没有细分的对象。
    if (lane.vad !== 'stream' && this.deps.cfg().listen.classify === 'aed' && this.deps.classify) {
      try {
        const result = await this.deps.classify(utterance.pcm);
        if (result) {
          aedLabel = AED_LABELS[result.label];
          music = result.label === 'music';
        }
      } catch (err) {
        this.deps.log.warn('听：这一块没能区分音乐/人声', { id: lane.id, err: msg(err) });
      }
    }

    let text = music ? '' : (utterance.text ?? '');
    let transcribeError = '';
    // 流式来源自带正文；只有 VAD 切出来的块才需要整段转写。
    if (!music && utterance.text === undefined && this.deps.cfg().listen.transcribe !== false) {
      try {
        text = await this.withTimeout(this.deps.transcribe(utterance.pcm), TRANSCRIBE_TIMEOUT_MS);
      } catch (err) {
        transcribeError = msg(err);
        this.deps.log.warn('听：这一块没能转成文字', { id: lane.id, err: transcribeError });
      }
    }
    await this.deps.ship(chunk, text, { transcribeError, aedLabel });
  }

  private withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`超时（${Math.round(ms / 1000)} 秒）`)), ms);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private paramsOf(kind: string): VadParams {
    const vad = this.deps.cfg().listen.vad;
    return {
      kind,
      threshold: vad.threshold,
      thresholdDb: vad.thresholdDb,
      minSpeechMs: vad.minSpeechMs,
      minSilenceMs: vad.minSilenceMs,
      maxUtteranceMs: vad.maxUtteranceMs,
      minUtteranceMs: vad.minUtteranceMs,
    };
  }

  private levelOf(lane: Lane, now: number): number {
    if (!lane.capture?.running || lane.lastFrameAt < 0) return -100;
    const decay = ((now - lane.lastFrameAt) / 1000) * DECAY_DB_PER_SEC;
    return Math.max(-100, lane.rawLevel - decay);
  }

  private ensureTimer(): void {
    const need = [...this.lanes.values()].some((lane) => lane.segmenter);
    if (need && !this.timer) {
      this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? 250);
      this.timer.unref?.();
    } else if (!need && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
