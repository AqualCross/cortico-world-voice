/**
 * Edge 在线朗读（免费、免密钥）：协议与信任 token 由 `msedge-tts` 维护，这里只管拼参数收字节。
 * 输出固定 24 kHz / 48 kbps 单声道 mp3；播放器的 PowerShell 兜底与 ffmpeg 都能直接解码。
 *
 * 实测新建连接要 1–1.4 s，音频本身只占几百毫秒，所以句与句之间复用同一个客户端；
 * 音色变了才重连，空闲一段时间后自动关掉。
 */
import { createRequire } from 'node:module';
import type { SpeechStream } from './speech.ts';

const require = createRequire(import.meta.url);

export interface EdgeAudioStream extends AsyncIterable<Uint8Array | Buffer> {
  /** Readable 的销毁钩子：只取消这一条，不关整条 WebSocket。 */
  destroy?: () => void;
}

export interface EdgeClient {
  setMetadata(voice: string, format: string): Promise<void>;
  toStream(text: string, options: { rate: string; pitch: string }): { audioStream: EdgeAudioStream };
  close(): void;
}

export interface EdgeModule {
  MsEdgeTTS: new (options?: { connectionTimeoutMs?: number; synthesisTimeoutMs?: number }) => EdgeClient;
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: string };
}

export class EdgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdgeError';
  }
}

/** 加载 msedge-tts；失败时把「装没装」讲成人话。 */
export function loadEdge(): EdgeModule {
  try {
    return require('msedge-tts') as EdgeModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new EdgeError(`载入 msedge-tts 失败：${detail}。请在扩展目录里安装依赖后重启应用。`);
  }
}

/** 0 也要带正号：Edge 只认 `+0%` / `+0Hz` 这种相对写法。 */
const prosody = (value: number | undefined, unit: '%' | 'Hz'): string => {
  const raw = Number(value ?? 0);
  const n = Number.isFinite(raw) ? Math.round(raw) : 0;
  return `${n >= 0 ? '+' : ''}${n}${unit}`;
};

export interface EdgeOptions {
  text: string;
  voice: string;
  rate?: number;
  pitch?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  load?: () => EdgeModule;
}

/** 把库里的英文错误翻成人话；已经是人话的原样返回。 */
function edgeFailure(err: unknown, voice: string): Error {
  if (err instanceof EdgeError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  if (/synthesis completed|truncated|Stream closed/i.test(detail)) {
    return new EdgeError(`Edge 没返回音频：检查音色名「${voice}」是否有效、网络是否可用。`);
  }
  return new EdgeError(`Edge 合成失败：${detail}`);
}

const validate = (text: string, voice: string): void => {
  if (!text) throw new EdgeError('没有要合成的文字。');
  if (!voice) throw new EdgeError('还没有填音色：在「说话」页的 Edge 引擎里写一个音色名，例如 zh-CN-XiaoyiNeural。');
};

/**
 * 常驻的 Edge 客户端：同一个音色/格式反复说时不重连。
 * 一条流被取消只销毁那条流，别的流和连接继续用；连接出错时才整体丢掉，下一次重连。
 */
export class EdgeSpeaker {
  private client: EdgeClient | null = null;
  private key = '';
  private mod: EdgeModule | null = null;
  private idle: NodeJS.Timeout | null = null;

  constructor(private readonly opts: { load?: () => EdgeModule; idleMs?: number } = {}) {}

  async stream(opts: Omit<EdgeOptions, 'load'>): Promise<SpeechStream> {
    const text = opts.text.trim();
    const voice = opts.voice.trim();
    validate(text, voice);

    const mod = this.mod ?? (this.opts.load ?? loadEdge)();
    this.mod = mod;
    const format = mod.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
    const key = `${voice}|${format}`;
    if (!this.client || this.key !== key) {
      this.closeClient();
      this.client = new mod.MsEdgeTTS({ connectionTimeoutMs: 15_000, synthesisTimeoutMs: opts.timeoutMs ?? 60_000 });
      this.key = key;
    }
    const client = this.client;

    try {
      await client.setMetadata(voice, format);
    } catch (err) {
      this.closeClient();
      throw edgeFailure(err, voice);
    }
    this.touchIdle();
    if (opts.signal?.aborted) throw new EdgeError('已取消');

    const { audioStream } = client.toStream(text, { rate: prosody(opts.rate, '%'), pitch: prosody(opts.pitch, 'Hz') });
    const onAbort = (): void => audioStream.destroy?.();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const speaker = this;
    const chunks = (async function* (): AsyncGenerator<Buffer> {
      let bytes = 0;
      try {
        for await (const chunk of audioStream) {
          if (opts.signal?.aborted) break;
          bytes += chunk.length;
          if (chunk.length) yield Buffer.from(chunk);
        }
        if (!bytes && !opts.signal?.aborted) {
          throw new EdgeError(`Edge 没返回音频：音色「${voice}」可能不在 Edge 的列表里（童声 XiaoshuangNeural 只有 Azure 付费接口才有）。`);
        }
      } catch (err) {
        if (opts.signal?.aborted) return;
        // 连接或合成出错：这条连接不再可信，下次重连。
        speaker.closeClient();
        throw edgeFailure(err, voice);
      } finally {
        opts.signal?.removeEventListener('abort', onAbort);
        speaker.touchIdle();
      }
    })();

    return { engine: 'edge', format: 'mp3', voice, model: 'Edge TTS', chunks };
  }

  /** World 停止或长时间不用时关掉连接。 */
  close(): void {
    this.closeClient();
  }

  private closeClient(): void {
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    const client = this.client;
    this.client = null;
    this.key = '';
    try {
      client?.close();
    } catch {
      // 连接已经断了
    }
  }

  private touchIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.closeClient(), this.opts.idleMs ?? 5 * 60_000);
    this.idle.unref?.();
  }
}

/** 合成一句，边到边交给播放侧；一次性客户端，收完/取消即关。 */
export async function synthesizeEdgeStream(opts: EdgeOptions): Promise<SpeechStream> {
  const speaker = new EdgeSpeaker({ load: opts.load });
  const stream = await speaker.stream(opts);
  const chunks = (async function* () {
    try {
      yield* stream.chunks;
    } finally {
      speaker.close();
    }
  })();
  return { ...stream, chunks };
}

/** 整句合成（silent 用）；内部仍是流，收齐再返回。 */
export async function synthesizeEdge(opts: EdgeOptions): Promise<Buffer> {
  const stream = await synthesizeEdgeStream(opts);
  const parts: Buffer[] = [];
  for await (const chunk of stream.chunks) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}
