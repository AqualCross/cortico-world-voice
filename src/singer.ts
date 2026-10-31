/**
 * 本机 DiffSinger 唱歌子进程的客户端：第一次要唱时才拉起（载声库十几秒），
 * 请求按行进出 JSON；空闲一段时间就退出，把内存还给别的引擎。
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface SingResult {
  /** 这条请求在子进程里花的时间。 */
  ms: number;
  seconds: number;
  notes: number;
  sungChars: number;
  sampleRate: number;
}

export interface SingState {
  phase: 'stopped' | 'starting' | 'ready' | 'error';
  voicebank: string | null;
  sampleRate: number | null;
  speakers: string[];
  detail: string | null;
}

interface Pending {
  resolve: (value: SingResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class SingEngine {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private stderr = '';
  private idle: NodeJS.Timeout | null = null;
  /** 一次唱一首，产物不抢同一个声库。 */
  private queue: Promise<unknown> = Promise.resolve();
  private exitedReason: string | null = null;
  private st: SingState = { phase: 'stopped', voicebank: null, sampleRate: null, speakers: [], detail: null };

  constructor(private readonly opts: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    idleMs?: number;
    /** 载声库 + 推理整条算一次上限。 */
    timeoutMs?: number;
  }) {}

  state(): SingState {
    return { ...this.st, speakers: [...this.st.speakers] };
  }

  /** 唱一首：把 wav 写到 `out`。 */
  sing(req: {
    out: string;
    lyrics: string;
    bpm: number;
    keyShift: number;
    scale: string;
    seed: number;
    speaker: string;
    maxSeconds: number;
  }): Promise<SingResult> {
    const run = (): Promise<SingResult> => this.send(req);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  dispose(): void {
    this.clearIdle();
    this.kill('已停止');
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? 600_000;
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child;
    const child = spawn(this.opts.command, this.opts.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...this.opts.env },
    });
    this.child = child;
    this.buffer = '';
    this.stderr = '';
    this.exitedReason = null;
    this.st = { phase: 'starting', voicebank: null, sampleRate: null, speakers: [], detail: null };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    child.once('error', (err) => this.onExit(`唱歌进程起不来：${err.message}`));
    child.once('close', (code) => this.onExit(
      `唱歌进程已退出（${code ?? '未知'}）${this.stderr.trim() ? `：${this.stderr.trim().split(/\r?\n/).slice(-2).join(' | ')}` : ''}`,
    ));
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let message: {
      type?: string; id?: number; ok?: boolean; ms?: number; seconds?: number; notes?: number;
      sungChars?: number; sampleRate?: number; voicebank?: string; speakers?: string[]; error?: string;
    };
    try {
      message = JSON.parse(line);
    } catch {
      return; // 子进程的杂项输出，忽略。
    }
    if (message.type === 'ready') {
      this.st = {
        phase: 'ready',
        voicebank: String(message.voicebank ?? ''),
        sampleRate: Number(message.sampleRate ?? 0) || null,
        speakers: Array.isArray(message.speakers) ? message.speakers.map(String) : [],
        detail: null,
      };
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve({
        ms: Number(message.ms ?? 0),
        seconds: Number(message.seconds ?? 0),
        notes: Number(message.notes ?? 0),
        sungChars: Number(message.sungChars ?? 0),
        sampleRate: Number(message.sampleRate ?? 0),
      });
    } else {
      entry.reject(new Error(String(message.error ?? '唱歌失败')));
    }
    this.touchIdle();
  }

  private send(req: {
    out: string;
    lyrics: string;
    bpm: number;
    keyShift: number;
    scale: string;
    seed: number;
    speaker: string;
    maxSeconds: number;
  }): Promise<SingResult> {
    if (this.exitedReason) {
      const reason = this.exitedReason;
      this.exitedReason = null;
      return Promise.reject(new Error(reason));
    }
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise<SingResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`唱歌超时（${Math.round(this.timeoutMs / 1000)} 秒）`));
        this.kill('唱歌超时');
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ op: 'sing', id, ...req })}\n`);
    });
  }

  private touchIdle(): void {
    this.clearIdle();
    this.idle = setTimeout(() => this.kill('空闲退出'), this.opts.idleMs ?? 5 * 60_000);
    this.idle.unref?.();
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private onExit(reason: string): void {
    if (!this.child) return;
    this.child = null;
    this.exitedReason = reason;
    this.st = {
      phase: this.st.phase === 'ready' ? 'stopped' : 'error',
      voicebank: this.st.voicebank,
      sampleRate: this.st.sampleRate,
      speakers: this.st.speakers,
      detail: this.st.phase === 'starting' ? reason : null,
    };
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  private kill(reason: string): void {
    this.clearIdle();
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.st = { phase: 'stopped', voicebank: null, sampleRate: null, speakers: [], detail: reason };
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    try {
      child.stdin?.end();
      child.kill();
    } catch {
      // 进程可能已经没了。
    }
  }
}
