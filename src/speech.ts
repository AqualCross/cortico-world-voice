/**
 * 说话引擎的统一形状：编码字节流（mp3 / wav），播放侧只认这个，不关心是哪个引擎。
 * 能边合成边出的引擎直接给流；只能整句返回的包一层单块流。
 */

export interface EncodedSpeech {
  /** 编码格式，例如 mp3 / wav；落记录与 ffmpeg 探测都用它。 */
  format: string;
  chunks: AsyncIterable<Buffer>;
}

export interface SpeechStream extends EncodedSpeech {
  engine: string;
  voice: string;
  model: string;
}

/** 把 fetch 的响应体按到达顺序交出去；服务端不流式时就是一大块。 */
export async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/** 用户取消 + 请求超时合成一个信号（fetch 只收一个）。 */
export function abortWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  if (signal.aborted || timeout.aborted) controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  timeout.addEventListener('abort', stop, { once: true });
  return controller.signal;
}

/**
 * 把流缓冲起来：队列轮到它之前就可以开始合成（预热），播放时先放已到的块、再接着等后面的块。
 * 被跳过/清空时信号中止，底层生成器的 finally 负责关掉连接。
 */
export class BufferedSpeech {
  private info: SpeechStream | null = null;
  private parts: Buffer[] = [];
  private state: 'idle' | 'opening' | 'done' | 'failed' = 'idle';
  private failure: unknown = null;
  private signal: AbortSignal | null = null;
  private wake: (() => void) | null = null;
  private iterator: AsyncIterator<Buffer> | null = null;
  private startedAt = 0;

  constructor(private readonly open: (signal: AbortSignal) => Promise<SpeechStream>) {}

  get speech(): SpeechStream | null {
    return this.info;
  }

  /** 开始合成的时间（毫秒时间戳）；没开始过是 0。 */
  get startedAtMs(): number {
    return this.startedAt;
  }

  /** 已收到的编码字节；播放结束后就是完整的一条。 */
  bytes(): Buffer {
    return Buffer.concat(this.parts);
  }

  /** 开始合成；重复调用无副作用。 */
  start(signal: AbortSignal): void {
    if (this.state !== 'idle') return;
    this.signal = signal;
    this.startedAt = Date.now();
    this.state = 'opening';
    void this.pump(signal);
  }

  /** 按到达顺序交出编码块；合成失败时在读完已到的块后抛出。 */
  async *chunks(signal?: AbortSignal): AsyncGenerator<Buffer> {
    let at = 0;
    while (true) {
      while (at < this.parts.length) {
        yield this.parts[at];
        at += 1;
      }
      if (this.state === 'failed') throw this.failure;
      if (this.state === 'done' || signal?.aborted) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private async pump(signal: AbortSignal): Promise<void> {
    try {
      this.info = await this.open(signal);
      this.iterator = this.info.chunks[Symbol.asyncIterator]();
      while (!signal.aborted) {
        const next = await this.iterator.next();
        if (signal.aborted) break;
        if (next.done) {
          this.state = 'done';
          return;
        }
        if (next.value.length) this.parts.push(Buffer.from(next.value));
        this.notify();
      }
      await this.iterator.return?.();
      this.state = 'done';
    } catch (err) {
      // 被跳过/清空不是合成失败，不把取消当错误留给下一层。
      if (signal.aborted) {
        this.state = 'done';
        return;
      }
      this.failure = err;
      this.state = 'failed';
    } finally {
      this.notify();
    }
  }
}
