import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Job, type JobState } from './jobs.ts';
import type { InstallRoots } from './install.ts';
import { downloadVerified, extractZip as extractArchive } from './download.ts';
import { createProjectEnv, projectPython } from './project-env.ts';
import type { Tier } from './gpu.ts';

export const DEMUCS_SCRIPT = fileURLToPath(new URL('../python/music_separate.py', import.meta.url));
export const DEMUCS_VERSION = '0.3.4';
/** 显卡档的执行器；`[cuda,cudnn]` 把 CUDA 13 与 cuDNN 9 的运行库一并装进 venv，不用本机再装 CUDA。 */
export const DEMUCS_GPU_PACKAGE = 'onnxruntime-gpu[cuda,cudnn]==1.31.1';
export const DEMUCS_SOURCE = {
  bytes: 90_431,
  sha256: 'bb1ba1a90b77e75b1061bdeaf94ecfcba9cb666fba21bf33b9f000fb2a053de3',
  sources: ['https://files.pythonhosted.org/packages/7d/77/b7c686bcb62ca25c8a840dd76a199a72f8e174135ebeb0cccd99f662fc9a/demucs_onnx-0.3.4.tar.gz'],
} as const;
export const DEMUCS_MODEL = {
  filename: 'htdemucs_fp16weights.onnx',
  bytes: 165_612_636,
  sha256: 'd05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a',
  revision: 'd54ed9eb60e258ea82131c6ee14578628816456a',
} as const;

export interface DemucsStages {
  source: JobState & { dir: string };
  environment: JobState & { dir: string };
  weights: JobState & { dir: string };
}

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; }
  catch { return null; }
}

/** 代码与 .venv 分目录保存，更新源码不覆盖已装好的环境。 */
export class DemucsSourceJob extends Job {
  constructor(private readonly target: string) { super(); }
  dir(): string { return this.target; }

  protected present(): boolean {
    const marker = readJson(join(this.target, '.audio-source.json'));
    return marker?.version === DEMUCS_VERSION && marker?.sha256 === DEMUCS_SOURCE.sha256
      && ['pyproject.toml', 'src/demucs_onnx/__init__.py', 'src/demucs_onnx/inference.py', 'src/demucs_onnx/_audio.py'].every((file) => existsSync(join(this.target, file)));
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const partial = `${this.target}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    const archive = join(partial, `demucs_onnx-${DEMUCS_VERSION}.tar.gz`);
    this.report('下载中');
    await downloadVerified(DEMUCS_SOURCE.sources, archive, {
      bytes: DEMUCS_SOURCE.bytes, sha256: DEMUCS_SOURCE.sha256, signal,
      onProgress: this.progressCounter(), onTotal: (bytes) => { this.state.total = bytes; },
    });
    signal.throwIfAborted();
    this.state.done = 0; this.state.total = 0;
    this.report('解压中');
    await extractArchive(archive, partial);
    signal.throwIfAborted();
    const source = join(partial, `demucs_onnx-${DEMUCS_VERSION}`);
    if (!existsSync(join(source, 'src', 'demucs_onnx', 'inference.py'))) throw new Error('Demucs ONNX 源码包缺少推理入口。');
    writeFileSync(join(source, '.audio-source.json'), JSON.stringify({ version: DEMUCS_VERSION, sha256: DEMUCS_SOURCE.sha256 }));
    mkdirSync(dirname(this.target), { recursive: true });
    rmSync(this.target, { recursive: true, force: true });
    renameSync(source, this.target);
    rmSync(partial, { recursive: true, force: true });
  }
}

export class DemucsEnvironmentJob extends Job {
  constructor(
    private readonly target: string,
    private readonly source: DemucsSourceJob,
    private readonly uv: () => Promise<string>,
    private readonly tier: () => Tier,
  ) { super(); }
  dir(): string { return this.target; }
  python(): string { return projectPython(this.target); }
  /** 显卡档多装 GPU 执行器；CPU 档由 demucs-onnx 的依赖带出 CPU 版。档位变了靠这里让环境重装。 */
  packages(): readonly string[] {
    return this.tier() === 'cuda' ? [this.source.dir(), DEMUCS_GPU_PACKAGE] : [this.source.dir()];
  }

  protected present(): boolean {
    const marker = readJson(join(this.target, '.audio-env.json'));
    if (!existsSync(this.python())) return false;
    return JSON.stringify(marker?.packages) === JSON.stringify(this.packages());
  }

  protected async work(signal: AbortSignal): Promise<void> {
    if (this.source.status().phase !== 'ready') throw new Error('先获取 Demucs 源码。');
    const uv = await this.uv();
    if (!uv) throw new Error('先在「依赖」页获取 uv。');
    mkdirSync(this.target, { recursive: true });
    const gpu = this.tier() === 'cuda';
    this.report(gpu ? '安装中（显卡运行库）' : '安装中');
    await createProjectEnv({
      uv, dir: this.target, signal,
      packages: [this.source.dir()],
      // demucs-onnx 依赖 CPU 版 onnxruntime；装完再换成 GPU 版，两个包共用同一个模块名不能并存。
      replace: gpu ? { remove: ['onnxruntime', 'onnxruntime-gpu'], packages: [DEMUCS_GPU_PACKAGE] } : undefined,
      onStage: () => this.report(gpu ? '安装中（显卡运行库）' : '安装中'),
    });
  }
}

export class DemucsWeightsJob extends Job {
  constructor(private readonly target: string) { super(); }
  dir(): string { return this.target; }

  protected present(): boolean {
    const marker = readJson(join(this.target, 'ready.json'));
    const file = join(this.target, DEMUCS_MODEL.filename);
    return marker?.model === 'htdemucs-onnx' && marker?.sha256 === DEMUCS_MODEL.sha256
      && existsSync(file) && statSync(file).size === DEMUCS_MODEL.bytes;
  }

  protected async work(signal: AbortSignal): Promise<void> {
    mkdirSync(this.target, { recursive: true });
    this.report('下载中');
    const partial = join(this.target, `${DEMUCS_MODEL.filename}.partial`);
    const path = `StemSplitio/htdemucs-onnx/resolve/${DEMUCS_MODEL.revision}/${DEMUCS_MODEL.filename}`;
    await downloadVerified([`https://hf-mirror.com/${path}`, `https://huggingface.co/${path}`], partial, {
      bytes: DEMUCS_MODEL.bytes, sha256: DEMUCS_MODEL.sha256, signal,
      onProgress: this.progressCounter(), onTotal: (bytes) => { this.state.total = bytes; },
    });
    signal.throwIfAborted();
    renameSync(partial, join(this.target, DEMUCS_MODEL.filename));
    writeFileSync(join(this.target, 'ready.json'), JSON.stringify({ model: 'htdemucs-onnx', sha256: DEMUCS_MODEL.sha256 }));
  }
}

/** 源码、环境、权重顺序安装；各阶段独立判定，失败或取消后保留已完成阶段。 */
export class DemucsJob {
  readonly source: DemucsSourceJob;
  readonly environment: DemucsEnvironmentJob;
  readonly weights: DemucsWeightsJob;
  private running: Promise<void> | null = null;
  private cancelled = false;

  constructor(
    private readonly roots: InstallRoots,
    uv: () => Promise<string>,
    tier: () => Tier,
  ) {
    this.source = new DemucsSourceJob(this.codeDir());
    this.environment = new DemucsEnvironmentJob(this.dir(), this.source, uv, tier);
    this.weights = new DemucsWeightsJob(this.modelsDir());
  }

  dir(): string { return join(this.roots.runtimesRoot(), 'audio', 'demucs-onnx'); }
  codeDir(): string { return join(this.dir(), 'source', DEMUCS_VERSION); }
  modelsDir(): string { return join(this.roots.modelsRoot(), 'audio', 'demucs-onnx'); }
  python(): string { return this.environment.python(); }

  stages(): DemucsStages {
    return {
      source: { ...this.source.status(), dir: this.source.dir() },
      environment: { ...this.environment.status(), dir: this.environment.dir() },
      weights: { ...this.weights.status(), dir: this.weights.dir() },
    };
  }

  status(): JobState {
    const stages = this.stages();
    const entries = [['源码', stages.source], ['环境', stages.environment], ['权重', stages.weights]] as const;
    if (entries.every(([, state]) => state.phase === 'ready')) return { phase: 'ready', done: 0, total: 0, detail: null };
    const active = entries.find(([, state]) => state.phase === 'working') ?? entries.find(([, state]) => state.phase === 'error');
    if (active) {
      const [name, state] = active;
      return { ...state, detail: `${name} ${state.detail ?? (state.phase === 'working' ? '获取中' : '失败')}` };
    }
    return { phase: this.cancelled ? 'error' : 'absent', done: 0, total: 0, detail: this.cancelled ? '已取消' : null };
  }

  install(): Promise<void> {
    if (this.running) return this.running;
    this.cancelled = false;
    this.running = Promise.resolve().then(async () => {
      for (const step of [this.source, this.environment, this.weights]) {
        if (this.cancelled) break;
        if (step.status().phase === 'ready') continue;
        await step.install();
        if (step.status().phase !== 'ready') break;
      }
    }).finally(() => { this.running = null; });
    return this.running;
  }

  cancel(): void {
    if (this.running) this.cancelled = true;
    for (const step of [this.source, this.environment, this.weights]) step.cancel();
  }
}
