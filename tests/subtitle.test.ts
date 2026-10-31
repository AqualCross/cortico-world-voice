import { describe, it, expect } from 'vitest';
import { subtitleTimeline } from '../src/subtitle.ts';

describe('字幕时间轴', () => {
  it('按句切，标点跟着句子走，时长按字数分摊', () => {
    const lines = subtitleTimeline('叫んだよ、何回ない。次は行く！', 10);
    expect(lines.map((line) => line.text)).toEqual(['叫んだよ、何回ない。', '次は行く！']);
    expect(lines[0].at).toBe(0);
    expect(lines[1].at).toBe(6667);
  });

  it('没有时长就整段一句，不让字幕自己猜', () => {
    const lines = subtitleTimeline('只有一句话，没有句号', null);
    expect(lines).toEqual([{ text: '只有一句话，没有句号', at: 0 }]);
  });

  it('空文本不出字幕', () => {
    expect(subtitleTimeline('   ', 5)).toEqual([]);
  });

  it('换行也算断句', () => {
    const lines = subtitleTimeline('第一句\n第二句', 4);
    expect(lines.map((line) => line.text)).toEqual(['第一句', '第二句']);
    expect(lines[1].at).toBe(2000);
  });
});
