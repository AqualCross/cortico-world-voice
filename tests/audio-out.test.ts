import { beforeEach, describe, expect, it } from 'vitest';
import { FRAME_SAMPLES, OUTPUT_CHANNELS, PcmOutput, balanceGains, scalePcm } from '../src/audio-out.ts';

class FakeRtAudio {
  static instances: FakeRtAudio[] = [];
  started = 0;
  stopped = 0;
  cleared = 0;
  closed = 0;
  writes: Buffer[] = [];
  openArgs: unknown[] = [];
  outputVolume = 1;

  constructor(readonly api?: number) { FakeRtAudio.instances.push(this); }
  getDefaultOutputDevice(): number { return 1; }
  openStream(...args: unknown[]): number { this.openArgs = args; return 512; }
  start(): void { this.started += 1; }
  write(pcm: Buffer): void { this.writes.push(Buffer.from(pcm)); }
  stop(): void { this.stopped += 1; }
  clearOutputQueue(): void { this.cleared += 1; }
  isStreamOpen(): boolean { return true; }
  closeStream(): void { this.closed += 1; }
}

type Audify = ConstructorParameters<typeof PcmOutput>[0];
const audify = {
  RtAudio: FakeRtAudio,
  RtAudioFormat: { RTAUDIO_SINT16: 8 },
  RtAudioApi: { WINDOWS_WASAPI: 1 },
} as unknown as Audify;

const output = (): PcmOutput => new PcmOutput(audify, () => 100);

beforeEach(() => { FakeRtAudio.instances = []; });

describe('PCM 输出', () => {
  it('openStream 之后启动流，并按返回的实际帧长切片', async () => {
    const pcm = output();
    await pcm.write(48_000, Buffer.alloc(512 * OUTPUT_CHANNELS * 2 * 2));
    const rt = FakeRtAudio.instances[0];
    expect(rt.openArgs[4]).toBe(FRAME_SAMPLES);
    expect(rt.started).toBe(1);
    expect(rt.writes.map((item) => item.length)).toEqual([2048, 2048]);
    pcm.close();
  });

  it('cut 关掉流，下一次 write 会重新开并启动', async () => {
    const pcm = output();
    await pcm.write(48_000, Buffer.alloc(2048));
    pcm.cut();
    expect(FakeRtAudio.instances[0].closed).toBe(1);
    await pcm.write(48_000, Buffer.alloc(2048));
    expect(FakeRtAudio.instances).toHaveLength(2);
    expect(FakeRtAudio.instances[1].started).toBe(1);
    expect(FakeRtAudio.instances[1].writes).toHaveLength(1);
    pcm.close();
  });

  it('flush 用实际帧长补静音，不按请求帧长写死', async () => {
    const pcm = output();
    await pcm.write(48_000, Buffer.alloc(1000));
    expect(FakeRtAudio.instances[0].writes).toHaveLength(0);
    pcm.flush();
    expect(FakeRtAudio.instances[0].writes.map((item) => item.length)).toEqual([2048]);
    pcm.close();
  });
});

describe('左右平衡', () => {
  const stereo = (left: number, right: number): Buffer => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(left, 0);
    pcm.writeInt16LE(right, 2);
    return pcm;
  };

  it('居中不动，全左/全右只留一边，半偏只压远端', () => {
    const pcm = stereo(1000, 1000);
    expect(scalePcm(pcm, 1, 0)).toBe(pcm);
    const left = scalePcm(pcm, 1, -1);
    expect(left.readInt16LE(0)).toBe(1000);
    expect(left.readInt16LE(2)).toBe(0);
    const right = scalePcm(pcm, 1, 1);
    expect(right.readInt16LE(0)).toBe(0);
    expect(right.readInt16LE(2)).toBe(1000);
    const half = scalePcm(pcm, 1, 0.5);
    expect(half.readInt16LE(0)).toBe(500);
    expect(half.readInt16LE(2)).toBe(1000);
  });

  it('平衡只衰减不提升，越界会掐到 -1…1', () => {
    expect(balanceGains(-5)).toEqual({ left: 1, right: 0 });
    expect(balanceGains(5)).toEqual({ left: 0, right: 1 });
    const pcm = stereo(30000, 30000);
    const out = scalePcm(pcm, 2, -1);
    expect(out.readInt16LE(0)).toBe(32767);
    expect(out.readInt16LE(2)).toBe(0);
  });

  it('跨块拼接后仍按左右采样对缩放', async () => {
    const pcm = output();
    // FakeRtAudio.openStream 返回 512 帧，所以实际帧长是 512 个立体声采样。
    const frame = Buffer.alloc(512 * 4);
    for (let at = 0; at < frame.length; at += 4) {
      frame.writeInt16LE(1000, at);
      frame.writeInt16LE(2000, at + 2);
    }
    // 从左右采样对中间切开：先合并再缩放，右边不会被当成左边。
    await pcm.write(48_000, frame.subarray(0, 1025), 1, 1);
    await pcm.write(48_000, frame.subarray(1025), 1, 1);
    const written = FakeRtAudio.instances[0].writes[0];
    expect(written.readInt16LE(0)).toBe(0);
    expect(written.readInt16LE(2)).toBe(2000);
    expect(written.readInt16LE(written.length - 4)).toBe(0);
    expect(written.readInt16LE(written.length - 2)).toBe(2000);
    pcm.close();
  });

  it('flush 的尾巴也按本条平衡缩放', async () => {
    const pcm = output();
    const tail = stereo(1000, 1000);
    await pcm.write(48_000, tail, 1, -1);
    pcm.flush();
    const written = FakeRtAudio.instances[0].writes[0];
    expect(written.readInt16LE(0)).toBe(1000);
    expect(written.readInt16LE(2)).toBe(0);
    pcm.close();
  });
});
