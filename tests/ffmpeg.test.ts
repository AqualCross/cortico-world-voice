import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseFfmpegVersion, resolveOnPath } from '../src/ffmpeg.ts';

describe('ffmpeg 检测', () => {
  it('从 -version 输出里取版本号', () => {
    expect(parseFfmpegVersion('ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024')).toBe('7.1-full_build-www.gyan.dev');
    expect(parseFfmpegVersion('ffmpeg version n7.0.2 Copyright')).toBe('n7.0.2');
    expect(parseFfmpegVersion('nonsense')).toBe(null);
  });

  it('PATH 上找到时给出真实路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-path-'));
    try {
      writeFileSync(join(dir, 'ffmpeg.exe'), '');
      const env = { PATH: [join(tmpdir(), 'no-such-dir'), dir].join(delimiter), PATHEXT: '.EXE' };
      expect(resolveOnPath('ffmpeg', env)).toBe(join(dir, 'ffmpeg.exe'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PATH 上没有就返回 null，不猜固定目录', () => {
    expect(resolveOnPath('ffmpeg', { PATH: join(tmpdir(), 'no-such-dir'), PATHEXT: '.EXE' })).toBe(null);
    expect(resolveOnPath('ffmpeg', {})).toBe(null);
  });
});
