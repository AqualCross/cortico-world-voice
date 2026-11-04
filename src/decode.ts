/**
 * 用 ffmpeg 把任意音频解成 16-bit 交错立体声 48 kHz PCM 块。
 * 不落临时文件：ffmpeg 直接写 stdout，按块交给播放器。
 */
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { OUTPUT_CHANNELS, OUTPUT_RATE } from './audio-out.ts';

/** 解码参数；单独提出来方便测试与以后换采样率。 */
export function ffmpegArgs(path: string, rate = OUTPUT_RATE, channels = OUTPUT_CHANNELS): string[] {
  return [
    '-nostdin', '-v', 'error',
    '-i', path,
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    '-ac', String(channels),
    '-ar', String(rate),
    '-',
  ];
}

/** 逐块产出 PCM；ffmpeg 退出码非 0 时抛错，取消时抛 AbortError。 */
export async function* decodePcm(ffmpeg: string, path: string, signal: AbortSignal, rate = OUTPUT_RATE, channels = OUTPUT_CHANNELS): AsyncGenerator<Buffer> {
  const child = spawn(ffmpeg, ffmpegArgs(path, rate, channels), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const kill = (): void => {
    if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  };
  signal.addEventListener('abort', kill, { once: true });
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('close', (code) => resolve(code));
  });
  try {
    for await (const chunk of child.stdout) {
      yield chunk as Buffer;
      if (signal.aborted) break;
    }
  } finally {
    signal.removeEventListener('abort', kill);
  }
  const code = await exited;
  if (signal.aborted) throw new Error('已取消');
  if (code !== 0) throw new Error(`ffmpeg 解码失败（退出码 ${code}）：${stderr.trim().split(/\r?\n/).slice(-2).join(' | ')}`);
}

/** 从 stdin 读编码流；探测窗口压小，首块不必等整句。 */
export function ffmpegStreamArgs(rate = OUTPUT_RATE, channels = OUTPUT_CHANNELS): string[] {
  return [
    '-nostdin', '-v', 'error',
    '-probesize', '32k', '-analyzeduration', '0',
    '-i', 'pipe:0',
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    '-ac', String(channels),
    '-ar', String(rate),
    '-',
  ];
}

/**
 * 把编码块边写进 ffmpeg stdin、边读解码后的 PCM。合成器出错时杀掉 ffmpeg 并把原错误抛出去，
 * 取消时抛「已取消」。调用方按块写输出，首音不用等整句合成完。
 */
export async function* decodeStreamPcm(
  ffmpeg: string,
  chunks: AsyncIterable<Buffer>,
  signal: AbortSignal,
  rate = OUTPUT_RATE,
  channels = OUTPUT_CHANNELS,
): AsyncGenerator<Buffer> {
  const child = spawn(ffmpeg, ffmpegStreamArgs(rate, channels), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const kill = (): void => {
    if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  };
  const onAbort = (): void => kill();
  signal.addEventListener('abort', onAbort, { once: true });
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('close', (code) => resolve(code));
  });
  let sourceError: unknown = null;
  const writer = (async () => {
    try {
      for await (const chunk of chunks) {
        if (signal.aborted) break;
        if (chunk.length && !child.stdin!.write(chunk)) await once(child.stdin!, 'drain');
      }
    } catch (err) {
      // 合成器中途失败：结束 ffmpeg，让下面的读取循环退出，再把原错误交给调用方。
      sourceError = err;
      kill();
    } finally {
      try {
        child.stdin!.end();
      } catch {
        // 管道已经被 ffmpeg 关掉了
      }
    }
  })();

  try {
    for await (const chunk of child.stdout!) {
      yield chunk as Buffer;
      if (signal.aborted) break;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  await writer;
  const code = await exited;
  if (signal.aborted) throw new Error('已取消');
  if (sourceError) throw sourceError;
  if (code !== 0) throw new Error(`ffmpeg 解码失败（退出码 ${code}）：${stderr.trim().split(/\r?\n/).slice(-2).join(' | ')}`);
}

/** 整段解成 16 kHz 单声道 s16le PCM（本机识别用）。 */
export async function decodeMono16k(ffmpeg: string, path: string, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of decodePcm(ffmpeg, path, signal, 16_000, 1)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
