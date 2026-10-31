/**
 * 列出「正在出声的应用」：靠 `vendor/audio-sessions.cs`（Add-Type 现场编译）拿有渲染会话的 PID，
 * 再用 PowerShell 的进程表补进程名与窗口标题。只在 Windows 有意义；结果缓存几秒。
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface AudioApp {
  id: string;
  name: string;
  pid: number;
  /** 窗口标题（常常就是正在放的那首歌）。 */
  title: string;
}

const SESSIONS_CS = fileURLToPath(new URL('../vendor/audio-sessions.cs', import.meta.url)).replace(/'/g, "''");
const TITLES_CS = fileURLToPath(new URL('../vendor/window-titles.cs', import.meta.url)).replace(/'/g, "''");

const SCRIPT = [
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  '$OutputEncoding=[System.Text.Encoding]::UTF8',
  '$ErrorActionPreference="Stop"',
  `Add-Type -Path '${SESSIONS_CS}'`,
  '$audioIds = @([ListenAudioSessions]::Read())',
  `Add-Type -Path '${TITLES_CS}'`,
  '$windows = @([ListenWindowTitles]::Read())',
  '$titles = @{}',
  'foreach ($w in $windows) {',
  '  $cls = [string]$w.cls',
  '  if ($cls -match "MSCTFIME|IME|GDI+|SystemTray|Network Flyout") { continue }',
  '  $pid2 = [int]$w.pid',
  '  if (-not $titles.ContainsKey($pid2) -or $w.visible) { $titles[$pid2] = [string]$w.title }',
  '}',
  '$rows = @(Get-CimInstance Win32_Process | Where-Object { $audioIds -contains [uint32]$_.ProcessId } | ForEach-Object {',
  '  [pscustomobject]@{ name=([string]$_.Name -replace "\\.exe$", ""); pid=[int]$_.ProcessId; title=([string]$titles[[int]$_.ProcessId]) }',
  '})',
  '$rows | ConvertTo-Json -Compress -Depth 3',
].join('; ');

/**
 * 一个进程的窗口标题：先看它自己的窗口；没有就沿父进程往上找（浏览器的音频会话在渲染进程里，
 * 标题挂在浏览器主进程的窗口上）。都找不到就用进程名。
 */
const TITLE_SCRIPT = (pid: number): string => [
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  '$OutputEncoding=[System.Text.Encoding]::UTF8',
  '$ErrorActionPreference="Stop"',
  `Add-Type -Path '${TITLES_CS}'`,
  '$rows = @([ListenWindowTitles]::Read())',
  '$best=""',
  '$hit=$false',
  `$cur=${pid}`,
  '$parents=$null',
  'for ($hop = 0; $hop -lt 8 -and $cur -gt 0; $hop++) {',
  '  foreach ($w in $rows) {',
  '    if ([int]$w.pid -ne $cur) { continue }',
  '    $cls = [string]$w.cls',
  '    if ($cls -match "MSCTFIME|IME|GDI+|SystemTray|Network Flyout") { continue }',
  '    $text = [string]$w.title',
  '    if ($text -eq "") { continue }',
  '    if ($w.visible) { $best = $text; $hit = $true; break }',
  '    if ($best -eq "") { $best = $text }',
  '  }',
  '  if ($hit) { break }',
  '  if ($null -eq $parents) {',
  '    $parents = @{}',
  '    foreach ($p in @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)) { $parents[[int]$p.ProcessId] = [int]$p.ParentProcessId }',
  '  }',
  '  $cur = [int]$parents[$cur]',
  '}',
  `$name = [string](Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`,
  '[pscustomobject]@{ name = $name; title = $best } | ConvertTo-Json -Compress',
].join('; ');

export interface AppInfo {
  /** 进程名（cloudmusic、msedge），进程不在了就是空串。 */
  name: string;
  /** 窗口标题；没有窗口时为空。 */
  title: string;
}

let cache: { at: number; apps: AudioApp[] } | null = null;
/**
 * 单个 PID 的进程名与窗口标题：切块和「应用监听」读它。一次查询约两秒，所以只在第一次等；
 * 之后先用旧值，过期了在后台换新的，别让采集链每块都停两秒。
 */
const APP_TTL_MS = 30_000;
const appCache = new Map<number, { at: number; info: AppInfo }>();
const appPending = new Map<number, Promise<AppInfo>>();
const NO_INFO: AppInfo = { name: '', title: '' };

export async function appInfoOf(pid: number): Promise<AppInfo> {
  const hit = appCache.get(pid);
  if (hit && Date.now() - hit.at < APP_TTL_MS) return hit.info;
  if (hit) {
    void lookupApp(pid);
    return hit.info;
  }
  return lookupApp(pid);
}

/** 事件的显示名：有窗口标题就用标题，没有就用进程名。 */
export async function windowTitleOf(pid: number): Promise<string> {
  const info = await appInfoOf(pid);
  return info.title || info.name;
}

function lookupApp(pid: number): Promise<AppInfo> {
  const inflight = appPending.get(pid);
  if (inflight) return inflight;
  const work = new Promise<AppInfo>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TITLE_SCRIPT(pid)], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      let info = NO_INFO;
      if (!err) {
        try {
          const parsed = JSON.parse(String(stdout).trim()) as { name?: unknown; title?: unknown };
          info = { name: String(parsed?.name ?? '').trim(), title: String(parsed?.title ?? '').trim() };
        } catch {
          info = NO_INFO;
        }
      }
      // 查不到也记一下，免得每块都等一次超时。
      appCache.set(pid, { at: Date.now(), info });
      resolve(info);
    });
  }).finally(() => appPending.delete(pid));
  appPending.set(pid, work);
  return work;
}

/** 缓存的列表；`fresh` 强制重查。 */
export async function listAudioApps(fresh = false): Promise<{ apps: AudioApp[]; error: string | null }> {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < 5000) return { apps: cache.apps, error: null };
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ apps: [], error: (stderr || err.message).trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 300) });
        return;
      }
      const text = String(stdout).trim();
      let parsed: unknown = [];
      try {
        parsed = text ? JSON.parse(text) : [];
      } catch {
        resolve({ apps: [], error: `进程表读不出来：${text.slice(0, 200)}` });
        return;
      }
      const list = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ name?: unknown; pid?: unknown; title?: unknown }>;
      const apps: AudioApp[] = list
        .filter((row) => typeof row?.name === 'string' && Number.isFinite(Number(row?.pid)))
        .map((row) => ({
          id: `app:${Number(row.pid)}`,
          name: String(row.name),
          pid: Number(row.pid),
          title: String(row.title ?? '').trim(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      cache = { at: now, apps };
      resolve({ apps, error: null });
    });
  });
}
