import { describe, it, expect } from 'vitest';
import { summarizeError, errorOverflow } from '../src/webui/errors.ts';

describe('错误只留一句', () => {
  it('多行压成一行，短的照原样', () => {
    expect(summarizeError('服务已退出（1）。\nENOENT python.exe\nmore')).toBe('服务已退出（1）。 ENOENT python.exe more');
    expect(summarizeError('  短错误  ')).toBe('短错误');
  });

  it('超过一行上限就截断并以省略号收尾，标记「有原文可复制」', () => {
    const long = '错'.repeat(120);
    expect(summarizeError(long)).toBe(`${'错'.repeat(90)}…`);
    expect(errorOverflow(long)).toBe(true);
    expect(errorOverflow('短错误')).toBe(false);
  });
});
