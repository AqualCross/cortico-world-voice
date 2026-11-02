import { beforeEach, describe, expect, it } from 'vitest';
import { FRAME_SAMPLES, OUTPUT_CHANNELS, PcmOutput } from '../src/audio-out.ts';

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
