/**
 * 本机识别子进程的客户端：Python 进程常驻、模型只加载一次，请求按行进出 JSON。
 * 空闲一段时间就退出，省内存；下次转写再拉起。
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface AsrResult {
  text: string;
  lang: string;
  emotion: string;
  event: string;
  /** 这次识别在子进程里花的时间。 */
  ms: number;
}

interface Pending {
  resolve: (value: AsrResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class LocalAsr {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private stderr = '';
  private idle: NodeJS.Timeout | null = null;
  /** 请求一次一条，模型不是线程安全的。 */
  private queue: Promise<unknown> = Promise.resolve();
  private exitedReason: string | null = null;

  constructor(private readonly opts: { command: string; args: string[]; idleMs?: number; timeoutMs?: number }) {}

  transcribe(pcm: Buffer): Promise<AsrResult> {
    const run = (): Promise<AsrResult> => this.send(pcm);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  dispose(): void {
    this.clearIdle();
    this.kill();
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? 180_000;
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child;
    const child = spawn(this.opts.command, this.opts.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.buffer = '';
    this.stderr = '';
    this.exitedReason = null;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    child.once('error', (err) => this.onExit(`识别进程起不来：${err.message}`));
    child.once('close', (code) => this.onExit(
      `识别进程已退出（${code ?? '未知'}）${this.stderr.trim() ? `：${this.stderr.trim().split(/\r?\n/).slice(-2).join(' | ')}` : ''}`,
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
    let message: { id?: number; ok?: boolean; text?: string; lang?: string; emotion?: string; event?: string; ms?: number; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      return; // 子进程的杂项输出，忽略。
    }
    if (typeof message.id !== 'number') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve({
        text: String(message.text ?? '').trim(),
        lang: String(message.lang ?? ''),
        emotion: String(message.emotion ?? ''),
        event: String(message.event ?? ''),
        ms: Number(message.ms ?? 0),
      });
    } else {
      entry.reject(new Error(String(message.error ?? '识别失败')));
    }
    this.touchIdle();
  }

  private send(pcm: Buffer): Promise<AsrResult> {
    if (this.exitedReason) {
      // 上次失败留下的原因先抛一次，进程会在下次调用时重新拉起。
      const reason = this.exitedReason;
      this.exitedReason = null;
      return Promise.reject(new Error(reason));
    }
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise<AsrResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`识别超时（${Math.round(this.timeoutMs / 1000)} 秒）`));
        this.kill();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ id, pcm: pcm.toString('base64'), sampleRate: 16000 })}\n`);
    });
  }

  private touchIdle(): void {
    this.clearIdle();
    this.idle = setTimeout(() => this.kill(), this.opts.idleMs ?? 10 * 60_000);
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
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  private kill(): void {
    this.clearIdle();
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.stdin?.end();
      child.kill();
    } catch {
      // 进程可能已经没了。
    }
  }
}
