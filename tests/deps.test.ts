import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseNvidiaSmi, tierFor, CUDA_MIN_VRAM_MB } from '../src/gpu.ts';
import { parseUvVersion, uvKnownPaths } from '../src/uv.ts';
import { missingWeights, isProjectDir, projectDir, weightsDir, ProjectEnvJob } from '../src/install.ts';
import { FIRERED_VAD_FILES, TIER_WEIGHTS } from '../src/catalog.ts';
import { Job } from '../src/jobs.ts';

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'audio-deps-')); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('显卡检测', () => {
  it('解析 nvidia-smi 的四列输出', () => {
    const gpus = parseNvidiaSmi([
      '0, NVIDIA GeForce RTX 3080, 10240, 566.36',
      '1, NVIDIA GeForce RTX 3070, 8192, 566.36',
      '',
    ].join('\r\n'));
    expect(gpus).toEqual([
      { index: 0, name: 'NVIDIA GeForce RTX 3080', vramMB: 10240, driver: '566.36' },
      { index: 1, name: 'NVIDIA GeForce RTX 3070', vramMB: 8192, driver: '566.36' },
    ]);
  });

  it('跳过认不出的行', () => {
    expect(parseNvidiaSmi('garbage\n\n')).toEqual([]);
  });

  it('显存够才用显卡档，显式指定时不看显卡', () => {
    const big = [{ index: 0, name: 'x', vramMB: CUDA_MIN_VRAM_MB, driver: '1' }];
    const small = [{ index: 0, name: 'x', vramMB: CUDA_MIN_VRAM_MB - 1, driver: '1' }];
    expect(tierFor(big)).toBe('cuda');
    expect(tierFor(small)).toBe('cpu');
    expect(tierFor([])).toBe('cpu');
    expect(tierFor([], 'cuda')).toBe('cuda');
    expect(tierFor(big, 'cpu')).toBe('cpu');
  });
});

describe('uv 识别', () => {
  it('从 --version 输出里取版本号', () => {
    expect(parseUvVersion('uv 0.8.15 (abc1234 2025-09-01)')).toBe('0.8.15');
    expect(parseUvVersion('nonsense')).toBe(null);
  });

  it('常见位置都带 .exe 后缀', () => {
    const paths = uvKnownPaths({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'C:\\Users\\x');
    expect(paths.every((p) => p.endsWith('uv.exe'))).toBe(true);
    expect(paths.some((p) => p.includes('.local'))).toBe(true);
  });
});

describe('GPT-SoVITS 安装', () => {
  it('项目目录以引擎 id 与 commit 分层，缺 api_v2.py 就不算装好', () => {
    const roots = { runtimesRoot: () => join(scratch, 'runtimes'), modelsRoot: () => join(scratch, 'models') };
    const dir = projectDir(roots);
    expect(dir.startsWith(join(scratch, 'runtimes', 'audio', 'gpt-sovits'))).toBe(true);
    expect(isProjectDir(dir)).toBe(false);
    mkdirSync(join(dir, 'GPT_SoVITS'), { recursive: true });
    writeFileSync(join(dir, 'api_v2.py'), '');
    expect(isProjectDir(dir)).toBe(true);
    expect(weightsDir(roots)).toBe(join(scratch, 'models', 'audio', 'gpt-sovits'));
  });

  it('按大小判断缺哪些权重，已下好的不再算', () => {
    const dir = join(scratch, 'weights');
    const files = [
      { path: 'a/s1.ckpt', bytes: 4, sha256: '', sources: [] },
      { path: 'b/model.bin', bytes: 6, sha256: '', sources: [] },
    ];
    expect(missingWeights(dir, files)).toHaveLength(2);
    mkdirSync(dirname(join(dir, 'a/s1.ckpt')), { recursive: true });
    writeFileSync(join(dir, 'a/s1.ckpt'), Buffer.alloc(4));
    expect(missingWeights(dir, files).map((f) => f.path)).toEqual(['b/model.bin']);
    // 大小不对也算缺
    writeFileSync(join(dir, 'a/s1.ckpt'), Buffer.alloc(3));
    expect(missingWeights(dir, files).map((f) => f.path)).toContain('a/s1.ckpt');
  });

  it('两档各有一套权重清单，共用 s1v3', () => {
    const pathOf = (tier: 'cuda' | 'cpu'): string[] => TIER_WEIGHTS[tier].map((f) => f.path);
    expect(pathOf('cuda')).toContain('s1v3.ckpt');
    expect(pathOf('cpu')).toContain('s1v3.ckpt');
    expect(pathOf('cuda')).toContain('gsv-v5-pretrained/s2Gv5turbo.pth');
    expect(pathOf('cpu')).toContain('v2Pro/s2Gv2ProPlus.pth');
  });
});

describe('FireRed VAD 模型清单', () => {
  it('两个模型文件都钉了大小与来路', () => {
    expect(FIRERED_VAD_FILES.map((file) => file.path)).toEqual([
      'fireredvad_stream_vad_with_cache.onnx',
      'fireredvad_aed.onnx',
      'cmvn.ark',
    ]);
    for (const file of FIRERED_VAD_FILES) {
      expect(file.bytes).toBeGreaterThan(1000);
      expect(file.sources.length).toBeGreaterThan(0);
    }
  });
});

describe('获取中途失败', () => {
  it('项目环境缺 uv 时停在「先装 uv」，不往下跑', async () => {
    const dir = join(scratch, 'project');
    mkdirSync(dir, { recursive: true });
    const job = new ProjectEnvJob({ dir: () => dir, uv: async () => '' });
    await job.install();
    const state = job.status();
    expect(state.phase).toBe('error');
    expect(state.detail).toContain('先装 uv');
    expect(job.busy()).toBe(false);
  });

  it('项目源码没装就先装环境：直接说「先装项目源码」', async () => {
    const job = new ProjectEnvJob({ dir: () => join(scratch, 'absent'), uv: async () => 'uv.exe' });
    await job.install();
    expect(job.status()).toMatchObject({ phase: 'error', detail: '先装项目源码。' });
  });
});

describe('安装任务状态', () => {
  it('卸载后的重置会清掉上一次的失败原因', async () => {
    class FailingJob extends Job {
      protected present(): boolean { return false; }
      protected async work(): Promise<void> { throw new Error('boom'); }
    }
    const job = new FailingJob();
    await job.install();
    expect(job.status()).toMatchObject({ phase: 'error', detail: 'boom' });
    job.reset();
    expect(job.status()).toMatchObject({ phase: 'absent', detail: null });
  });
});
