import { describe, it, expect } from 'vitest';
import { parseSenseVoice, parsedFromFields, senseVoiceNote } from '../src/sensevoice-tags.ts';

describe('SenseVoice 标记解析', () => {
  it('四段标记都拆出来，正文不带标记', () => {
    const parsed = parseSenseVoice('<|zh|><|HAPPY|><|Speech|><|woitn|>你听起来有点累，要不要休息一下？');
    expect(parsed.text).toBe('你听起来有点累，要不要休息一下？');
    expect(parsed.language).toBe('zh');
    expect(parsed.emotion).toBe('HAPPY');
    expect(parsed.events).toEqual(['Speech']);
    expect(parsed.itn).toBe(false);
  });

  it('背景音乐与笑声进事件，itn 标为已规范化', () => {
    const parsed = parseSenseVoice('<|zh|><|SAD|><|BGM|><|Laughter|><|itn|>哈哈哈');
    expect(parsed.events).toEqual(['BGM', 'Laughter']);
    expect(parsed.itn).toBe(true);
    expect(senseVoiceNote(parsed)).toBe('情感 难过；事件 背景音乐、笑声');
  });

  it('平静与纯说话不附加信息', () => {
    const parsed = parseSenseVoice('<|zh|><|NEUTRAL|><|Speech|><|woitn|>你好');
    expect(senseVoiceNote(parsed)).toBe('');
    expect(parsed.text).toBe('你好');
  });

  it('子进程分开给的字段也能归类', () => {
    const parsed = parsedFromFields({ text: '早上好', lang: '<|zh|>', emotion: '<|HAPPY|>', event: '<|BGM|>' });
    expect(parsed.text).toBe('早上好');
    expect(parsed.language).toBe('zh');
    expect(senseVoiceNote(parsed)).toBe('情感 开心；事件 背景音乐');
    const unknown = parsedFromFields({ text: '嗯', lang: '<|ja|>', emotion: '<|EMO_UNKNOWN|>', event: '<|Event_Unknown|>' });
    expect(senseVoiceNote(unknown)).toBe('');
  });

  it('不是 SenseVoice 词汇的尖括号原样保留', () => {
    const parsed = parseSenseVoice('模板写成 <|变量|> 这样就行');
    expect(parsed.text).toBe('模板写成 <|变量|> 这样就行');
    expect(parsed.language).toBe('');
    expect(senseVoiceNote(parsed)).toBe('');
  });

  it('没有标记时原样返回，字段为空', () => {
    const parsed = parseSenseVoice('  就是一句话。 ');
    expect(parsed.text).toBe('就是一句话。');
    expect(parsed.emotion).toBe('');
    expect(parsed.events).toEqual([]);
    expect(parsed.itn).toBeNull();
    expect(senseVoiceNote(parsed)).toBe('');
  });
});
