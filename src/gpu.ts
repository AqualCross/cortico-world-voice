/** 显卡检测：问 nvidia-smi，解析型号、显存、驱动，并据此选推理档。 */
import { spawn } from 'node:child_process';

export interface GpuInfo {
  index: number;
  name: string;
  /** 显存，MB。 */
  vramMB: number;
  driver: string;
}

export type Tier = 'cuda' | 'cpu';

export interface GpuReport {
  /** ok=检测到；absent=没有 nvidia-smi；error=有命令但执行失败。 */
  state: 'ok' | 'absent' | 'error';
  gpus: GpuInfo[];
  /** 由显存决定：至少一张 >= 4 GB 才用显卡档。 */
  tier: Tier;
  detail: string | null;
}

/** NVIDIA 显卡档的最低显存；低于这个走 CPU 档更划算。 */
export const CUDA_MIN_VRAM_MB = 4096;

/** 解析 `--format=csv,noheader,nounits` 的四列：index, name, memory.total, driver_version。 */
export function parseNvidiaSmi(stdout: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 4) continue;
    const index = Number.parseInt(parts[0], 10);
    const vramMB = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(index)) continue;
    gpus.push({
      index,
      name: parts[1],
      vramMB: Number.isFinite(vramMB) ? vramMB : 0,
      driver: parts[3],
    });
  }
  return gpus;
}

export function tierFor(gpus: readonly GpuInfo[], override: Tier | 'auto' = 'auto'): Tier {
  if (override !== 'auto') return override;
  return gpus.some((g) => g.vramMB >= CUDA_MIN_VRAM_MB) ? 'cuda' : 'cpu';
}

const QUERY = ['--query-gpu=index,name,memory.total,driver_version', '--format=csv,noheader,nounits'];

/** 跑一次 nvidia-smi；没有这张卡/这个命令时返回 absent，不抛错。 */
export function detectGpu(timeoutMs = 5000): Promise<GpuReport> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (report: GpuReport): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(report);
    };
    const child = spawn('nvidia-smi', QUERY, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill();
      finish({ state: 'error', gpus: [], tier: 'cpu', detail: `nvidia-smi ${Math.round(timeoutMs / 1000)} 秒没有返回` });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT'
        ? { state: 'absent', gpus: [], tier: 'cpu', detail: '没有找到 nvidia-smi（没有 NVIDIA 驱动，或没有显卡）' }
        : { state: 'error', gpus: [], tier: 'cpu', detail: err.message });
    });
    child.on('close', (code) => {
      const gpus = parseNvidiaSmi(stdout);
      if (code === 0 && gpus.length) {
        finish({ state: 'ok', gpus, tier: tierFor(gpus), detail: null });
        return;
      }
      finish({
        state: code === 0 ? 'absent' : 'error',
        gpus,
        tier: tierFor(gpus),
        detail: (code === 0 ? 'nvidia-smi 没有列出显卡' : `nvidia-smi 退出码 ${code}`) + (stderr.trim() ? `：${stderr.trim().slice(0, 200)}` : ''),
      });
    });
  });
}
