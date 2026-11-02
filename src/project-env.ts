/**
 * 单个项目的 Python 环境：在项目目录里 uv venv，再按它自己的依赖清单装。
 * 每个项目一份，互不共享；不追求统一 torch 版本——项目钉什么就装什么。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { proxyEnv } from './proxy.ts';

export const PROJECT_PYTHON = '3.12';


export function projectPython(dir: string): string {
  return process.platform === 'win32' ? join(dir, '.venv', 'Scripts', 'python.exe') : join(dir, '.venv', 'bin', 'python');
}

export function projectEnvReady(dir: string): boolean {
  return existsSync(projectPython(dir));
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

function run(command: string, args: string[], cwd: string, signal: AbortSignal, onLine?: (line: string) => void, env?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    // cwd 不存在时 spawn 照样抛 ENOENT，报的却是命令路径（spawn ...\uv.exe ENOENT），看着像 uv 没装。
    mkdirSync(cwd, { recursive: true });
    // 25 秒在慢镜像和大 wheel 上容易先断；uv 默认 30，这里给 60 秒，失败重试仍由 uv 自己做。
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, UV_PYTHON_DOWNLOADS: 'automatic', UV_HTTP_TIMEOUT: '60', ...env } });
    const feed = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) onLine?.(line);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); feed(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); feed(chunk); });
    const kill = (): void => {
      if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    };
    const onAbort = (): void => kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(cwd);
      resolve({ code: null, stdout, stderr: stderr + (missing ? `工作目录不存在：${cwd}（${err.message}）` : err.message), aborted: signal.aborted });
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, aborted: signal.aborted });
    });
  });
}

const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300);

/** 进度条用 \r 重绘并带 ANSI 颜色；留错误原因时只保留每行最后一次画面。 */
function cleanOutput(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.split('\r').filter((part) => part.trim()).pop() ?? '')
    .filter((line) => line.trim())
    .join('\n')
    .trim();
}

const PS = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

/** 结束命令行里带着这个目录的进程：安装器与本机服务的 python 占着目录里的文件，删除和改名都会失败。 */
export async function killProcessesUnder(dir: string, exes: readonly string[]): Promise<void> {
  if (process.platform !== 'win32' || !exes.length) return;
  const filter = exes.map((exe) => `Name='${exe.replace(/'/g, "''")}'`).join(' or ');
  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    `$needle='${dir.replace(/'/g, "''")}'.ToLower()`,
    `Get-CimInstance Win32_Process -Filter "${filter}" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle) } | ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F | Out-Null }`,
  ].join('; ');
  await new Promise<void>((resolve) => {
    execFile(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 }, () => resolve());
  });
}

/** 上一轮安装的 uv 与本机服务的 python 会让 `.venv` 删不掉；不先结束它们，重建就会失败。 */
async function killStaleHolders(dir: string): Promise<void> {
  await killProcessesUnder(dir, ['uv.exe', 'python.exe']);
}

/** 清掉上一次的 venv：先结束遗留进程，再删；被独占打开时 Windows 连改名都拒，所以只重试一次就报人话。 */
async function resetVenv(projectDir: string, venv: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await killStaleHolders(projectDir);
    try {
      rmSync(venv, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
      return;
    } catch (err) {
      if (attempt > 0) {
        const code = (err as NodeJS.ErrnoException).code ?? '未知错误';
        throw new Error(`${basename(venv)} 还被别的进程占着，删不掉（${code}）。多半是上一次中断的安装还在跑，重启 Coopanion 后再点「获取」。`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

export interface CreateProjectEnvOptions {
  uv: string;
  /** 项目根目录；venv 建在它的 `.venv`。 */
  dir: string;
  signal: AbortSignal;
  onStage: (stage: string) => void;
  /** 先从这些源装 torch 之类的东西（GPT-SoVITS 的 requirements 里没有 torch 版本）；按顺序试，前一个失败才试下一个。 */
  torch?: { indexes: readonly string[]; packages: readonly string[] };
  /** requirements 里那些在 Windows 上要现场编译的包，先用预编译轮子装上。 */
  preinstall?: readonly string[];
  /** 显式依赖（项目根没有能用的 requirements.txt 时用）；装完记进 `.audio-env.json`。 */
  packages?: readonly string[];
  /** 全部装完后替换同名包：先卸 `remove`，再装 `packages`（GPU 版 onnxruntime 顶替依赖带出的 CPU 版）。 */
  replace?: { remove: readonly string[]; packages: readonly string[] };
  /** 改写上游 requirements.txt（换掉本机装不了的版本）；给了就装改写后的临时清单。 */
  requirements?: (text: string) => string;
}

/**
 * 建 venv 并装依赖：有 requirements.txt 用它（里面的 --extra-index-url 照原样生效），
 * 只有 pyproject.toml 时用 `uv sync`。成功写 `.audio-env.json`。
 */
export async function createProjectEnv(opts: CreateProjectEnvOptions): Promise<void> {
  const { uv, dir, signal, onStage } = opts;
  // uv 与 pip 都按系统代理走，否则 PyTorch 官方源直连只有几十 KB/s。
  const net = await proxyEnv();
  const venv = join(dir, '.venv');
  await resetVenv(dir, venv);

  onStage('建 venv');
  const v = await run(uv, ['venv', '--python', PROJECT_PYTHON, venv], dir, signal, undefined, net);
  if (v.aborted) throw new Error('已取消');
  if (v.code !== 0) throw new Error(`uv venv 失败：${tail(v.stderr || v.stdout)}`);
  const python = projectPython(dir);

  if (opts.torch) {
    const label = `装 torch（${opts.torch.packages.join('、')}）`;
    onStage(label);
    const failures: string[] = [];
    for (const [index, url] of opts.torch.indexes.entries()) {
      if (index > 0) onStage(`${label}·换源 ${new URL(url).host}`);
      const t = await run(uv, ['pip', 'install', '--python', python, '--index-url', url, ...opts.torch.packages], dir, signal, undefined, net);
      if (t.aborted) throw new Error('已取消');
      if (t.code === 0) {
        failures.length = 0;
        break;
      }
      failures.push(`[${new URL(url).host}]\n${cleanOutput(t.stderr || t.stdout) || `退出码 ${t.code}`}`);
    }
    if (failures.length) {
      // 每个源各自的完整输出都留下，失败原因（超时、代理、证书）就在里面。
      const full = `${label}\n\n${failures.join('\n\n')}\n`;
      const log = join(dir, '.torch-install.log');
      let where = `完整日志：${log}`;
      try {
        writeFileSync(log, full, 'utf8');
      } catch {
        // 日志写不下去也不能盖住真正的安装失败。
        where = '完整日志写入失败';
      }
      throw new Error(`装 torch 失败（${where}）\n${full}`);
    }
  }

  if (opts.preinstall?.length && process.platform === 'win32') {
    onStage('装预编译包');
    // 装不上不拦住后面：有 MSVC 的机器照样能从源码编译。
    const pre = await run(uv, ['pip', 'install', '--python', python, ...opts.preinstall], dir, signal, undefined, net);
    if (pre.aborted) throw new Error('已取消');
  }

  if (opts.packages?.length) {
    onStage(`装依赖（${opts.packages.length} 个包）`);
    const pip = await run(uv, ['pip', 'install', '--python', python, ...opts.packages], dir, signal, undefined, net);
    if (pip.aborted) throw new Error('已取消');
    if (pip.code !== 0) throw new Error(`装依赖失败：${tail(pip.stderr || pip.stdout)}`);
  }

  const requirements = join(dir, 'requirements.txt');
  if (existsSync(requirements)) {
    onStage('装依赖（requirements.txt）');
    const rewritten = opts.requirements ? join(dir, '.audio-requirements.txt') : null;
    if (rewritten) writeFileSync(rewritten, opts.requirements!(readFileSync(requirements, 'utf8')));
    try {
      const pip = await run(uv, ['pip', 'install', '--python', python, '-r', rewritten ?? requirements], dir, signal, undefined, net);
      if (pip.aborted) throw new Error('已取消');
      if (pip.code !== 0) throw new Error(`装依赖失败：${tail(pip.stderr || pip.stdout)}`);
    } finally {
      if (rewritten) rmSync(rewritten, { force: true });
    }
  } else if (existsSync(join(dir, 'pyproject.toml'))) {
    onStage('装依赖（uv sync）');
    const sync = await run(uv, ['sync', '--python', python], dir, signal, undefined, net);
    if (sync.aborted) throw new Error('已取消');
    if (sync.code !== 0) throw new Error(`uv sync 失败：${tail(sync.stderr || sync.stdout)}`);
  }

  if (opts.replace) {
    onStage(`装 ${opts.replace.packages.join('、')}`);
    if (opts.replace.remove.length) {
      const off = await run(uv, ['pip', 'uninstall', '--python', python, ...opts.replace.remove], dir, signal, undefined, net);
      if (off.aborted) throw new Error('已取消');
      if (off.code !== 0) throw new Error(`卸载 ${opts.replace.remove.join('、')} 失败：${tail(off.stderr || off.stdout)}`);
    }
    const pip = await run(uv, ['pip', 'install', '--python', python, ...opts.replace.packages], dir, signal, undefined, net);
    if (pip.aborted) throw new Error('已取消');
    if (pip.code !== 0) throw new Error(`装依赖失败：${tail(pip.stderr || pip.stdout)}`);
  }

  onStage('自检');
  const probe = await run(python, ['-c', 'import sys;print(sys.version.split()[0])'], dir, signal, undefined, net);
  if (probe.aborted) throw new Error('已取消');
  if (probe.code !== 0) throw new Error(`自检失败：${tail(probe.stderr || probe.stdout)}`);
  const installed = [...(opts.packages ?? []), ...(opts.replace?.packages ?? [])];
  writeFileSync(join(dir, '.audio-env.json'), JSON.stringify({ python, version: probe.stdout.trim(), packages: installed, createdAt: new Date().toISOString() }, null, 2) + '\n');
}

/** 独立 venv（不依附某个项目）里的 python 路径。 */
export function envPython(dir: string): string {
  return process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python');
}

/** 建一个独立 venv 并装指定包；装完跑 `check` 自检，成功写 `.audio-env.json`。 */
export async function createUvEnv(opts: {
  uv: string;
  dir: string;
  packages: readonly string[];
  /** 在这个环境里执行的 Python 代码，退出码 0 才算装好；不同用途的包不一样。 */
  check: string;
  signal: AbortSignal;
  onStage: (stage: string) => void;
}): Promise<void> {
  const { uv, dir, packages, check, signal, onStage } = opts;
  const net = await proxyEnv();
  await resetVenv(dir, dir);

  onStage('建 venv');
  const v = await run(uv, ['venv', '--python', PROJECT_PYTHON, dir], dir, signal, undefined, net);
  if (v.aborted) throw new Error('已取消');
  if (v.code !== 0) throw new Error(`uv venv 失败：${tail(v.stderr || v.stdout)}`);

  onStage(`装 ${packages.join('、')}`);
  const python = envPython(dir);
  const pip = await run(uv, ['pip', 'install', '--python', python, ...packages], dir, signal, undefined, net);
  if (pip.aborted) throw new Error('已取消');
  if (pip.code !== 0) throw new Error(`装依赖失败：${tail(pip.stderr || pip.stdout)}`);

  onStage('自检');
  const probe = await run(python, ['-c', check], dir, signal, undefined, net);
  if (probe.aborted) throw new Error('已取消');
  if (probe.code !== 0) throw new Error(`自检失败：${tail(probe.stderr || probe.stdout)}`);
  writeFileSync(join(dir, '.audio-env.json'), JSON.stringify({ python, packages, version: probe.stdout.trim(), createdAt: new Date().toISOString() }, null, 2) + '\n');
}
