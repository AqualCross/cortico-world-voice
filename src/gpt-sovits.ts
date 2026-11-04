/**
 * 本机 GPT-SoVITS：把上游的 `api_v2.py` 当依赖子进程用。
 * 只写自己的推理配置（权重路径、设备），不改上游代码；服务按需起、闲置自动关。
 */
import { createServer } from 'node:net';
import { existsSync, lstatSync, mkdirSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readBody, type EncodedSpeech } from './speech.ts';

export interface GptSovitsSetup {
  /** 上游项目根（依赖页装的那份）。 */
  projectDir: string;
  /** `models/audio/gpt-sovits`，权重都在这下面。 */
  modelsDir: string;
  python: string;
  device: 'cuda' | 'cpu';
  /** device=cuda 时用第几张卡。 */
  gpuIndex: number;
  version: string;
  /** 相对 modelsDir 的两个权重文件。 */
  t2sWeights: string;
  vitsWeights: string;
}

export interface GptSovitsVoice {
  /** 参考音频绝对路径。 */
  refAudio: string;
  /** 参考音频里说的原话。 */
  promptText: string;
  /** 参考音频的语言；留空让上游自己判。 */
  promptLang: string;
  /** 正文语言。 */
  textLang: string;
  speed: number;
}

/** 权重齐不齐、项目和环境在不在。 */
export function gptSovitsMissing(setup: GptSovitsSetup): string[] {
  const missing: string[] = [];
  if (!existsSync(join(setup.projectDir, 'api_v2.py'))) missing.push('GPT-SoVITS 源码');
  if (!existsSync(setup.python)) missing.push('Python 环境');
  if (!existsSync(join(setup.modelsDir, setup.t2sWeights))) missing.push(`GPT 权重 ${setup.t2sWeights}`);
  if (!existsSync(join(setup.modelsDir, setup.vitsWeights))) missing.push(`SoVITS 权重 ${setup.vitsWeights}`);
  return missing;
}

const toPosix = (path: string): string => path.replace(/\\/g, '/');

/**
 * 上游按 `GPT_SoVITS/pretrained_models/...` 找权重，把它接到本包的模型目录上。
 * 源码包带进来的空壳（只有 `.gitignore`）才替换；里面有真东西就报错，不删用户文件。
 */
export function linkPretrainedModels(setup: GptSovitsSetup): void {
  const link = join(setup.projectDir, 'GPT_SoVITS', 'pretrained_models');
  const want = resolve(setup.modelsDir);
  const linked = (() => {
    try {
      return readlinkSync(link);
    } catch {
      return null;
    }
  })();
  if (linked !== null) {
    if (resolve(linked) === want) return;
    rmSync(link, { force: true });
  } else if (existsSync(link)) {
    if (!lstatSync(link).isDirectory()) {
      rmSync(link, { force: true });
    } else {
      const inside = readdirSync(link).filter((name) => name !== '.gitignore');
      if (inside.length > 0) {
        throw new Error(`${link} 里已经有东西（${inside.slice(0, 3).join('、')}），先自己挪走再获取`);
      }
      rmSync(link, { recursive: true, force: true });
    }
  }
  mkdirSync(join(setup.projectDir, 'GPT_SoVITS'), { recursive: true });
  symlinkSync(setup.modelsDir, link, 'junction');
}

/** 推理配置写进项目目录（不进仓库），只指路径。 */
export function inferConfig(setup: GptSovitsSetup): string {
  const models = toPosix(setup.modelsDir);
  return [
    'custom:',
    `  bert_base_path: ${models}/chinese-roberta-wwm-ext-large`,
    `  cnhuhbert_base_path: ${models}/chinese-hubert-base`,
    `  device: ${setup.device}`,
    `  is_half: ${setup.device === 'cuda' ? 'true' : 'false'}`,
    `  t2s_weights_path: ${models}/${setup.t2sWeights}`,
    `  version: ${setup.version}`,
    `  vits_weights_path: ${models}/${setup.vitsWeights}`,
    '',
  ].join('\n');
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

export class GptSovitsService {
  private child: ChildProcess | null = null;
  private baseUrl = '';
  private starting: Promise<void> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private died: string | null = null;

  constructor(
    private readonly setup: GptSovitsSetup,
    private readonly opts: { idleMs?: number; readyMs?: number } = {},
  ) {}

  get running(): boolean {
    return this.child !== null && this.baseUrl !== '';
  }

  /** 起服务并等它就绪；已经在跑就直接回。 */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** 一句，边生成边给 WAV 字节（头 + 连续 PCM 块）；上游 2 = 按句尽快出块、3 = 定长块更快。 */
  async synthesizeStream(text: string, voice: GptSovitsVoice, signal: AbortSignal): Promise<EncodedSpeech> {
    await this.start();
    this.touchIdle();
    const res = await fetch(`${this.baseUrl}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        text_lang: voice.textLang || 'auto',
        ref_audio_path: toPosix(voice.refAudio),
        prompt_text: voice.promptText,
        prompt_lang: voice.promptLang || 'auto',
        media_type: 'wav',
        streaming_mode: 2,
        speed_factor: voice.speed,
        seed: -1,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`GPT-SoVITS 合成失败（HTTP ${res.status}）。\n${(await res.text()).slice(0, 600)}`);
    if (!res.body) {
      const bytes = Buffer.from(await res.arrayBuffer());
      return { format: 'wav', chunks: (async function* () { yield bytes; })() };
    }
    return { format: 'wav', chunks: readBody(res.body) };
  }

  async synthesize(text: string, voice: GptSovitsVoice, signal: AbortSignal): Promise<Buffer> {
    const speech = await this.synthesizeStream(text, voice, signal);
    const parts: Buffer[] = [];
    for await (const chunk of speech.chunks) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts);
  }

  async stop(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child;
    this.child = null;
    this.baseUrl = '';
    if (!child) return;
    try {
      // venv 的 python 会再拉起一个真正监听端口的进程，只杀父进程会留下占着显存的孤儿。
      if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill();
    } catch {
      // 可能已经退了。
    }
  }

  private async launch(): Promise<void> {
    const missing = gptSovitsMissing(this.setup);
    if (missing.length) throw new Error(`还缺：${missing.join('、')}。去「依赖」页对 GPT-SoVITS 点「获取」。`);
    linkPretrainedModels(this.setup);
    writeFileSync(join(this.setup.projectDir, 'audio-tts-infer.yaml'), inferConfig(this.setup));
    const port = await freePort();
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.died = null;
    let stderr = '';
    let stdout = '';
    const child = spawn(this.setup.python, ['api_v2.py', '-a', '127.0.0.1', '-p', String(port), '-c', 'audio-tts-infer.yaml'], {
      cwd: this.setup.projectDir,
      windowsHide: true,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: this.setup.device === 'cuda' ? String(this.setup.gpuIndex) : '-1' },
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-20000); });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-6000); });
    child.once('error', (err) => { this.died = `服务起不来：${err.message}`; });
    child.once('close', (code) => {
      // 第一行给人看，后面几行是原样日志，留给「复制错误信息」。
      const tail = (stderr || stdout).trim().split(/\r?\n/).slice(-30).join('\n').slice(-4000);
      this.died = `服务已退出（${code ?? '未知'}）。${tail ? `\n${tail}` : ''}`;
      if (this.child === child) { this.child = null; this.baseUrl = ''; }
    });

    const readyMs = this.opts.readyMs ?? 600_000;
    const deadline = Date.now() + readyMs;
    while (Date.now() < deadline) {
      // uvicorn 的 "Uvicorn running on ..." / "Application startup complete" 走的是 stderr，权重加载进度才在 stdout。
      if (/Uvicorn running on|Application startup complete/.test(stdout + stderr)) {
        this.touchIdle();
        return;
      }
      if (this.died && !this.child) throw new Error(`GPT-SoVITS ${this.died}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    const raw = (stdout + stderr).trim().split(/\r?\n/).slice(-30).join('\n').slice(-4000);
    throw new Error(`GPT-SoVITS 服务 ${Math.round(readyMs / 60_000)} 分钟没就绪。${raw ? `\n${raw}` : ''}`);
  }

  private touchIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.stop(), this.opts.idleMs ?? 5 * 60_000);
    this.idle.unref?.();
  }
}
