/** ffmpeg：先找本机已有的（配置 → PATH → 常见位置 → 自己装的那份），都没有才下载静态包。 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { downloadVerified, extractZip } from './download.ts';

export type FfmpegSource = 'config' | 'path' | 'known' | 'installed';

export interface FfmpegInfo {
  path: string | null;
  version: string | null;
  source: FfmpegSource | null;
  detail: string | null;
}

/** 常见安装位置；winget / chocolatey / 手动解压的目录都在内。 */
export function ffmpegKnownPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dirs = [
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '',
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'ffmpeg', 'bin') : '',
    env.ProgramData ? join(env.ProgramData, 'chocolatey', 'bin') : '',
    'C:\\ffmpeg\\bin',
    join(home, 'ffmpeg', 'bin'),
  ].filter(Boolean);
  return dirs.map((dir) => join(dir, 'ffmpeg.exe'));
}

/** `ffmpeg version 7.1-full_build-www.gyan.dev ...` → `7.1-full_build-www.gyan.dev`。 */
export function parseFfmpegVersion(stdout: string): string | null {
  const m = /ffmpeg version (\S+)/i.exec(stdout);
  return m ? m[1] : null;
}

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<{ code: number | null; stdout: string; stderr: string; error: NodeJS.ErrnoException | null }> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: { code: number | null; stdout: string; stderr: string; error: NodeJS.ErrnoException | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
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

/** 问一次 `ffmpeg -version`（版本行写在 stdout，部分构建写在 stderr）。 */
export async function probeFfmpeg(path: string): Promise<string | null> {
  if (path !== 'ffmpeg' && !existsSync(path)) return null;
  const result = await run(path, ['-version']);
  if (result.error?.code === 'ENOENT') return null;
  return parseFfmpegVersion(`${result.stdout}\n${result.stderr}`);
}

export async function detectFfmpeg(override = ''): Promise<FfmpegInfo> {
  const tried: string[] = [];
  const candidates: Array<{ path: string; source: FfmpegSource }> = [];
  if (override.trim()) candidates.push({ path: resolve(override.trim()), source: 'config' });
  candidates.push({ path: 'ffmpeg', source: 'path' });
  for (const path of ffmpegKnownPaths()) candidates.push({ path, source: 'known' });
  for (const candidate of candidates) {
    if (candidate.path !== 'ffmpeg' && !existsSync(candidate.path)) continue;
    const version = await probeFfmpeg(candidate.path);
    if (version) return { path: candidate.path === 'ffmpeg' ? 'ffmpeg' : candidate.path, version, source: candidate.source, detail: null };
    tried.push(candidate.path);
  }
  return { path: null, version: null, source: null, detail: tried.length ? `试过 ${tried.length} 处，都不像 ffmpeg` : '没有找到 ffmpeg' };
}

/** BtbN 的 Windows 静态包；镜像在前，GitHub 在后。 */
export const FFMPEG_ZIP_SOURCES: readonly string[] = [
  'https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
  'https://gh-proxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
];

/** 下载静态包，把 ffmpeg.exe 与 ffprobe.exe 放到 `<into>/`。 */
export async function installFfmpeg(into: string, signal: AbortSignal, onBytes?: (n: number) => void): Promise<FfmpegInfo> {
  mkdirSync(into, { recursive: true });
  const tmp = join(into, '.tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(tmp, 'ffmpeg.zip');
  await downloadVerified(FFMPEG_ZIP_SOURCES, archive, { signal, onBytes });
  await extractZip(archive, tmp);
  rmSync(archive, { force: true });
  const found = findExes(tmp);
  if (!found.ffmpeg) throw new Error('压缩包里没有 ffmpeg.exe');
  for (const [name, src] of Object.entries(found)) {
    if (!src) continue;
    const dest = join(into, `${name}.exe`);
    rmSync(dest, { force: true });
    renameSync(src, dest);
  }
  rmSync(tmp, { recursive: true, force: true });
  const version = await probeFfmpeg(join(into, 'ffmpeg.exe'));
  if (!version) throw new Error('装好的 ffmpeg 起不来（-version 失败）');
  return { path: join(into, 'ffmpeg.exe'), version, source: 'installed', detail: null };
}

function findExes(dir: string): { ffmpeg?: string; ffprobe?: string } {
  const found: { ffmpeg?: string; ffprobe?: string } = {};
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      Object.assign(found, findExes(path));
      continue;
    }
    const lower = entry.toLowerCase();
    if (lower === 'ffmpeg.exe') found.ffmpeg = path;
    if (lower === 'ffprobe.exe') found.ffprobe = path;
  }
  return found;
}
