import { describe, it, expect } from 'vitest';
import { BufferedSpeech, type SpeechStream } from '../src/speech.ts';
import { patchWavSizes, wavSeconds } from '../src/wav.ts';

const info = (chunks: AsyncIterable<Buffer>): SpeechStream => ({
  engine: 'test',
  format: 'mp3',
  voice: 'v',
  model: 'm',
  chunks,
});

describe('流式合成缓冲', () => {
  it('边到边交块，收齐后 bytes 是完整一条', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const buffer = new BufferedSpeech(async () => info((async function* () {
      yield Buffer.from([1, 2]);
      await gate;
      yield Buffer.from([3]);
    })()));
    const controller = new AbortController();
    buffer.start(controller.signal);

    const iterator = buffer.chunks(controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(Buffer.from([1, 2]));
    expect(buffer.speech?.engine).toBe('test');

    release();
    expect((await iterator.next()).value).toEqual(Buffer.from([3]));
    expect((await iterator.next()).done).toBe(true);
    expect(buffer.bytes()).toEqual(Buffer.from([1, 2, 3]));
  });

  it('记下开始合成的时间，供首音日志算耗用', () => {
    const buffer = new BufferedSpeech(async () => info((async function* () {
      yield Buffer.from([1]);
    })()));
    expect(buffer.startedAtMs).toBe(0);
    const before = Date.now();
    buffer.start(new AbortController().signal);
    expect(buffer.startedAtMs).toBeGreaterThanOrEqual(before);
  });

  it('合成失败时把错误交给播放侧', async () => {
    const buffer = new BufferedSpeech(async () => info((async function* () {
      yield Buffer.from([1]);
      throw new Error('连接断了');
    })()));
    buffer.start(new AbortController().signal);
    const got: number[] = [];
    const err = await (async () => {
      for await (const chunk of buffer.chunks()) got.push(chunk.length);
      return null;
    })().catch((e: unknown) => e);
    expect(got).toEqual([1]);
    expect((err as Error).message).toContain('连接断了');
  });

  it('被跳过时不再当失败抛出', async () => {
    const buffer = new BufferedSpeech(async () => info((async function* () {
      yield Buffer.from([1]);
      await new Promise<void>(() => {});
    })()));
    const controller = new AbortController();
    buffer.start(controller.signal);
    const iterator = buffer.chunks(controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(Buffer.from([1]));
    controller.abort();
    expect((await iterator.next()).done).toBe(true);
  });
});

describe('流式 WAV 落盘', () => {
  it('把 RIFF/data 的占位长度补成实际字节，时长能读出来', () => {
    const pcm = Buffer.alloc(3200); // 16 kHz 单声道 100 ms
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(32_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(0, 40);

    const patched = patchWavSizes(Buffer.concat([header, pcm]));
    expect(patched.readUInt32LE(4)).toBe(patched.length - 8);
    expect(patched.readUInt32LE(40)).toBe(pcm.length);
    expect(wavSeconds(patched)).toBeCloseTo(0.1, 3);
  });

  it('不是 WAV 就原样返回', () => {
    const mp3 = Buffer.from([0xff, 0xf3, 0x00]);
    expect(patchWavSizes(mp3)).toBe(mp3);
  });
});
