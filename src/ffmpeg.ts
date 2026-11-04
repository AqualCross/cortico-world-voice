/** ffmpeg：先找配置、再找 PATH（解析成真实路径），都没有才下载静态包。 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { downloadVerified, extractZip } from './download.ts';

export type FfmpegSource = 'config' | 'path' | 'installed';

export interface FfmpegInfo {
  path: string | null;
  version: string | null;
  source: FfmpegSource | null;
  detail: string | null;
}

/**
 * 在 PATH 里找可执行文件的真实位置（Windows 按 PATHEXT 补扩展名）。
 * 用户装在哪就认哪，不去猜固定目录；找不到返回 null。
 */
export function resolveOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = String(env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const exts = String(env.PATHEXT ?? (process.platform === 'win32' ? '.EXE;.CMD;.BAT;.COM' : ''))
    .split(';')
    .filter(Boolean);
  const names = [name, ...exts.flatMap((ext) => [`${name}${ext.toLowerCase()}`, `${name}${ext.toUpperCase()}`])];
  for (const dir of dirs) {
    for (const file of names) {
      const full = join(dir, file);
      if (existsSync(full)) return full;
    }
  }
  return null;
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
  const onPath = resolveOnPath('ffmpeg');
  if (onPath) candidates.push({ path: onPath, source: 'path' });
  for (const candidate of candidates) {
    const version = await probeFfmpeg(candidate.path);
    if (version) return { path: candidate.path, version, source: candidate.source, detail: null };
    tried.push(candidate.path);
  }
  return { path: null, version: null, source: null, detail: tried.length ? `试过 ${tried.length} 处，都不像 ffmpeg` : '没有找到 ffmpeg' };
}

/** BtbN 的 Windows 静态包，固定到某个 autobuild tag 并校验哈希；镜像在前，GitHub 在后。 */
export const FFMPEG_BUILD = 'autobuild-2026-11-01-12-49';
export const FFMPEG_ZIP_BYTES = 201_757_577;
export const FFMPEG_ZIP_SHA256 = 'ad99b0b94e68f2932391ad982c193b847c93ba41f17b7cafbf50710e15d45185';
const ffmpegUrl = (prefix: string): string => `${prefix}https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BUILD}/ffmpeg-N-128273-g836436cfb9-win64-gpl.zip`;
export const FFMPEG_ZIP_SOURCES: readonly string[] = [
  ffmpegUrl('https://ghfast.top/'),
  ffmpegUrl('https://gh-proxy.com/'),
  ffmpegUrl(''),
];

/** 下载静态包，把 ffmpeg.exe 与 ffprobe.exe 放到 `<into>/`。 */
export async function installFfmpeg(into: string, signal: AbortSignal, onBytes?: (n: number) => void): Promise<FfmpegInfo> {
  mkdirSync(into, { recursive: true });
  const tmp = join(into, '.tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(tmp, 'ffmpeg.zip');
  await downloadVerified(FFMPEG_ZIP_SOURCES, archive, { signal, onBytes, bytes: FFMPEG_ZIP_BYTES, sha256: FFMPEG_ZIP_SHA256 });
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
