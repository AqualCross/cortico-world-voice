import { describe, it, expect } from 'vitest';
import { parseFfmpegVersion, ffmpegKnownPaths } from '../src/ffmpeg.ts';

describe('ffmpeg 检测', () => {
  it('从 -version 输出里取版本号', () => {
    expect(parseFfmpegVersion('ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024')).toBe('7.1-full_build-www.gyan.dev');
    expect(parseFfmpegVersion('ffmpeg version n7.0.2 Copyright')).toBe('n7.0.2');
    expect(parseFfmpegVersion('nonsense')).toBe(null);
  });

  it('常见位置都指向 ffmpeg.exe', () => {
    const paths = ffmpegKnownPaths({ LOCALAPPDATA: 'C:/Users/x/AppData/Local', ProgramData: 'C:/ProgramData' }, 'C:/Users/x');
    expect(paths.every((p) => p.endsWith('ffmpeg.exe'))).toBe(true);
    expect(paths.some((p) => p.includes('WinGet'))).toBe(true);
    expect(paths).toContain(String.raw`C:\ffmpeg\bin\ffmpeg.exe`);
  });
});
