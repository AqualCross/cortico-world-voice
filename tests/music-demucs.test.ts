import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DemucsJob, DEMUCS_GPU_PACKAGE, DEMUCS_MODEL, DEMUCS_SOURCE, DEMUCS_VERSION } from '../src/music-demucs.ts';

let dir: string;
let job: DemucsJob;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audio-demucs-stages-'));
  job = new DemucsJob({ runtimesRoot: () => join(dir, 'runtimes'), modelsRoot: () => join(dir, 'models') }, async () => 'uv', () => 'cpu');
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
function sourceReady(): void {
  for (const file of ['pyproject.toml', 'src/demucs_onnx/__init__.py', 'src/demucs_onnx/inference.py', 'src/demucs_onnx/_audio.py']) write(join(job.codeDir(), file), 'fixture');
  write(join(job.codeDir(), '.audio-source.json'), JSON.stringify({ version: DEMUCS_VERSION, sha256: DEMUCS_SOURCE.sha256 }));
}
function environmentReady(): void {
  write(job.python(), 'fixture');
  write(join(job.dir(), '.audio-env.json'), JSON.stringify({ packages: job.environment.packages() }));
}
function weightsReady(): void {
  mkdirSync(job.modelsDir(), { recursive: true });
  const fd = openSync(join(job.modelsDir(), DEMUCS_MODEL.filename), 'w');
  try { ftruncateSync(fd, DEMUCS_MODEL.bytes); } finally { closeSync(fd); }
  write(join(job.modelsDir(), 'ready.json'), JSON.stringify({ model: 'htdemucs-onnx', sha256: DEMUCS_MODEL.sha256 }));
}
const work = (step: object) => vi.spyOn(step as { work(signal: AbortSignal): Promise<void> }, 'work');

describe('Demucs ONNX 三阶段', () => {
  it('源码、环境和权重分别从磁盘判断，不把旧 PyTorch 安装当作 ONNX 已装', () => {
    write(join(dir, 'runtimes/audio/demucs/.audio-env.json'), JSON.stringify({ packages: ['demucs==4.0.1'] }));
    write(join(job.modelsDir(), 'ready.json'), JSON.stringify({ model: 'htdemucs', files: ['old.th'] }));
    expect(Object.values(job.stages()).map((state) => state.phase)).toEqual(['absent', 'absent', 'absent']);
    sourceReady();
    expect(Object.values(job.stages()).map((state) => state.phase)).toEqual(['ready', 'absent', 'absent']);
    environmentReady();
    expect(Object.values(job.stages()).map((state) => state.phase)).toEqual(['ready', 'ready', 'absent']);
    weightsReady();
    expect(job.status().phase).toBe('ready');
    rmSync(join(job.modelsDir(), DEMUCS_MODEL.filename));
    expect(job.weights.status().phase).toBe('absent');
    expect(job.status().phase).toBe('absent');
  });

  it('显卡档装 GPU 执行器，档位换了环境按标记重装', () => {
    const gpu = new DemucsJob({ runtimesRoot: () => join(dir, 'runtimes'), modelsRoot: () => join(dir, 'models') }, async () => 'uv', () => 'cuda');
    expect(gpu.environment.packages()).toEqual([gpu.source.dir(), DEMUCS_GPU_PACKAGE]);
    expect(job.environment.packages()).toEqual([job.source.dir()]);
    sourceReady();
    environmentReady();
    expect(job.environment.status().phase).toBe('ready');
    expect(gpu.environment.status().phase).toBe('absent');
  });

  it('按源码→环境→权重执行，去重并发获取，环境失败后重试跳过源码', async () => {
    const order: string[] = [];
    const source = work(job.source).mockImplementation(async () => { order.push('source'); sourceReady(); });
    const environment = work(job.environment).mockImplementationOnce(async () => { order.push('environment'); throw new Error('download failed'); })
      .mockImplementation(async () => { order.push('environment'); environmentReady(); });
    const weights = work(job.weights).mockImplementation(async () => { order.push('weights'); weightsReady(); });
    const first = job.install();
    expect(job.install()).toBe(first);
    await first;
    expect(order).toEqual(['source', 'environment']);
    expect(job.status()).toMatchObject({ phase: 'error', detail: '环境 download failed' });
    expect(weights).not.toHaveBeenCalled();
    await job.install();
    expect(order).toEqual(['source', 'environment', 'environment', 'weights']);
    expect(source).toHaveBeenCalledTimes(1);
    expect(environment).toHaveBeenCalledTimes(2);
    expect(job.status().phase).toBe('ready');
    await job.install();
    expect(weights).toHaveBeenCalledTimes(1);
  });

  it('取消活动阶段不会继续安装环境和权重，之后可以重试', async () => {
    const source = work(job.source).mockImplementation(async (signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const environment = work(job.environment).mockImplementation(async () => environmentReady());
    const weights = work(job.weights).mockImplementation(async () => weightsReady());
    const pending = job.install();
    await expect.poll(() => job.source.status().phase).toBe('working');
    job.cancel();
    await pending;
    expect(job.status()).toMatchObject({ phase: 'error', detail: '源码 已取消' });
    expect(environment).not.toHaveBeenCalled();
    expect(weights).not.toHaveBeenCalled();
    source.mockImplementation(async () => sourceReady());
    await job.install();
    expect(job.status().phase).toBe('ready');
  });

  it('阶段刚完成时取消也会停在阶段边界，不丢失已完成源码', async () => {
    work(job.source).mockImplementation(async () => { sourceReady(); job.cancel(); });
    const environment = work(job.environment).mockImplementation(async () => environmentReady());
    const weights = work(job.weights).mockImplementation(async () => weightsReady());
    await job.install();
    expect(job.source.status().phase).toBe('ready');
    expect(job.status()).toMatchObject({ phase: 'error', detail: '已取消' });
    expect(environment).not.toHaveBeenCalled();
    expect(weights).not.toHaveBeenCalled();
  });
});
