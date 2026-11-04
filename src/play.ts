/**
 * 播放一条音频并等它结束：Windows 上用系统自带的 PowerShell + WPF MediaPlayer
 *（`assets/play.ps1`，退出码见脚本头部）。取消时 taskkill 整个进程树。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OUTPUT_CHANNELS, OUTPUT_RATE, PcmOutput } from './audio-out.ts';
import { decodePcm, decodeStreamPcm } from './decode.ts';

const PLAY_PS1 = fileURLToPath(new URL('../assets/play.ps1', import.meta.url));

export interface PlayOptions {
  path: string;
  /** 0–100。 */
  volume: number;
  /** -100（全左）… 100（全右）；缺省居中。 */
  balance?: number;
  /** 超过这个时间强制结束，防止坏文件挂住队列。 */
  timeoutMs?: number;
  signal: AbortSignal;
}

export type PlayFailure = 'missing' | 'spawn' | 'timeout' | 'aborted' | 'media' | 'open' | 'failed';

export class PlaybackError extends Error {
  constructor(readonly code: PlayFailure, message: string) {
    super(message);
    this.name = 'PlaybackError';
  }
}

const EXIT: Readonly<Record<number, [PlayFailure, string]>> = {
  1: ['failed', '播放器异常'],
  2: ['media', '解码失败（格式不受支持或文件损坏）'],
  3: ['timeout', '播放超时'],
  4: ['open', '打不开这个文件'],
  5: ['failed', '播放没有正常结束'],
};

/** 播完才 resolve；失败抛 PlaybackError。 */
export function playFile(opts: PlayOptions): Promise<void> {
  const { path, volume, balance = 0, timeoutMs = 30 * 60_000, signal } = opts;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PlaybackError('aborted', '已取消'));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', PLAY_PS1,
        '-Path', path,
        '-Volume', String(Math.max(0, Math.min(100, Math.round(volume)))),
        '-Balance', String(Math.max(-100, Math.min(100, Math.round(balance)))),
        '-TimeoutMs', String(Math.max(1000, timeoutMs)),
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new PlaybackError('spawn', `播放器起不来：${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const kill = (): void => {
      if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    };
    const onAbort = (): void => kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(new PlaybackError('spawn', `播放器起不来：${err.message}`));
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        reject(new PlaybackError('aborted', '已取消'));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const [kind, text] = EXIT[code ?? 1] ?? ['failed', `播放器退出码 ${code}`];
      reject(new PlaybackError(kind, stderr.trim() ? `${text}：${stderr.trim().slice(0, 200)}` : text));
    });
  });
}


export interface StreamPlayOptions extends PlayOptions {
  ffmpeg: string;
  output: PcmOutput;
}

export interface EncodedStreamPlayOptions {
  /** 编码格式的字节流（mp3 / wav…），边到边解。 */
  chunks: AsyncIterable<Buffer>;
  /** 0–100。 */
  volume: number;
  /** -100（全左）… 100（全右）；缺省居中。 */
  balance?: number;
  signal: AbortSignal;
  ffmpeg: string;
  output: PcmOutput;
}

/** 播一条编码流：ffmpeg 从 stdin 边读边解，写完等音频播完；返回实际播了多久。 */
export async function playStream(opts: EncodedStreamPlayOptions): Promise<{ seconds: number }> {
  const { chunks, volume, balance = 0, signal, ffmpeg, output } = opts;
  const gain = Math.max(0, Math.min(1, volume / 100));
  const pan = Math.max(-1, Math.min(1, balance / 100));
  await output.write(OUTPUT_RATE, Buffer.alloc(0)); // 先把输出按 48k 打开，省掉首块前的设备启动
  let bytes = 0;
  try {
    for await (const chunk of decodeStreamPcm(ffmpeg, chunks, signal)) {
      if (signal.aborted) throw new PlaybackError('aborted', '已取消');
      bytes += chunk.length;
      await output.write(OUTPUT_RATE, chunk, gain, pan);
    }
  } catch (err) {
    if (signal.aborted) throw new PlaybackError('aborted', '已取消');
    if (err instanceof PlaybackError) throw err;
    throw new PlaybackError('failed', err instanceof Error ? err.message : String(err));
  }
  output.flush();
  await output.drain();
  return { seconds: bytes / (OUTPUT_RATE * OUTPUT_CHANNELS * 2) };
}

/**
 * 常驻输出播放一条文件：ffmpeg 解码边解边写，写完等排队的音频播完。
 * ffmpeg 不存在或解码失败时抛错，调用方可以退回 playFile（PowerShell）。
 */
export async function playFileStream(opts: StreamPlayOptions): Promise<void> {
  const { path, volume, balance = 0, signal, ffmpeg, output } = opts;
  const gain = Math.max(0, Math.min(1, volume / 100));
  const pan = Math.max(-1, Math.min(1, balance / 100));
  await output.write(48_000, Buffer.alloc(0)); // 先把输出按 48k 打开，省掉首块前的设备启动
  try {
    for await (const chunk of decodePcm(ffmpeg, path, signal)) {
      if (signal.aborted) throw new PlaybackError('aborted', '已取消');
      await output.write(48_000, chunk, gain, pan);
    }
  } catch (err) {
    if (signal.aborted) throw new PlaybackError('aborted', '已取消');
    throw new PlaybackError('failed', err instanceof Error ? err.message : String(err));
  }
  output.flush();
  await output.drain();
}
