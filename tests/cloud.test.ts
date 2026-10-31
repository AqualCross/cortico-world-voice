import { describe, it, expect } from 'vitest';
import {
  CloudError,
  DASHSCOPE_TTS_PATH,
  dashscopeAudio,
  dashscopeTtsRequest,
  openaiSpeechUrl,
  openaiTtsRequest,
  synthesizeCloud,
  type FetchLike,
} from '../src/cloud.ts';

const audioBytes = new Uint8Array([1, 2, 3, 4]);

describe('TTS 请求体（照搬自 tts 扩展）', () => {
  it('DashScope 走 SpeechSynthesizer，input 里带 text / voice / format', () => {
    const request = dashscopeTtsRequest({ model: 'qwen-tts', voice: 'Cherry', text: '你好' });
    expect(request.url).toContain(DASHSCOPE_TTS_PATH);
    expect(request.body).toEqual({ model: 'qwen-tts', input: { text: '你好', voice: 'Cherry', format: 'wav' } });
  });

  it('DashScope 其余可选字段：采样率、指令、语言提示、种子（夹到 0–65535）', () => {
    const request = dashscopeTtsRequest({
      model: 'm', voice: 'v', text: 't', format: 'mp3', sampleRate: 24000,
      instruction: '开心一点', languageHints: 'zh,en', seed: 99999,
    });
    const input = (request.body as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      format: 'mp3',
      sample_rate: 24000,
      instruction: '开心一点',
      language_hints: ['zh', 'en'],
      seed: 65535,
    });
  });

  it('OpenAI 兼容：lang 只认 ZH/EN/JA/ES/AR，取第一个提示', () => {
    const ok = openaiTtsRequest({ baseUrl: 'http://x', model: 'm', voice: 'v', text: 't', languageHints: 'ja,zh' });
    expect((ok.body as { lang?: string }).lang).toBe('JA');
    const none = openaiTtsRequest({ baseUrl: 'http://x', model: 'm', voice: 'v', text: 't', languageHints: 'fr' });
    expect((none.body as { lang?: string }).lang).toBeUndefined();
  });

  it('OpenAI 兼容：根地址补 /v1，已带 /v1 就不重复', () => {
    expect(openaiSpeechUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/audio/speech');
    expect(openaiSpeechUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/audio/speech');
    expect(openaiSpeechUrl('http://127.0.0.1:9880/v1/')).toBe('http://127.0.0.1:9880/v1/audio/speech');
  });

  it('OpenAI 扁平 body：model 为空用 IndexTTS-2.5；格式缺省退 mp3，给了就用给的', () => {
    const bare = openaiTtsRequest({ baseUrl: 'http://127.0.0.1:9880', model: '', voice: 'x', text: 'hi' });
    expect(bare.body).toMatchObject({ model: 'IndexTTS-2.5', input: 'hi', voice: 'x', response_format: 'mp3' });
    const wav = openaiTtsRequest({ baseUrl: 'http://127.0.0.1:9880', model: 'm', voice: 'x', text: 'hi', format: 'wav' });
    expect(wav.body).toMatchObject({ response_format: 'wav' });
  });
});

describe('TTS 响应解析', () => {
  it('优先 url，其次 base64', () => {
    expect(dashscopeAudio({ output: { audio: { url: 'https://cdn/a.wav' } } })).toEqual({ url: 'https://cdn/a.wav' });
    const base64 = Buffer.from('abc').toString('base64');
    expect(dashscopeAudio({ output: { audio: { data: `data:audio/wav;base64,${base64}` } } }).data?.toString()).toBe('abc');
  });

  it('都没有时把 message 带出来', () => {
    expect(() => dashscopeAudio({ message: 'voice not supported' })).toThrow(/voice not supported/);
    expect(() => dashscopeAudio({})).toThrow(CloudError);
  });
});
