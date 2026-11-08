/**
 * 云端说话（TTS）。请求体与响应解析照搬自 `cortico-world-tts` 里已经跑通的实现
 * （同一作者自己的代码），不按文档重写；转写在 `stt.ts`：
 *
 * - DashScope TTS：`POST <base>/api/v1/services/audio/tts/SpeechSynthesizer`，
 *   `{ model, input: { text, voice, format } }`；回 `output.audio.url`（下载）或 `output.audio.data`（base64）。
 * - OpenAI 兼容 TTS：`<base>/v1/audio/speech`（base 已带 /v1 则不重复），扁平 body，回原始音频字节。
 */

import { fetchWithProxy } from './proxy.ts';
import { abortWithTimeout, readBody, type EncodedSpeech } from './speech.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class CloudError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = 'CloudError';
  }
}

const trimSlash = (url: string): string => url.trim().replace(/[/\s]+$/, '');
const snippet = (value: unknown, max = 300): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com';
export const DASHSCOPE_TTS_PATH = 'api/v1/services/audio/tts/SpeechSynthesizer';
export const DASHSCOPE_ASR_PATH = 'api/v1/services/aigc/multimodal-generation/generation';

// ---------------------------------------------------------------- TTS

export interface HttpRequest {
  url: string;
  body: unknown;
}

/** DashScope TTS 支持的音频格式（与 tts 扩展一致）。 */
export const DASHSCOPE_TTS_FORMATS = ['wav', 'mp3', 'ogg', 'opus', 'pcm'] as const;
/** OpenAI 兼容 TTS 支持的音频格式。 */
export const OPENAI_TTS_FORMATS = ['mp3', 'wav', 'ogg'] as const;
/** OpenAI 兼容的 lang 只认这几个（IndexTTS 的口径）。 */
const OPENAI_LANGS = new Set(['ZH', 'EN', 'JA', 'ES', 'AR']);

export function dashscopeTtsRequest(opts: {
  baseUrl?: string;
  model: string;
  voice: string;
  text: string;
  format?: string;
  sampleRate?: number;
  instruction?: string;
  languageHints?: string;
  seed?: number;
}): HttpRequest {
  const input: Record<string, unknown> = {
    text: opts.text,
    voice: opts.voice,
    format: opts.format ?? 'wav',
  };
  if (opts.sampleRate && opts.sampleRate > 0) input.sample_rate = opts.sampleRate;
  const instruction = String(opts.instruction ?? '').trim();
  if (instruction) input.instruction = instruction;
  const hints = (opts.languageHints ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (hints.length) input.language_hints = hints;
  if (typeof opts.seed === 'number' && Number.isFinite(opts.seed) && opts.seed >= 0) {
    input.seed = Math.min(Math.max(Math.round(opts.seed), 0), 65535);
  }
  return {
    url: `${trimSlash(opts.baseUrl ?? DASHSCOPE_BASE)}/${DASHSCOPE_TTS_PATH}`,
    body: { model: opts.model, input },
  };
}

/** OpenAI 兼容地址：根地址或 /v1 结尾都收。 */
export function openaiSpeechUrl(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  if (!base) throw new CloudError(null, '没有配置接口地址');
  return /\/v1$/i.test(base) ? `${base}/audio/speech` : `${base}/v1/audio/speech`;
}

export function openaiTtsRequest(opts: {
  baseUrl: string;
  model: string;
  voice: string;
  text: string;
  format?: string;
  sampleRate?: number;
  languageHints?: string;
}): HttpRequest {
  const raw = String(opts.format ?? '').trim().toLowerCase();
  const format = (OPENAI_TTS_FORMATS as readonly string[]).includes(raw) ? raw : 'mp3';
  const body: Record<string, unknown> = {
    model: opts.model.trim() || 'IndexTTS-2.5',
    input: opts.text,
    voice: opts.voice,
    response_format: format,
  };
  if (opts.sampleRate && opts.sampleRate > 0) body.sample_rate = opts.sampleRate;
  const lang = (opts.languageHints ?? '').split(',')[0]?.trim().toUpperCase() ?? '';
  if (OPENAI_LANGS.has(lang)) body.lang = lang;
  return { url: openaiSpeechUrl(opts.baseUrl), body };
}

/** `output.audio.url` 或 `output.audio.data`（data URI / 裸 base64）。都没有就报错。 */
export function dashscopeAudio(body: unknown): { url?: string; data?: Buffer } {
  const audio = (body as { output?: { audio?: { url?: unknown; data?: unknown } } })?.output?.audio;
  if (audio && typeof audio.url === 'string' && audio.url.trim()) return { url: audio.url.trim() };
  if (audio && typeof audio.data === 'string' && audio.data.trim()) {
    const bytes = Buffer.from(audio.data.replace(/^data:[^,]+,/, ''), 'base64');
    if (!bytes.length) throw new CloudError(null, '接口返回的 base64 是空的');
    return { data: bytes };
  }
  const message = (body as { message?: unknown })?.message
    ?? (body as { error?: { message?: unknown } })?.error?.message;
  throw new CloudError(null, message
    ? `接口没给音频：${snippet(message)}`
    : `接口没给音频：${snippet(JSON.stringify(body ?? {}))}`);
}

export type CloudStage = 'request' | 'response' | 'download' | 'failed';

export interface CloudSpeechOptions {
  engine: 'dashscope' | 'openai';
  apiKey: string;
  text: string;
  voice: string;
  format?: string;
  instruction?: string;
  seed?: number;
  dashscope: { baseUrl?: string; model: string; sampleRate?: number; languageHints?: string };
  openai: { baseUrl: string; model: string; sampleRate?: number; languageHints?: string };
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 诊断：每走完一个请求阶段回报一次；卡住时能看出停在哪一段、等了多久。 */
  onStage?: (stage: CloudStage, detail: Record<string, unknown>) => void;
}

const single = (bytes: Buffer): AsyncGenerator<Buffer> => (async function* () { yield bytes; })();

/**
 * 合成一段话，边到边交出去；格式按 `format`（默认 wav）。
 * OpenAI 兼容接口的响应体本身就是分块传的，直接转发；DashScope 的 HTTP 接口只回 JSON（URL/base64），退化成单块。
 */
export async function synthesizeCloudStream(opts: CloudSpeechOptions): Promise<EncodedSpeech> {
  const fetchImpl = opts.fetchImpl ?? fetchWithProxy;
  const signal = abortWithTimeout(opts.signal, opts.timeoutMs ?? 60_000);
  const format = opts.format ?? 'wav';
  const request = opts.engine === 'dashscope'
    ? dashscopeTtsRequest({
      baseUrl: opts.dashscope.baseUrl,
      model: opts.dashscope.model,
      voice: opts.voice,
      text: opts.text,
      format,
      sampleRate: opts.dashscope.sampleRate,
      instruction: opts.instruction,
      languageHints: opts.dashscope.languageHints,
      seed: opts.seed,
    })
    : openaiTtsRequest({
      baseUrl: opts.openai.baseUrl,
      model: opts.openai.model,
      voice: opts.voice,
      text: opts.text,
      format,
      sampleRate: opts.openai.sampleRate,
      languageHints: opts.openai.languageHints,
    });

  const host = new URL(request.url).host;
  const startedAt = Date.now();
  let stage: CloudStage = 'request';
  const report = (next: CloudStage, detail: Record<string, unknown> = {}): void => {
    stage = next;
    opts.onStage?.(next, {
      engine: opts.engine,
      host,
      chars: opts.text.length,
      elapsedMs: Date.now() - startedAt,
      ...detail,
    });
  };

  try {
    report('request', { voice: opts.voice, format });
    const res = await fetchImpl(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(request.body),
      signal,
    });
    report('response', { status: res.status });
    if (!res.ok) throw new CloudError(res.status, `接口返回 ${res.status}：${snippet(await res.text())}`);

    if (opts.engine === 'openai') {
      const effective = (OPENAI_TTS_FORMATS as readonly string[]).includes(String(opts.format ?? '').toLowerCase())
        ? String(opts.format).toLowerCase()
        : 'mp3';
      if (res.body) return { format: effective, chunks: readBody(res.body) };
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) throw new CloudError(null, '接口返回的音频是空的');
      return { format: effective, chunks: single(bytes) };
    }
    const audio = dashscopeAudio(await res.json());
    if (audio.data) return { format, chunks: single(audio.data) };
    const downloadHost = new URL(audio.url!).host;
    report('download', { downloadHost });
    const download = await fetchImpl(audio.url!, { signal });
    report('download', { downloadHost, status: download.status });
    if (!download.ok) throw new CloudError(download.status, `下载生成的语音失败：HTTP ${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    if (!bytes.length) throw new CloudError(null, '下载到的语音是空的');
    return { format, chunks: single(bytes) };
  } catch (err) {
    report('failed', {
      stage,
      // 自己的 60 秒守卫到点，和队列取消要分开看。
      timeout: signal.aborted && !opts.signal?.aborted,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** 整句合成（silent 与兜底用）；内部仍是流，收齐再返回。 */
export async function synthesizeCloud(opts: CloudSpeechOptions): Promise<Buffer> {
  const speech = await synthesizeCloudStream(opts);
  const parts: Buffer[] = [];
  for await (const chunk of speech.chunks) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}
