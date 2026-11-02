/**
 * GPT-SoVITS 的「项目」与「权重」两件安装任务。
 * 项目落在 `<运行时根>/audio/gpt-sovits/<commit>/`，权重落在 `<模型根>/audio/gpt-sovits/`；
 * 都先写 `.partial`，校验通过再改名，失败不会留下半个成品。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Tier } from './gpu.ts';
import { GPT_SOVITS_COMMIT, PROJECT_SOURCES, RVC_ASSETS, RVC_COMMIT, RVC_PROJECT_SOURCES, SINGER_MARKER, SINGER_VOCODER, SINGER_VOCODER_MARKER, SILERO_VAD_SOURCES, SINGER_VOICEBANK, TIER_WEIGHTS, type PinnedFile } from './catalog.ts';
import { downloadVerified, extractZip } from './download.ts';
import { createProjectEnv, createUvEnv, envPython, killProcessesUnder, projectEnvReady } from './project-env.ts';
import { Job } from './jobs.ts';

export interface InstallRoots {
  /** `<部署根>/runtimes`。 */
  runtimesRoot: () => string;
  /** `<部署根>/models`。 */
  modelsRoot: () => string;
}

/** 项目目录：一个 commit 一个。 */
export function projectDir(roots: InstallRoots): string {
  return join(roots.runtimesRoot(), 'audio', 'gpt-sovits', GPT_SOVITS_COMMIT);
}

export function isProjectDir(dir: string): boolean {
  return existsSync(join(dir, 'api_v2.py')) && existsSync(join(dir, 'GPT_SoVITS'));
}

/** 权重目录：与档位无关，两档共用 `s1v3` / hubert / roberta。 */
export function weightsDir(roots: InstallRoots): string {
  return join(roots.modelsRoot(), 'audio', 'gpt-sovits');
}

/** 还没下全的文件（按大小判断；SHA-256 在下载时校验）。 */
export function missingWeights(dir: string, files: readonly PinnedFile[]): PinnedFile[] {
  return files.filter((f) => {
    const path = join(dir, f.path);
    if (!existsSync(path)) return true;
    // 没钉大小的文件（上游只给文件名）只看在不在。
    return f.bytes > 0 && statSync(path).size !== f.bytes;
  });
}

export class GptSovitsProjectJob extends Job {
  constructor(private readonly roots: InstallRoots) {
    super();
  }

  dir(): string {
    return projectDir(this.roots);
  }

  protected present(): boolean {
    return isProjectDir(this.dir());
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const dir = this.dir();
    const partial = `${dir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    this.state.detail = '下载源码';
    const archive = join(partial, 'project.zip');
    await downloadVerified(PROJECT_SOURCES, archive, {
      signal,
      onProgress: this.progressCounter(),
      onTotal: (n) => { this.state.total = n; },
    });
    // 下载完就把进度条收掉，后面显示阶段名。
    this.state.done = 0;
    this.state.total = 0;
    this.state.detail = '解压';
    await extractZip(archive, partial);
    rmSync(archive, { force: true });
    // GitHub 的 zip 会多一层 `GPT-SoVITS-<sha>/`，把它提到 partial 根上。
    const top = readdirSync(partial).filter((name) => statSync(join(partial, name)).isDirectory());
    const root = top.length === 1 ? join(partial, top[0]) : partial;
    if (!isProjectDir(root)) throw new Error('解压后没有 api_v2.py 与 GPT_SoVITS/，源码包不对');
    writeFileSync(join(root, 'audio-runtime.json'), JSON.stringify({
      id: 'gpt-sovits',
      upstream: GPT_SOVITS_COMMIT,
      installedAt: new Date().toISOString(),
    }, null, 2));
    this.state.detail = '替换项目目录';
    // 服务从这份项目目录里的 .venv 起 python；它还开着的话，删到一半就会卡在锁住的文件上。
    await killProcessesUnder(dir, ['uv.exe', 'python.exe']);
    rmSync(dir, { recursive: true, force: true });
    renameSync(root, dir);
    rmSync(partial, { recursive: true, force: true });
  }
}

export class GptSovitsWeightsJob extends Job {
  constructor(private readonly roots: InstallRoots, private readonly tier: () => Tier) {
    super();
  }

  dir(): string {
    return weightsDir(this.roots);
  }

  files(): readonly PinnedFile[] {
    return TIER_WEIGHTS[this.tier()];
  }

  missing(): PinnedFile[] {
    return missingWeights(this.dir(), this.files());
  }

  bytes(): number {
    return this.missing().reduce((n, f) => n + f.bytes, 0);
  }

  protected present(): boolean {
    return this.missing().length === 0;
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const dir = this.dir();
    mkdirSync(dir, { recursive: true });
    const todo = this.missing();
    this.state.total = todo.reduce((n, f) => n + f.bytes, 0);
    for (const file of todo) {
      this.state.detail = file.path;
      const dest = join(dir, file.path);
      const partial = `${dest}.partial`;
      mkdirSync(dirname(dest), { recursive: true });
      await downloadVerified(file.sources, partial, {
        bytes: file.bytes,
        sha256: file.sha256,
        signal,
        onProgress: this.progressCounter(),
      });
      renameSync(partial, dest);
    }
  }
}

// ---------------------------------------------------------------- RVC

export function rvcProjectDir(roots: InstallRoots): string {
  return join(roots.runtimesRoot(), 'audio', 'rvc', RVC_COMMIT.slice(0, 9));
}

export function isRvcProjectDir(dir: string): boolean {
  return existsSync(join(dir, 'infer')) && existsSync(join(dir, 'configs'));
}

export function rvcAssetsDir(roots: InstallRoots): string {
  return join(roots.modelsRoot(), 'audio', 'rvc');
}

/** RVC 源码：下载 zip、解压、把唯一顶层目录提到目标位置。 */
export class RvcProjectJob extends Job {
  constructor(private readonly roots: InstallRoots) {
    super();
  }

  dir(): string {
    return rvcProjectDir(this.roots);
  }

  protected present(): boolean {
    return isRvcProjectDir(this.dir());
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const dir = this.dir();
    const partial = `${dir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    this.state.detail = '下载源码';
    const archive = join(partial, 'project.zip');
    await downloadVerified(RVC_PROJECT_SOURCES, archive, { signal, onProgress: this.progressCounter(), onTotal: (n) => { this.state.total = n; } });
    // 下载完就把进度条收掉，后面显示阶段名。
    this.state.done = 0;
    this.state.total = 0;
    this.state.detail = '解压';
    await extractZip(archive, partial);
    rmSync(archive, { force: true });
    const top = readdirSync(partial).filter((name) => statSync(join(partial, name)).isDirectory());
    const root = top.length === 1 ? join(partial, top[0]) : partial;
    if (!isRvcProjectDir(root)) throw new Error('解压后没有 infer/ 与 configs/，源码包不对');
    writeFileSync(join(root, 'audio-runtime.json'), JSON.stringify({ id: 'rvc', upstream: RVC_COMMIT, installedAt: new Date().toISOString() }, null, 2));
    this.state.detail = '替换项目目录';
    // 上一轮中断留下的安装器或本机服务还占着这份目录里的 .venv，不先结束就删不干净。
    await killProcessesUnder(dir, ['uv.exe', 'python.exe']);
    rmSync(dir, { recursive: true, force: true });
    renameSync(root, dir);
    rmSync(partial, { recursive: true, force: true });
  }
}

/** RVC 的两个上游资产（ContentVec、F0 提取器）。 */
export class RvcAssetsJob extends Job {
  constructor(private readonly roots: InstallRoots) {
    super();
  }

  dir(): string {
    return rvcAssetsDir(this.roots);
  }

  missing(): PinnedFile[] {
    return missingWeights(this.dir(), RVC_ASSETS);
  }

  bytes(): number {
    return this.missing().reduce((n, f) => n + f.bytes, 0);
  }

  protected present(): boolean {
    return this.missing().length === 0;
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const dir = this.dir();
    mkdirSync(dir, { recursive: true });
    const todo = this.missing();
    this.state.total = todo.reduce((n, f) => n + f.bytes, 0);
    for (const file of todo) {
      this.state.detail = file.path;
      const dest = join(dir, file.path);
      const partial = `${dest}.partial`;
      mkdirSync(dirname(dest), { recursive: true });
      await downloadVerified(file.sources, partial, {
        bytes: file.bytes,
        sha256: file.sha256,
        signal,
        onProgress: this.progressCounter(),
      });
      renameSync(partial, dest);
    }
  }
}

// ---------------------------------------------------------------- DiffSinger

export function singerDir(roots: InstallRoots): string {
  return join(roots.modelsRoot(), 'audio', 'singer');
}

/** 声库目录：解压后哪个目录里有 dsconfig.yaml 就是它。 */
export function findSingerBank(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    if (existsSync(join(current, SINGER_MARKER))) return current;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) stack.push(path);
    }
  }
  return null;
}

/** 唱歌的 Python 环境（只装 diffsinger-utau；声库仍在 `models/audio/singer/`）。 */
export function singEnvDir(roots: InstallRoots): string {
  return join(roots.runtimesRoot(), 'audio', 'singer');
}

export class SingerModelsJob extends Job {
  constructor(private readonly roots: InstallRoots) {
    super();
  }

  dir(): string {
    return singerDir(this.roots);
  }

  protected present(): boolean {
    const bank = findSingerBank(this.dir());
    return !!bank && existsSync(join(bank, SINGER_VOCODER_MARKER));
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const dir = this.dir();
    mkdirSync(dir, { recursive: true });
    this.state.total = SINGER_VOICEBANK.bytes + SINGER_VOCODER.bytes;
    this.state.detail = '下载声库';
    const bankZip = join(dir, SINGER_VOICEBANK.path);
    await downloadVerified(SINGER_VOICEBANK.sources, bankZip, {
      bytes: SINGER_VOICEBANK.bytes,
      sha256: SINGER_VOICEBANK.sha256,
      signal,
      onProgress: this.progressCounter(),
    });
    this.state.detail = '解压声库';
    await extractZip(bankZip, dir);
    rmSync(bankZip, { force: true });
    const bank = findSingerBank(dir);
    if (!bank) throw new Error('声库解压后没有 dsconfig.yaml');
    if (!existsSync(join(bank, SINGER_VOCODER_MARKER))) {
      this.state.detail = '下载声码器';
      const vocoderZip = join(dir, SINGER_VOCODER.path);
      await downloadVerified(SINGER_VOCODER.sources, vocoderZip, {
        bytes: SINGER_VOCODER.bytes,
        sha256: SINGER_VOCODER.sha256,
        signal,
        onProgress: this.progressCounter(),
      });
      this.state.detail = '解压声码器';
      mkdirSync(join(bank, 'dsvocoder'), { recursive: true });
      await extractZip(vocoderZip, join(bank, 'dsvocoder'));
      rmSync(vocoderZip, { force: true });
    }
    if (!existsSync(join(bank, SINGER_VOCODER_MARKER))) throw new Error('声码器装好后仍缺 dsvocoder/vocoder.yaml');
  }
}

// ---------------------------------------------------------------- 听：VAD 与识别模型

export function vadDir(roots: InstallRoots): string {
  return join(roots.modelsRoot(), 'audio', 'vad');
}

export function sttDir(roots: InstallRoots, engine: 'sensevoice' | 'paraformer'): string {
  return join(roots.modelsRoot(), 'audio', 'stt', engine);
}

/** 一组固定文件的安装任务；`files()` 决定装什么，`present()` 以大小为准。 */
export class ModelFilesJob extends Job {
  constructor(
    private readonly dir: () => string,
    private readonly files: () => readonly PinnedFile[],
  ) {
    super();
  }

  missing(): PinnedFile[] {
    return missingWeights(this.dir(), this.files());
  }

  bytes(): number {
    return this.missing().reduce((n, f) => n + f.bytes, 0);
  }

  protected present(): boolean {
    return this.files().length > 0 && this.missing().length === 0;
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const dir = this.dir();
    mkdirSync(dir, { recursive: true });
    const todo = this.missing();
    this.state.total = todo.reduce((n, f) => n + f.bytes, 0);
    for (const file of todo) {
      this.state.detail = file.path;
      const dest = join(dir, file.path);
      const partial = `${dest}.partial`;
      mkdirSync(dirname(dest), { recursive: true });
      await downloadVerified(file.sources, partial, {
        bytes: file.bytes || undefined,
        sha256: file.sha256 || undefined,
        signal,
        onProgress: this.progressCounter(),
      });
      renameSync(partial, dest);
    }
  }
}

/** VAD 模型只有一个文件，大小不钉，装完至少要非空。 */
export class VadJob extends ModelFilesJob {
  constructor(roots: InstallRoots) {
    super(
      () => vadDir(roots),
      () => [{ path: 'silero_vad.onnx', bytes: 0, sha256: '', sources: SILERO_VAD_SOURCES }],
    );
  }
}


// ---------------------------------------------------------------- FireRed VAD（ONNX 模型）

/** FireRed 的两个模型文件放在 models/audio/vad/firered/（约 2.3 MB）。 */
export function fireRedModelDir(roots: InstallRoots): string {
  return join(vadDir(roots), 'firered');
}

/** 单个项目的 venv：在项目目录里建，装它自己的 requirements。 */
export interface ProjectEnvSpec {
  dir: () => string;
  uv: () => Promise<string>;
  torch?: () => { indexes: readonly string[]; packages: readonly string[] };
  preinstall?: () => readonly string[];
  /** 项目根没有 requirements.txt 时显式装的依赖；装完记进 `.audio-env.json`，清单变了就当没装好。 */
  packages?: () => readonly string[];
  requirements?: (text: string) => string;
}

export class ProjectEnvJob extends Job {
  constructor(private readonly spec: ProjectEnvSpec) {
    super();
  }

  dir(): string {
    return this.spec.dir();
  }

  protected present(): boolean {
    // 光有 python.exe 不算：装依赖中途失败也会留下一个空壳 venv。
    const dir = this.dir();
    if (!projectEnvReady(dir) || !existsSync(join(dir, '.audio-env.json'))) return false;
    const want = this.spec.packages?.() ?? [];
    if (!want.length) return true;
    // 显式依赖的清单写进 .audio-env.json；改过清单或装到一半就重装。
    try {
      const got = JSON.parse(readFileSync(join(dir, '.audio-env.json'), 'utf8')) as { packages?: unknown };
      const list = got.packages;
      return Array.isArray(list) && list.length === want.length && want.every((name, index) => list[index] === name);
    } catch {
      return false;
    }
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const dir = this.dir();
    if (!existsSync(dir)) throw new Error('先装项目源码。');
    const uv = await this.spec.uv();
    if (!uv) throw new Error('先装 uv：依赖页的 uv 卡片。');
    await createProjectEnv({
      uv,
      dir,
      signal,
      torch: this.spec.torch?.(),
      preinstall: this.spec.preinstall?.(),
      packages: this.spec.packages?.(),
      requirements: this.spec.requirements,
      onStage: (stage) => { this.state.detail = stage; },
    });
  }
}

// ---------------------------------------------------------------- 本机识别环境（独立 venv）

/** 装本机识别用的独立 venv；`sttDir` 那份是模型，这份是 Python 环境。 */
export function asrEnvDir(roots: InstallRoots): string {
  return join(roots.runtimesRoot(), 'audio', 'stt-sensevoice');
}

export const STT_PACKAGES: readonly string[] = ['sherpa-onnx==2.0.1', 'numpy'];
/** 每个独立 venv 装的东西不一样，自检也得跟着换，不能统一 import sherpa_onnx。 */
export const STT_CHECK = 'import sherpa_onnx, numpy;print(sherpa_onnx.__version__)';

export class UvPackagesJob extends Job {
  constructor(
    private readonly dir: () => string,
    private readonly uv: () => Promise<string>,
    private readonly packages: readonly string[],
    private readonly check: string,
  ) {
    super();
  }

  protected present(): boolean {
    const dir = this.dir();
    return existsSync(envPython(dir)) && existsSync(join(dir, '.audio-env.json'));
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const uv = await this.uv();
    if (!uv) throw new Error('先装 uv（依赖页第一行）。');
    await createUvEnv({ uv, dir: this.dir(), packages: this.packages, check: this.check, signal, onStage: (stage) => this.report(stage) });
  }
}
