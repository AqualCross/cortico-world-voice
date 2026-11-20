/** ffmpeg：先找配置、再找 PATH（解析成真实路径），都没有才下载静态包。 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { downloadVerified, extractZip } from './download.ts';
import { fetchWithProxy } from './proxy.ts';

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

/**
 * BtbN 的 Windows 静态包。BtbN 只保留最近几天的 autobuild，钉死某个 tag 过几天就会 404；
 * `latest` 标签下资产名固定，内容每天随构建更新。所以不把大小与 SHA-256 写死在代码里，
 * 下载前从同一 release 的 checksums.sha256 现取哈希；镜像在前，GitHub 在后。
 */
export const FFMPEG_RELEASE = 'latest';
export const FFMPEG_ZIP_NAME = 'ffmpeg-master-latest-win64-gpl.zip';
const ffmpegUrl = (prefix: string, file = FFMPEG_ZIP_NAME): string => `${prefix}https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${file}`;
export const FFMPEG_ZIP_SOURCES: readonly string[] = [
  ffmpegUrl('https://ghfast.top/'),
  ffmpegUrl('https://gh-proxy.com/'),
  ffmpegUrl(''),
];
export const FFMPEG_CHECKSUM_SOURCES: readonly string[] = [
  ffmpegUrl('https://ghfast.top/', 'checksums.sha256'),
  ffmpegUrl('https://gh-proxy.com/', 'checksums.sha256'),
  ffmpegUrl('', 'checksums.sha256'),
];

/** 从 `checksums.sha256` 里取某个文件的 SHA-256。行格式是 `<64 位十六进制>  <文件名>`。 */
export function parseChecksums(text: string, name: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const file = match[2].replace(/^\.\//, '').split(/[\\/]/).pop();
    if (file === name) return match[1].toLowerCase();
  }
  return null;
}

/** 滚动资产的 SHA-256：清单和压缩包同一 release，按同样的镜像顺序取。 */
async function checksumFor(signal: AbortSignal): Promise<string> {
  const errors: string[] = [];
  for (const url of FFMPEG_CHECKSUM_SOURCES) {
    try {
      const res = await fetchWithProxy(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sha256 = parseChecksums(await res.text(), FFMPEG_ZIP_NAME);
      if (sha256) return sha256;
      throw new Error(`清单里没有 ${FFMPEG_ZIP_NAME}`);
    } catch (err) {
      if (signal.aborted) throw err;
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`取不到 ${FFMPEG_ZIP_NAME} 的校验和：\n${errors.slice(-3).join('\n')}`);
}

/** 下载静态包，把 ffmpeg.exe 与 ffprobe.exe 放到 `<into>/`。 */
export async function installFfmpeg(into: string, signal: AbortSignal, onBytes?: (n: number) => void): Promise<FfmpegInfo> {
  mkdirSync(into, { recursive: true });
  const tmp = join(into, '.tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(tmp, 'ffmpeg.zip');
  const sha256 = await checksumFor(signal);
  await downloadVerified(FFMPEG_ZIP_SOURCES, archive, { signal, onBytes, sha256 });
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
