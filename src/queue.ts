/** 播放队列：先来先放，一次一条；跳过、按条移除、清空；面板读快照。 */
import { basename } from 'node:path';

export type QueueOrigin = 'tool' | 'ui' | 'event';

/** 左右平衡统一掐成 -100…100 的整数；认不出的值当居中。 */
export function clampBalance(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.round(value)));
}

export interface QueueRequest {
  path: string;
  /** 面板上显示的名字；缺省用文件名。 */
  shown?: string;
  /** 0–100；缺省用配置里的音量。 */
  volume?: number;
  /** -100（全左）… 100（全右）；缺省用配置里的平衡。 */
  balance?: number;
  /** 这条音频说的文字，播放页当字幕用；放文件时没有。 */
  text?: string;
  /** 音频时长（秒）；有字幕时按它算当前说到哪句。 */
  seconds?: number;
  origin: QueueOrigin;
}

export interface QueueItemView {
  id: string;
  shown: string;
  ref: string;
  volume: number;
  balance: number;
  origin: QueueOrigin;
  /** 0 是正在播放，1 起是排队顺序。 */
  position: number;
  startedAtMs: number;
  elapsedSec: number;
  text: string;
  seconds: number | null;
}

export interface QueueSnapshot {
  current: QueueItemView | null;
  pending: QueueItemView[];
  counts: { current: number; pending: number };
  volume: number;
  balance: number;
  lastError: string | null;
}

export type PlayFn = (opts: { path: string; volume: number; balance: number; signal: AbortSignal }) => Promise<void>;

/** 队列的旁听钩子：字幕层跟着真正开播/收播。 */
export interface QueueHooks {
  onStart?: (item: QueueItemView) => void;
  onEnd?: (item: QueueItemView) => void;
}

interface Item extends QueueRequest {
  id: string;
  shown: string;
  volume: number;
  balance: number;
  controller: AbortController;
  startedAt: number;
}

export class PlayQueue {
  private pending: Item[] = [];
  private current: Item | null = null;
  private running = false;
  private seq = 0;
  private lastError: string | null = null;

  constructor(
    private readonly play: PlayFn,
    private readonly defaultVolume: () => number,
    private readonly defaultBalance: () => number = () => 0,
    private readonly hooks: QueueHooks = {},
  ) {}

  /** 排队并立刻返回 id；真正播放由后台循环推进。 */
  enqueue(req: QueueRequest): { id: string; position: number } {
    const item: Item = {
      ...req,
      id: `q${++this.seq}`,
      shown: req.shown?.trim() || basename(req.path),
      volume: req.volume ?? this.defaultVolume(),
      balance: clampBalance(req.balance ?? this.defaultBalance()),
      controller: new AbortController(),
      startedAt: 0,
    };
    this.pending.push(item);
    void this.drain();
    return { id: item.id, position: item === this.current ? 0 : this.pending.length };
  }

  snapshot(): QueueSnapshot {
    const now = Date.now();
    const view = (item: Item, position: number): QueueItemView => this.viewOf(item, position, now);
    return {
      current: this.current ? view(this.current, 0) : null,
      pending: this.pending.map((item, index) => view(item, index + 1)),
      counts: { current: this.current ? 1 : 0, pending: this.pending.length },
      volume: this.defaultVolume(),
      balance: clampBalance(this.defaultBalance()),
      lastError: this.lastError,
    };
  }

  private viewOf(item: Item, position: number, now = Date.now()): QueueItemView {
    return {
      id: item.id,
      shown: item.shown,
      ref: item.path,
      volume: item.volume,
      balance: item.balance,
      origin: item.origin,
      position,
      startedAtMs: item.startedAt,
      elapsedSec: item.startedAt ? Math.max(0, Math.round((now - item.startedAt) / 1000)) : 0,
      text: item.text ?? '',
      seconds: typeof item.seconds === 'number' && item.seconds > 0 ? item.seconds : null,
    };
  }

  /** 跳过当前这条；没有当前时丢掉排队的第一条。 */
  skip(): string {
    if (!this.current) {
      const next = this.pending.shift();
      if (!next) return '播放队列是空的，没有可跳过的。';
      next.controller.abort();
      return `已跳过排队中的 ${next.id}（${next.shown}）；队列里还有 ${this.pending.length} 条。`;
    }
    const item = this.current;
    item.controller.abort();
    return `已跳过 ${item.id}（${item.shown}）${this.pending.length ? '，下一条接着放' : '，队列里没有别的了'}。`;
  }

  remove(id: string): string {
    if (this.current?.id === id) return `${id} 正在播放，要停它用跳过。`;
    const index = this.pending.findIndex((one) => one.id === id);
    if (index < 0) return `队列里没有 ${id}。`;
    const [removed] = this.pending.splice(index, 1);
    removed.controller.abort();
    return `已从队列移除 ${removed.id}（${removed.shown}）；队列里还有 ${this.pending.length} 条。`;
  }

  /** 停止当前并清空排队。 */
  clear(): string {
    const dropped = this.pending.length;
    for (const item of this.pending) item.controller.abort();
    this.pending = [];
    const head = this.current ? `已停止 ${this.current.id}` : '没有正在播放的';
    this.current?.controller.abort();
    return `${head}；清空排队 ${dropped} 条。`;
  }

  /** World 停止时用：取消全部并等当前这条退出。 */
  async dispose(): Promise<void> {
    this.current?.controller.abort();
    for (const item of this.pending) item.controller.abort();
    this.pending = [];
    const deadline = Date.now() + 3000;
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const item = this.pending.shift()!;
        this.current = item;
        item.startedAt = Date.now();
        try {
          this.hooks.onStart?.(this.viewOf(item, 0));
          await this.play({ path: item.path, volume: item.volume, balance: item.balance, signal: item.controller.signal });
          this.lastError = null;
        } catch (err) {
          // 取消不算失败，只有真的播不出来才留在页面上。
          const aborted = item.controller.signal.aborted;
          this.lastError = aborted ? null : `${item.shown}：${err instanceof Error ? err.message : String(err)}`;
        } finally {
          this.hooks.onEnd?.(this.viewOf(item, 0));
          this.current = null;
          item.startedAt = 0;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
