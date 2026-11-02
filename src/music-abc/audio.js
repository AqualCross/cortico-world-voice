import { Worker } from 'node:worker_threads';
import { existsSync, statSync } from 'node:fs';
export function soundfontPath(configured) {
  if (!configured) throw new Error('请先在乐器页获取 GeneralUser GS 或导入音源。');
  const path = String(configured);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`找不到采样音源：${path}`);
  return path;
}

/** Worker isolation keeps a long composition from blocking the host's event loop. */
export class AudioRenderer {
  active = null;
  async render(midi, soundfont = '') {
    if (this.active) throw new Error('正在生成另一段音频，请稍后再试。');
    const font = soundfontPath(soundfont);
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./audio-worker.js', import.meta.url), {
        workerData: { midi: new Uint8Array(midi), soundfont: font },
        // The worker is plain JS. Host/Electron/test-runner flags may be invalid in a Worker.
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      this.active = worker;
      let done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (this.active === worker) this.active = null;
        void worker.terminate();
        if (error) reject(error); else resolve({ ...result, wav: Buffer.from(result.wav) });
      };
      const timer = setTimeout(() => finish(new Error('生成音频超过 120 秒，请缩短乐谱。')), 120000);
      worker.once('message', result => finish(result.error ? new Error(result.error) : null, result));
      worker.once('error', error => finish(error));
      worker.once('exit', code => { if (!done) finish(new Error(`音频任务已停止（${code}）。`)); });
    });
  }
  stop() { if (this.active) void this.active.terminate(); }
}
