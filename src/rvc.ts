/**
 * 本机 RVC 变声子进程的客户端：Python 进程常驻，模型换一次载一次，请求按行进出 JSON。
 * 空闲一段时间就退出，让出显存；下次变声再拉起。
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface RvcResult {
  /** 这次推理在子进程里花的时间。 */
  ms: number;
  /** 载入音色花的时间；同一个音色重复用是 0。 */
  loadMs: number;
  sampleRate: number;
}

export interface RvcState {
  phase: 'stopped' | 'starting' | 'ready' | 'error';
  device: string | null;
  model: string | null;
  detail: string | null;
}

interface Pending {
  resolve: (value: RvcResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RvcEngine {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private stderr = '';
  private idle: NodeJS.Timeout | null = null;
  /** 请求一次一条，模型不是线程安全的。 */
  private queue: Promise<unknown> = Promise.resolve();
  private exitedReason: string | null = null;
  private st: RvcState = { phase: 'stopped', device: null, model: null, detail: null };

  constructor(private readonly opts: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    idleMs?: number;
    timeoutMs?: number;
  }) {}

  state(): RvcState {
    return { ...this.st };
  }

  /** 转一条：`model` 是 .pth 绝对路径，同名 `.index` 由 worker 自己找。 */
  convert(req: { input: string; output: string; model: string; pitch: number; indexRate: number; protect: number }): Promise<RvcResult> {
    const run = (): Promise<RvcResult> => this.send(req);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  dispose(): void {
    this.clearIdle();
    this.kill('已停止');
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? 300_000;
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
    this.st = { phase: 'starting', device: null, model: null, detail: null };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    child.once('error', (err) => this.onExit(`变声进程起不来：${err.message}`));
    child.once('close', (code) => this.onExit(
      `变声进程已退出（${code ?? '未知'}）${this.stderr.trim() ? `：${this.stderr.trim().split(/\r?\n/).slice(-2).join(' | ')}` : ''}`,
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
      type?: string; id?: number; ok?: boolean; ms?: number; loadMs?: number; sampleRate?: number;
      device?: string; kind?: string; error?: string;
    };
    try {
      message = JSON.parse(line);
    } catch {
      return; // 子进程的杂项输出，忽略。
    }
    if (message.type === 'ready') {
      this.st = { phase: 'ready', device: String(message.device ?? ''), model: this.st.model, detail: null };
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
        loadMs: Number(message.loadMs ?? 0),
        sampleRate: Number(message.sampleRate ?? 0),
      });
    } else {
      entry.reject(new Error(String(message.error ?? '变声失败')));
    }
    this.touchIdle();
  }

  private send(req: { input: string; output: string; model: string; pitch: number; indexRate: number; protect: number }): Promise<RvcResult> {
    if (this.exitedReason) {
      // 上次失败留下的原因先抛一次，进程会在下次调用时重新拉起。
      const reason = this.exitedReason;
      this.exitedReason = null;
      return Promise.reject(new Error(reason));
    }
    const child = this.ensureChild();
    const id = this.nextId++;
    this.st = { ...this.st, model: req.model.split(/[\\/]/).pop() ?? null };
    return new Promise<RvcResult>((resolve, reject) => {
      // 第一次转换要连模型一起载入，超时按整条请求算。
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`变声超时（${Math.round(this.timeoutMs / 1000)} 秒）`));
        this.kill('变声超时');
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ op: 'convert', id, ...req })}\n`);
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
    this.st = { phase: this.st.phase === 'ready' ? 'stopped' : 'error', device: this.st.device, model: this.st.model, detail: this.st.phase === 'starting' ? reason : null };
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
    this.st = { phase: 'stopped', device: null, model: null, detail: reason };
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
