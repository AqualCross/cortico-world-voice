/** uv：先识别本机已有的（配置 → PATH → 常见安装位置），都没有才下载一份到自己目录。 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { downloadVerified, extractZip } from './download.ts';

export type UvSource = 'config' | 'path' | 'known' | 'installed';

export interface UvInfo {
  path: string | null;
  version: string | null;
  source: UvSource | null;
  /** 识别不到时的说明。 */
  detail: string | null;
}

/** 常见安装位置；`uv tool install`、官方安装脚本、pipx 与 cargo 各放一处。 */
export function uvKnownPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'uv') : '',
    env.APPDATA ? join(env.APPDATA, 'uv') : '',
    env.ProgramData ? join(env.ProgramData, 'uv') : '',
  ].filter(Boolean);
  return dirs.map((dir) => join(dir, 'uv.exe'));
}

/** `uv 0.8.15 (abc1234 2025-09-01)` → `0.8.15`。 */
export function parseUvVersion(stdout: string): string | null {
  const m = /^uv\s+(\S+)/m.exec(stdout.trim());
  return m ? m[1] : null;
}

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<{ code: number | null; stdout: string; stderr: string; error: NodeJS.ErrnoException | null }> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { code: number | null; stdout: string; stderr: string; error: NodeJS.ErrnoException | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, error: null });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, error: err }));
    child.on('close', (code) => finish({ code, stdout, stderr, error: null }));
  });
}

/** 问一次 `uv --version`；拿到版本就算可用。 */
export async function probeUv(path: string): Promise<string | null> {
  if (path !== 'uv' && !existsSync(path)) return null;
  const result = await run(path, ['--version']);
  return result.code === 0 ? parseUvVersion(result.stdout) : null;
}

export async function detectUv(override = ''): Promise<UvInfo> {
  const tried: string[] = [];
  const candidates: Array<{ path: string; source: UvSource }> = [];
  if (override.trim()) candidates.push({ path: resolve(override.trim()), source: 'config' });
  candidates.push({ path: 'uv', source: 'path' });
  for (const path of uvKnownPaths()) candidates.push({ path, source: 'known' });
  for (const candidate of candidates) {
    if (candidate.path !== 'uv' && !existsSync(candidate.path)) continue;
    const version = await probeUv(candidate.path);
    if (version) return { path: candidate.path === 'uv' ? 'uv' : candidate.path, version, source: candidate.source, detail: null };
    tried.push(candidate.path);
  }
  return { path: null, version: null, source: null, detail: tried.length ? `试过 ${tried.length} 处，都不像 uv` : '没有找到 uv' };
}

/** 官方独立包（Windows x64），版本与哈希固定；镜像在前，GitHub 在后。 */
export const UV_VERSION = '0.13.6';
export const UV_ZIP_BYTES = 15_239_500;
export const UV_ZIP_SHA256 = 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f';
const uvUrl = (prefix: string): string => `${prefix}https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`;
export const UV_ZIP_SOURCES: readonly string[] = [
  uvUrl('https://ghfast.top/'),
  uvUrl('https://gh-proxy.com/'),
  uvUrl(''),
];

/**
 * 下载 uv 到 `<into>/uv.exe`，已有同目录就先删掉再放。
 * 下载与解压都在 `<into>/.tmp` 里做，最后只留 uv.exe 与许可证。
 */
export async function installUv(into: string, signal: AbortSignal, onBytes?: (n: number) => void): Promise<UvInfo> {
  mkdirSync(into, { recursive: true });
  const tmp = join(into, '.tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(tmp, 'uv.zip');
  await downloadVerified(UV_ZIP_SOURCES, archive, { signal, onBytes, bytes: UV_ZIP_BYTES, sha256: UV_ZIP_SHA256 });
  await extractZip(archive, tmp);
  rmSync(archive, { force: true });
  const exe = findUvExe(tmp);
  if (!exe) throw new Error('压缩包里没有 uv.exe');
  const dest = join(into, 'uv.exe');
  rmSync(dest, { force: true });
  renameSync(exe, dest);
  rmSync(tmp, { recursive: true, force: true });
  const version = await probeUv(dest);
  if (!version) throw new Error('装好的 uv 起不来（--version 失败）');
  return { path: dest, version, source: 'installed', detail: null };
}

function findUvExe(dir: string): string | null {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const nested = findUvExe(path);
      if (nested) return nested;
    } else if (entry.toLowerCase() === 'uv.exe') {
      return path;
    }
  }
  return null;
}
