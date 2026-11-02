/**
 * 系统代理：Windows 上代理开关在注册表的 IE 设置里，进程环境变量通常没有。
 * 子进程由 `proxyEnv()` 单独给环境变量；本扩展自己的 fetch 走 `fetchWithProxy()` 按请求加代理，
 * 不改宿主进程的代理变量。
 */
import { execFile } from 'node:child_process';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export interface ProxySetting {
  /** 形如 `http://127.0.0.1:10808`；没有可用代理时为 null。 */
  url: string | null;
  detail: string | null;
}

let cache: { at: number; value: ProxySetting } | null = null;

function readRegistry(): Promise<{ enable?: string; server?: string; error?: string }> {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', KEY, '/v', 'ProxyEnable'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) {
        resolve({ error: err.message });
        return;
      }
      const enable = /ProxyEnable\s+REG_DWORD\s+(\S+)/.exec(out)?.[1];
      execFile('reg.exe', ['query', KEY, '/v', 'ProxyServer'], { windowsHide: true, timeout: 5000 }, (err2, out2) => {
        const server = /ProxyServer\s+REG_SZ\s+(.+)/.exec(err2 ? '' : out2)?.[1]?.trim();
        resolve({ enable, server });
      });
    });
  });
}

/** 把 `127.0.0.1:10808` 或 `http=...;https=127.0.0.1:10808` 归一成一个 http 代理地址。 */
export function normalizeProxy(server: string): string | null {
  const pick = (key: string): string | undefined =>
    new RegExp(`(?:^|;)\\s*${key}=([^;]+)`).exec(server)?.[1]?.trim();
  const plain = server.includes('=') ? pick('https') ?? pick('http') ?? '' : server;
  if (!plain) return null;
  return /^https?:\/\//.test(plain) ? plain : `http://${plain}`;
}

/** 当前系统的 HTTP 代理（缓存 5 分钟）。 */
export async function systemProxy(): Promise<ProxySetting> {
  const now = Date.now();
  if (cache && now - cache.at < 300_000) return cache.value;
  let value: ProxySetting = { url: null, detail: null };
  if (process.platform === 'win32') {
    const reg = await readRegistry();
    if (reg.error) {
      value = { url: null, detail: `读不到系统代理设置：${reg.error}` };
    } else if (reg.enable && Number.parseInt(reg.enable, 16) !== 1) {
      value = { url: null, detail: null };
    } else {
      const url = reg.server ? normalizeProxy(reg.server) : null;
      value = { url, detail: url ? null : '系统代理没给出可用的 HTTP 地址' };
    }
  }
  cache = { at: now, value };
  return value;
}

/**
 * 这些站是给国内直连准备的镜像：走代理反而绕到海外节点，实测 ghfast.top 经代理 20 秒 0 字节、
 * 直连 2.6 MB/s，安装会卡在几百 KB/s 的兜底来源上。子进程与 fetch 都按这份名单直连。
 */
const DIRECT_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  'ghfast.top',
  'gh-proxy.com',
  'modelscope.cn',
  'hf-mirror.com',
  'mirror.nju.edu.cn',
];

const NO_PROXY_LIST = DIRECT_HOSTS.join(',');

/** 这些镜像站和本机地址直连；按主机名（含子域）判断，不看 URL。 */
export function isDirectHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return DIRECT_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function noProxyHost(hostname: string): boolean {
  const list = `${process.env.NO_PROXY ?? process.env.no_proxy ?? ''}`
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const host = hostname.toLowerCase();
  return list.some((item) => item === '*' || host === item || host.endsWith(`.${item}`));
}

let agent: { url: string; dispatcher: ProxyAgent } | null = null;

function agentFor(url: string): ProxyAgent {
  if (agent?.url === url) return agent.dispatcher;
  void agent?.dispatcher.close().catch(() => {});
  agent = { url, dispatcher: new ProxyAgent(url) };
  return agent.dispatcher;
}

/** 宿主环境里的代理优先；没有再看系统 IE 代理。 */
function configuredProxy(): string | null {
  const value = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  return value ? normalizeProxy(value) : null;
}

/** 给本扩展自己的 fetch 按请求挂代理；镜像站与本机地址直连，不改宿主环境变量。 */
export async function fetchWithProxy(input: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(input);
  if (isDirectHost(target.hostname) || noProxyHost(target.hostname)) return fetch(input, init);
  const proxy = configuredProxy() ?? (await systemProxy()).url;
  if (!proxy) return fetch(input, init);
  return undiciFetch(
    input,
    { ...init, dispatcher: agentFor(proxy) } as Parameters<typeof undiciFetch>[1],
  ) as unknown as Response;
}

/** 给子进程用的代理环境变量；进程自己已有设置时不覆盖。 */
export async function proxyEnv(): Promise<Record<string, string>> {
  if (process.env.HTTPS_PROXY || process.env.https_proxy) return {};
  const { url } = await systemProxy();
  if (!url) return {};
  return { HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: NO_PROXY_LIST };
}
