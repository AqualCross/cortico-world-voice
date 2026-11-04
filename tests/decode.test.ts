import { describe, it, expect } from 'vitest';
import { ffmpegArgs, ffmpegStreamArgs } from '../src/decode.ts';
import { applyGain } from '../src/audio-out.ts';

describe('解码参数', () => {
  it('固定解成 16-bit 交错立体声 48 kHz，写 stdout', () => {
    const args = ffmpegArgs('D:/a.wav');
    expect(args).toContain('-ac');
    expect(args[args.indexOf('-ac') + 1]).toBe('2');
    expect(args[args.indexOf('-ar') + 1]).toBe('48000');
    expect(args[args.indexOf('-i') + 1]).toBe('D:/a.wav');
    expect(args[args.length - 1]).toBe('-');
    expect(args).toContain('pcm_s16le');
  });

  it('流式解码从 stdin 读，探测窗口压小', () => {
    const args = ffmpegStreamArgs();
    expect(args[args.indexOf('-i') + 1]).toBe('pipe:0');
    expect(args[args.indexOf('-probesize') + 1]).toBe('32k');
    expect(args[args.indexOf('-ac') + 1]).toBe('2');
    expect(args[args.indexOf('-ar') + 1]).toBe('48000');
    expect(args).toContain('pcm_s16le');
  });
});

describe('增益', () => {
  it('按比例缩放并夹在 int16 范围内', () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(1000, 0);
    pcm.writeInt16LE(-1000, 2);
    const half = applyGain(pcm, 0.5);
    expect(half.readInt16LE(0)).toBe(500);
    expect(half.readInt16LE(2)).toBe(-500);
    const loud = applyGain(pcm, 100);
    expect(loud.readInt16LE(0)).toBe(32767);
    expect(loud.readInt16LE(2)).toBe(-32768);
  });

  it('增益为 1 时原样返回', () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    expect(applyGain(pcm, 1)).toBe(pcm);
  });
});
