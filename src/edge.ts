/**
 * Edge 在线朗读（免费、免密钥）：协议与信任 token 由 `msedge-tts` 维护，这里只管拼参数收字节。
 * 输出固定 24 kHz / 48 kbps 单声道 mp3；播放器的 PowerShell 兜底与 ffmpeg 都能直接解码。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface EdgeAudioStream extends AsyncIterable<Uint8Array | Buffer> {}

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

/** 合成一句，返回 mp3 字节。没有音频通常是音色名不在 Edge 的列表里。 */
export async function synthesizeEdge(opts: {
  text: string;
  voice: string;
  rate?: number;
  pitch?: number;
  timeoutMs?: number;
  load?: () => EdgeModule;
}): Promise<Buffer> {
  const text = opts.text.trim();
  if (!text) throw new EdgeError('没有要合成的文字。');
  const voice = opts.voice.trim();
  if (!voice) throw new EdgeError('还没有填音色：在「说话」页的 Edge 引擎里写一个音色名，例如 zh-CN-XiaoyiNeural。');

  const mod = (opts.load ?? loadEdge)();
  const tts = new mod.MsEdgeTTS({ connectionTimeoutMs: 15_000, synthesisTimeoutMs: opts.timeoutMs ?? 60_000 });
  try {
    await tts.setMetadata(voice, mod.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, { rate: prosody(opts.rate, '%'), pitch: prosody(opts.pitch, 'Hz') });
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) {
      throw new EdgeError(`Edge 没返回音频：音色「${voice}」可能不在 Edge 的列表里（童声 XiaoshuangNeural 只有 Azure 付费接口才有）。`);
    }
    return bytes;
  } catch (err) {
    if (err instanceof EdgeError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    if (/synthesis completed|truncated|Stream closed/i.test(detail)) {
      throw new EdgeError(`Edge 没返回音频：检查音色名「${voice}」是否有效、网络是否可用。`);
    }
    throw new EdgeError(`Edge 合成失败：${detail}`);
  } finally {
    try {
      tts.close();
    } catch {
      // 连接已经断了：关失败不影响已经拿到的音频
    }
  }
}
