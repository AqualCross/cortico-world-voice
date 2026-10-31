import { describe, it, expect } from 'vitest';
import {
  dashscopeSttRequest,
  dashscopeSttResult,
  isQwen3Asr,
  openaiSttForm,
  safeFileName,
  transcribeDashscope,
  transcribeDashscopeAsync,
  transcribeOpenai,
  uploadBaseFor,
} from '../src/stt.ts';
import type { FetchLike } from '../src/cloud.ts';

const wav = Buffer.from('RIFF0000WAVEfmt ');
const audio = new Uint8Array([1, 2, 3]);

describe('DashScope 同步请求体', () => {
  it('qwen3：content.audio + asr_options(language, enable_itn)', () => {
    const request = dashscopeSttRequest({ model: 'qwen3-asr-flash', bytes: wav, format: 'wav', langHint: 'zh,en', itn: true });
    const body = JSON.parse(JSON.stringify(request.body)) as { parameters?: unknown };
    expect(JSON.stringify(body)).toContain('"audio":"data:audio/wav;base64,');
    expect(body.parameters).toEqual({ asr_options: { language: 'zh', enable_itn: true } });
  });

  it('qwen-audio：上下文在前，音频在最后，参数带 format/sample_rate/keep_dialect', () => {
    const request = dashscopeSttRequest({
      model: 'qwen-audio-asr', bytes: wav, format: 'mp3', langHint: 'zh', context: '会议纪要', keepDialect: true, sampleRate: 16000,
    });
    const body = JSON.parse(JSON.stringify(request.body)) as {
      input: { messages: Array<{ content: Array<Record<string, unknown>> }> };
      parameters: Record<string, unknown>;
    };
    expect(body.input.messages).toHaveLength(2);
    expect(body.input.messages[0].content[0]).toEqual({ type: 'input_text', text: '会议纪要' });
    expect(body.input.messages[1].content[0].type).toBe('input_audio');
    expect(body.parameters).toEqual({ format: 'mp3', sample_rate: '16000', language_hints: ['zh'], keep_dialect: true });
  });

  it('认不出格式时直接报错（非 qwen3）', () => {
    expect(() => dashscopeSttRequest({ model: 'qwen-audio-asr', bytes: wav, format: '' })).toThrow(/格式/);
  });

  it('isQwen3Asr 只看模型名前缀', () => {
    expect(isQwen3Asr('qwen3-asr-flash')).toBe(true);
    expect(isQwen3Asr('qwen-audio-3.1-asr')).toBe(false);
  });
});

describe('DashScope 同步结果', () => {
  it('qwen3：content 与 annotations.language', () => {
    const result = dashscopeSttResult({
      output: { choices: [{ message: { content: [{ text: '你好' }], annotations: [{ language: 'zh' }] } }] },
    }, 'qwen3-asr-flash');
    expect(result).toEqual({ text: '你好', language: 'zh' });
  });

  it('qwen-audio：text / sentences / sentence 三种都认', () => {
    expect(dashscopeSttResult({ output: { text: '甲' } }, 'qwen-audio-asr').text).toBe('甲');
    expect(dashscopeSttResult({ output: { sentences: [{ text: '乙' }, { text: '丙' }] } }, 'qwen-audio-asr').text).toBe('乙丙');
    expect(dashscopeSttResult({ output: { sentence: { text: '丁' } } }, 'qwen-audio-asr').text).toBe('丁');
  });
});

describe('OpenAI 兼容与文件名', () => {
  it('表单带 response_format / prompt / 首个语言', () => {
    const form = openaiSttForm({ model: 'whisper-1', bytes: wav, format: 'wav', langHint: 'zh,en', context: '背景' });
    expect(form.get('response_format')).toBe('json');
    expect(form.get('prompt')).toBe('背景');
    expect(form.get('language')).toBe('zh');
  });

  it('上传文件名只留安全字符且保留扩展名', () => {
    expect(safeFileName('D:/录音 1.WAV')).toBe('录音_1.wav');
    expect(safeFileName('a/b/c.mp3')).toBe('c.mp3');
  });

  it('新加坡地域的凭证接口换域名', () => {
    expect(uploadBaseFor('https://dashscope-intl.aliyuncs.com')).toBe('https://dashscope-intl.aliyuncs.com');
    expect(uploadBaseFor('https://dashscope.aliyuncs.com')).toBe('https://dashscope.aliyuncs.com');
  });
});

describe('调用', () => {
  it('同步转写返回文本', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ output: { choices: [{ message: { content: '你好' } }] } }), { status: 200 })) as unknown as FetchLike;
    const text = await transcribeDashscope({ baseUrl: 'https://dashscope.aliyuncs.com', apiKey: 'k', model: 'qwen3-asr-flash', bytes: wav, format: 'wav', fetchImpl });
    expect(text).toBe('你好');
  });

  it('OpenAI 兼容：JSON 与纯文本都认', async () => {
    const json = (async () => new Response(JSON.stringify({ text: 'a' }), { status: 200 })) as unknown as FetchLike;
    const plain = (async () => new Response('b', { status: 200 })) as unknown as FetchLike;
    const base = { baseUrl: 'http://127.0.0.1:9000', apiKey: 'k', model: 'whisper-1', bytes: wav, format: 'wav' };
    expect(await transcribeOpenai({ ...base, fetchImpl: json })).toBe('a');
    expect(await transcribeOpenai({ ...base, fetchImpl: plain })).toBe('b');
  });

  it('异步：上传凭证 → OSS 上传 → 提交 → 轮询 → 下载结果', async () => {
    let polled = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes('action=getPolicy')) {
        return new Response(JSON.stringify({
          data: { upload_host: 'https://oss.example/up', policy: 'p', signature: 's', upload_dir: 'dir', oss_access_key_id: 'k' },
        }), { status: 200 });
      }
      if (url === 'https://oss.example/up') return new Response('', { status: 200 });
      if (url.includes('/audio/asr/transcription')) {
        expect((init?.headers as Record<string, string>)['X-DashScope-Async']).toBe('enable');
        return new Response(JSON.stringify({ output: { task_id: 't1' } }), { status: 200 });
      }
      if (url.includes('/api/v1/tasks/t1')) {
        polled += 1;
        return new Response(JSON.stringify({
          output: { task_id: 't1', task_status: polled > 1 ? 'SUCCEEDED' : 'RUNNING', results: [{ transcription_url: 'https://cdn/result.json' }] },
        }), { status: 200 });
      }
      if (url === 'https://cdn/result.json') {
        return new Response(JSON.stringify({ transcripts: [{ text: '第一段' }, { text: '第二段' }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as FetchLike;

    const text = await transcribeDashscopeAsync({
      baseUrl: 'https://dashscope.aliyuncs.com',
      apiKey: 'k',
      model: 'qwen3-asr-flash-filetrans',
      bytes: wav,
      name: 'D:/a.wav',
      format: 'wav',
      fetchImpl,
      pollMs: 1,
    });
    expect(text).toBe('第一段\n第二段');
    expect(polled).toBe(2);
  });
});
