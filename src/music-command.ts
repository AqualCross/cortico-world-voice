import { spawn } from 'node:child_process';

export interface MusicCommandOptions {
  signal: AbortSignal;
  env?: Record<string, string>;
  onOutput?: (line: string) => void;
}

/** 音乐任务只传参数数组；取消时连同解码子进程一起停止。 */
export function runMusicCommand(command: string, args: string[], opts: MusicCommandOptions): Promise<void> {
  opts.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...opts.env },
    });
    let tail = '';
    const feed = (data: Buffer): void => {
      const text = data.toString();
      tail = (tail + text).slice(-6000);
      const line = text.trim().split(/[\r\n]/).filter(Boolean).at(-1);
      if (line) opts.onOutput?.(line.slice(-500));
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const cancel = (): void => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill();
    };
    opts.signal.addEventListener('abort', cancel, { once: true });
    if (opts.signal.aborted) cancel();
    child.once('error', (error) => {
      opts.signal.removeEventListener('abort', cancel);
      reject(error);
    });
    child.once('close', (code) => {
      opts.signal.removeEventListener('abort', cancel);
      if (opts.signal.aborted) reject(new Error('已取消'));
      else if (code === 0) resolve();
      else reject(new Error(tail.trim().split(/[\r\n]/).filter(Boolean).slice(-4).join(' | ') || `音频处理退出（${code}）`));
    });
  });
}
