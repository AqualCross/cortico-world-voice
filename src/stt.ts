/**
 * 云端转写，照搬 `cortico-world-stt` 里已经跑通的三种形状：
 *
 * 1. `dashscope` 同步：`POST <base>/api/v1/services/aigc/multimodal-generation/generation`
 *    - `qwen3-asr-*`：`content:[{audio}]` + `parameters.asr_options{langu, enable_itn}`
 *    - `qwen-audio-3.x-asr-*` / `fun-asr-*`：可选上下文 `input_text` + `input_audio`，
 *      `parameters{format, sample_rate, language_hints, keep_dialect}`
 * 2. `dashscope-async` 文件转写：取上传凭证 → 传 OSS 换 `oss://` → 提交任务 →
 *    轮询 `api/v1/tasks/<id>` → 下载 `transcription_url` 的 JSON。
 * 3. `openai` 兼容：`<base>/v1/audio/transcriptions`，multipart，取 `text`。
 */
import type { FetchLike } from './cloud.ts';
import { CloudError } from './cloud.ts';

export type SttEngine = 'dashscope' | 'dashscope-async' | 'openai';

const snippet = (value: unknown, max = 300): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const trimSlash = (url: string): string => url.trim().replace(/[/\s]+$/, '');

export const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com';
export const DASHSCOPE_ASR_PATH = 'api/v1/services/aigc/multimodal-generation/generation';
export const DASHSCOPE_ASYNC_ASR_PATH = 'api/v1/services/audio/asr/transcription';
export const DASHSCOPE_UPLOAD_PATH = 'api/v1/uploads';

/** 新加坡地域的凭证接口在另一个域名上。 */
export function uploadBaseFor(baseUrl: string): string {
  return /dashscope-intl\.aliyuncs\.com/i.test(baseUrl) ? 'https://dashscope-intl.aliyuncs.com' : DASHSCOPE_BASE;
}

const MIME_BY_FORMAT: Readonly<Record<string, string>> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
};

export function formatFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'aif') return 'aiff';
  if (ext === 'mpg' || ext === 'mpeg') return 'mp3';
  return MIME_BY_FORMAT[ext] ? ext : '';
}

export function mimeFor(format: string): string {
  return MIME_BY_FORMAT[format] ?? 'audio/wav';
}

export function isQwen3Asr(model: string): boolean {
  return /^qwen3-asr/i.test(model.trim());
}

export interface SttOptions {
  /** 语言提示：逗号分隔，最多四个。 */
  langHint?: string;
  /** 识别上下文（只对非 qwen3 的同步接口）。 */
  context?: string;
  /** 自动补标点/数字（仅 qwen3）。 */
  itn?: boolean;
  /** 保留方言表达（仅 qwen-audio-3.x）。 */
  keepDialect?: boolean;
  /** 采样率；0 或不填就由服务端按格式判断。 */
  sampleRate?: number;
}

export interface HttpRequest {
  url: string;
  body: unknown;
}

/** 同步请求体。 */
export function dashscopeSttRequest(opts: SttOptions & { baseUrl?: string; model: string; bytes: Buffer; format: string }): HttpRequest {
  const data = `data:${mimeFor(opts.format)};base64,${opts.bytes.toString('base64')}`;
  const hints = (opts.langHint ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const url = `${trimSlash(opts.baseUrl || DASHSCOPE_BASE)}/${DASHSCOPE_ASR_PATH}`;
  if (isQwen3Asr(opts.model)) {
    const asrOptions: Record<string, unknown> = {};
    if (hints.length) asrOptions.language = hints[0];
    if (opts.itn) asrOptions.enable_itn = true;
    return {
      url,
      body: {
        model: opts.model,
        input: { messages: [{ role: 'user', content: [{ audio: data }] }] },
        ...(Object.keys(asrOptions).length ? { parameters: { asr_options: asrOptions } } : {}),
      },
    };
  }
  if (!opts.format) throw new CloudError(null, '认不出音频格式：换成 wav / mp3 这类常见格式');
  const messages: Array<Record<string, unknown>> = [];
  if (opts.context?.trim()) messages.push({ role: 'user', content: [{ type: 'input_text', text: opts.context.trim() }] });
  messages.push({ role: 'user', content: [{ type: 'input_audio', input_audio: { data } }] });
  const parameters: Record<string, unknown> = { format: opts.format };
  if (opts.sampleRate && opts.sampleRate > 0) parameters.sample_rate = String(Math.round(opts.sampleRate));
  if (hints.length) parameters.language_hints = hints.slice(0, 4);
  if (opts.keepDialect) parameters.keep_dialect = true;
  return { url, body: { model: opts.model, input: { messages }, parameters } };
}

/** 同步结果：文本 + 语言（qwen3 的 annotations 里带）。 */
export function dashscopeSttResult(body: unknown, model: string): { text: string; language: string | null } {
  const output = (body as { output?: Record<string, unknown> })?.output ?? {};
  if (isQwen3Asr(model)) {
    const message = (output as { choices?: Array<{ message?: { content?: unknown; annotations?: Array<{ language?: unknown }> } }> })
      .choices?.[0]?.message;
    const text = contentToString(message?.content);
    if (text === null) throw new CloudError(null, `接口没给识别结果：${snippet(JSON.stringify(body ?? {}))}`);
    const annotation = (message?.annotations ?? []).find((item) => item && typeof item.language === 'string');
    return { text, language: annotation ? String(annotation.language) : null };
  }
  let text: string | null = null;
  if (typeof (output as { text?: unknown }).text === 'string') text = (output as { text: string }).text;
  else if (Array.isArray((output as { sentences?: unknown }).sentences)) {
    text = ((output as { sentences: Array<{ text?: unknown }> }).sentences).map((one) => String(one?.text ?? '')).join('');
  } else if (typeof ((output as { sentence?: { text?: unknown } }).sentence)?.text === 'string') {
    text = (output as { sentence: { text: string } }).sentence.text;
  }
  if (text === null) throw new CloudError(null, `接口没给识别结果：${snippet(JSON.stringify(body ?? {}))}`);
  return { text, language: null };
}

function contentToString(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : String((part as { text?: unknown })?.text ?? ''))).join('');
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') return (content as { text: string }).text;
  return null;
}

/** 同步转写一次。 */
export async function transcribeDashscope(opts: SttOptions & {
  baseUrl: string;
  apiKey: string;
  model: string;
  bytes: Buffer;
  format: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const request = dashscopeSttRequest(opts);
  const res = await fetchImpl(request.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok) throw new CloudError(res.status, `转写失败（HTTP ${res.status}）：${snippet(await res.text())}`);
  return dashscopeSttResult(await res.json(), opts.model).text.trim();
}

// ---------------------------------------------------------------- 异步文件转写

/** OSS 的 key 只留 ASCII 安全字符，扩展名保留。 */
export function safeFileName(name: string): string {
  const base = String(name ?? '').split(/[/\\]/).pop()?.trim() || 'audio';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'audio';
  return ext ? `${stem}.${ext}` : stem;
}

export interface UploadPolicy {
  upload_host: string;
  policy: string;
  signature: string;
  upload_dir: string;
  oss_access_key_id: string;
  x_oss_object_acl?: string;
  x_oss_forbid_overwrite?: string;
}

/** 上传本地音频，换一个 `oss://` 临时 URL。 */
export async function uploadToDashscope(opts: {
  baseUrl?: string;
  apiKey: string;
  model: string;
  bytes: Buffer;
  name: string;
  format: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const uploadBase = uploadBaseFor(opts.baseUrl ?? DASHSCOPE_BASE);
  const policyUrl = `${uploadBase}/${DASHSCOPE_UPLOAD_PATH}?action=getPolicy&model=${encodeURIComponent(opts.model)}`;
  const policyRes = await fetchImpl(policyUrl, { headers: { authorization: `Bearer ${opts.apiKey}` }, signal });
  const policyText = await policyRes.text();
  if (!policyRes.ok) throw new CloudError(policyRes.status, `取上传凭证失败（HTTP ${policyRes.status}）：${snippet(policyText)}`);
  const data = (JSON.parse(policyText) as { data?: UploadPolicy })?.data;
  if (!data?.upload_host || !data.policy || !data.signature || !data.upload_dir || !data.oss_access_key_id) {
    throw new CloudError(null, `上传凭证缺字段：${snippet(policyText)}`);
  }
  const name = safeFileName(opts.name);
  const key = `${String(data.upload_dir).replace(/\/+$/, '')}/${name}`;
  const form = new FormData();
  form.append('OSSAccessKeyId', data.oss_access_key_id);
  form.append('Signature', data.signature);
  form.append('policy', data.policy);
  if (data.x_oss_object_acl) form.append('x-oss-object-acl', data.x_oss_object_acl);
  if (data.x_oss_forbid_overwrite) form.append('x-oss-forbid-overwrite', data.x_oss_forbid_overwrite);
  form.append('key', key);
  form.append('success_action_status', '200');
  form.append('file', new Blob([new Uint8Array(opts.bytes)], { type: mimeFor(opts.format) }), name);
  const up = await fetchImpl(data.upload_host, { method: 'POST', body: form, signal });
  if (!up.ok) throw new CloudError(up.status, `上传音频到百炼临时存储失败（HTTP ${up.status}）：${snippet(await up.text())}`);
  return `oss://${key}`;
}

export interface AsyncTaskState {
  taskId: string;
  status: string;
  transcriptionUrl: string;
  error: string;
}

/** 提交任务；只拿 task_id。 */
export async function submitDashscopeAsync(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fileUrl: string;
  langHint?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hints = (opts.langHint ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4);
  const parameters: Record<string, unknown> = { channel_id: [0] };
  if (hints.length) parameters.language_hints = hints;
  const res = await fetchImpl(`${trimSlash(opts.baseUrl)}/${DASHSCOPE_ASYNC_ASR_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
      'X-DashScope-Async': 'enable',
      'X-DashScope-OssResourceResolve': 'enable',
    },
    body: JSON.stringify({ model: opts.model, input: { file_urls: [opts.fileUrl] }, parameters }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new CloudError(res.status, `提交任务失败（HTTP ${res.status}）：${snippet(text)}${res.status === 404 ? '（异步文件转写要走百炼工作空间地址）' : ''}`);
  }
  const taskId = String((JSON.parse(text) as { output?: { task_id?: unknown } })?.output?.task_id ?? '').trim();
  if (!taskId) throw new CloudError(null, `提交成功但没拿到 task_id：${snippet(text)}`);
  return taskId;
}

/** 查一次任务。 */
export async function queryDashscopeTask(opts: {
  baseUrl: string;
  apiKey: string;
  taskId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<AsyncTaskState> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${trimSlash(opts.baseUrl)}/api/v1/tasks/${encodeURIComponent(opts.taskId)}`, {
    headers: { authorization: `Bearer ${opts.apiKey}`, 'X-DashScope-OssResourceResolve': 'enable' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new CloudError(res.status, `查询任务失败（HTTP ${res.status}）：${snippet(text)}`);
  const output = (JSON.parse(text) as { output?: Record<string, unknown> })?.output ?? {};
  const first = Array.isArray((output as { results?: unknown }).results)
    ? ((output as { results: Array<Record<string, unknown>> }).results)[0]
    : undefined;
  return {
    taskId: String((output as { task_id?: unknown }).task_id ?? opts.taskId),
    status: String((output as { task_status?: unknown }).task_status ?? '').toUpperCase(),
    transcriptionUrl: String(first?.transcription_url ?? ''),
    error: first?.code ? `${String(first.code)}: ${String(first.message ?? '')}` : '',
  };
}

/** 下载结果 JSON，拼出 `transcripts[].text`。 */
export async function fetchDashscopeTranscript(url: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  if (!res.ok) throw new CloudError(res.status, `下载转写结果失败（HTTP ${res.status}）`);
  const text = await res.text();
  let json: { transcripts?: Array<{ text?: unknown }> } | null = null;
  try {
    json = JSON.parse(text) as { transcripts?: Array<{ text?: unknown }> };
  } catch {
    json = null;
  }
  if (!json) throw new CloudError(null, `转写结果不是 JSON：${snippet(text, 200)}`);
  const body = (json.transcripts ?? []).map((one) => String(one?.text ?? '').trim()).filter(Boolean).join('\n');
  if (!body) throw new CloudError(null, '转写结果里没有文字');
  return body;
}

/** 完整异步流程：上传 → 提交 → 轮询 → 下载。 */
export async function transcribeDashscopeAsync(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  bytes: Buffer;
  name: string;
  format: string;
  langHint?: string;
  fetchImpl?: FetchLike;
  /** 轮询间隔与总等待。 */
  pollMs?: number;
  timeoutMs?: number;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const fileUrl = await uploadToDashscope({ ...opts, fetchImpl });
  const taskId = await submitDashscopeAsync({ ...opts, fileUrl, fetchImpl });
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  const pollMs = opts.pollMs ?? 1500;
  for (;;) {
    const state = await queryDashscopeTask({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, taskId, fetchImpl });
    if (state.status === 'SUCCEEDED') {
      if (state.error) throw new CloudError(null, `任务失败：${state.error}`);
      return fetchDashscopeTranscript(state.transcriptionUrl, { fetchImpl });
    }
    if (state.status === 'FAILED' || state.status === 'CANCELED' || state.status === 'UNKNOWN') {
      throw new CloudError(null, `任务 ${state.status}：${state.error || '没有更多信息'}`);
    }
    if (Date.now() > deadline) throw new CloudError(null, '等转写任务超时');
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---------------------------------------------------------------- OpenAI 兼容

export function openaiTranscriptionUrl(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  if (!base) throw new CloudError(null, '没有配置接口地址');
  return /\/v1$/i.test(base) ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
}

export function openaiSttForm(opts: { model: string; bytes: Buffer; format: string; name?: string; langHint?: string; context?: string }): FormData {
  const form = new FormData();
  form.append('model', opts.model.trim() || 'whisper-1');
  form.append('response_format', 'json');
  form.append('file', new Blob([new Uint8Array(opts.bytes)], { type: mimeFor(opts.format) }), opts.name ?? `audio.${opts.format}`);
  const lang = opts.langHint?.split(',')[0]?.trim();
  if (lang) form.append('language', lang);
  if (opts.context?.trim()) form.append('prompt', opts.context.trim());
  return form;
}

export async function transcribeOpenai(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  bytes: Buffer;
  format: string;
  name?: string;
  langHint?: string;
  context?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(openaiTranscriptionUrl(opts.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}` },
    body: openaiSttForm(opts),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new CloudError(res.status, `转写失败（HTTP ${res.status}）：${snippet(raw)}`);
  if (!raw.trim().startsWith('{')) return raw.trim();
  const body = JSON.parse(raw) as { text?: unknown };
  if (typeof body.text !== 'string') throw new CloudError(null, '转写响应里没有 text');
  return body.text.trim();
}
