/**
 * 一次播放的 PCM 输出：audify（RtAudio / WASAPI）开一条流，按到达顺序写 16-bit 交错 PCM。
 * 每次播放新开一条流，跟随当前默认输出设备；音量走 RtAudio 的 outputVolume。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface RtAudioStream {
  start(): void;
  write(pcm: Buffer): void;
  stop(): void;
  clearOutputQueue(): void;
  isStreamOpen(): boolean;
  closeStream(): void;
  outputVolume: number;
}

interface RtAudio {
  openStream(
    outputParameters: { deviceId?: number; nChannels: number; firstChannel: number } | null,
    inputParameters: null,
    format: number,
    sampleRate: number,
    frameSize: number,
    streamName: string,
    inputCallback: null,
    frameOutputCallback: null,
  ): number;
  getDefaultOutputDevice(): number;
}

interface AudifyModule {
  RtAudio: new (api?: number) => RtAudio;
  RtAudioFormat: { RTAUDIO_SINT16: number };
  RtAudioApi: { WINDOWS_WASAPI: number };
}

/** 本机有没有可用的原生输出；没有时调用方回退到 PowerShell 播放器。 */
export function loadAudify(): AudifyModule | null {
  try {
    return require('audify') as AudifyModule;
  } catch {
    return null;
  }
}

export const OUTPUT_CHANNELS = 2;
export const OUTPUT_RATE = 48_000;
/** 10 ms 一帧，写的时候按帧对齐。 */
export const FRAME_SAMPLES = 480;
const FRAME_BYTES = FRAME_SAMPLES * OUTPUT_CHANNELS * 2;

/** 把 -1（全左）… 1（全右）折成两声道的增益：只压远端，不抬近端，所以不会削波。 */
export function balanceGains(balance: number): { left: number; right: number } {
  const pan = Number.isFinite(balance) ? Math.max(-1, Math.min(1, balance)) : 0;
  return { left: pan > 0 ? 1 - pan : 1, right: pan < 0 ? 1 + pan : 1 };
}

/** 16-bit 交错立体声乘音量与左右平衡，就地改副本；全居中且音量为 1 时原样返回。 */
export function scalePcm(pcm: Buffer, gain = 1, balance = 0): Buffer {
  const sides = balanceGains(balance);
  const leftGain = gain * sides.left;
  const rightGain = gain * sides.right;
  if (leftGain === 1 && rightGain === 1) return pcm;
  const out = Buffer.from(pcm);
  for (let at = 0; at + 3 < out.length; at += 4) {
    const left = Math.round(out.readInt16LE(at) * leftGain);
    const right = Math.round(out.readInt16LE(at + 2) * rightGain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, left)), at);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, right)), at + 2);
  }
  return out;
}

/** 只看音量，立体声；保留给解码测试。 */
export function applyGain(pcm: Buffer, gain: number): Buffer {
  return scalePcm(pcm, gain, 0);
}

export class PcmOutput {
  private rt: RtAudioStream | null = null;
  private rate = 0;
  private frameBytes = FRAME_BYTES;
  private carry = Buffer.alloc(0);
  private endsAt = 0;
  private lastGain = 1;
  private lastBalance = 0;

  constructor(
    private readonly audify: AudifyModule,
    private readonly volume: () => number,
  ) {}

  get playing(): boolean {
    return this.rt !== null && Date.now() < this.endsAt;
  }

  /** 写一段交错立体声 PCM；balance 是 -1（全左）… 1（全右）。采样率变了先等前面的播完再重开流。 */
  async write(sampleRate: number, pcm: Buffer, gain = 1, balance = 0): Promise<void> {
    if (this.rt && sampleRate !== this.rate) {
      await this.drain();
      this.close();
    }
    if (!this.rt) this.open(sampleRate);
    const rt = this.rt!;
    rt.outputVolume = Math.max(0, Math.min(1, this.volume() / 100));
    this.lastGain = gain;
    this.lastBalance = balance;
    // 先和 carry 拼起来再按整帧缩放：块边界切开的左右采样对不会被错位处理。
    const merged = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    const whole = merged.length - (merged.length % this.frameBytes);
    const scaled = scalePcm(merged.subarray(0, whole), gain, balance);
    for (let at = 0; at < whole; at += this.frameBytes) rt.write(scaled.subarray(at, at + this.frameBytes));
    this.carry = Buffer.from(merged.subarray(whole));
    const seconds = whole / (this.rate * OUTPUT_CHANNELS * 2);
    this.endsAt = Math.max(this.endsAt, Date.now()) + seconds * 1000;
  }

  /** 一句写完：尾巴先按本条的音量与平衡缩放，再补静音成一帧。 */
  flush(): void {
    if (!this.rt || !this.carry.length) return;
    const frame = Buffer.alloc(this.frameBytes);
    scalePcm(this.carry, this.lastGain, this.lastBalance).copy(frame);
    this.rt.write(frame);
    this.endsAt = Math.max(this.endsAt, Date.now()) + 10;
    this.carry = Buffer.alloc(0);
  }

  /** 等已写入的音频播完（按写入量估的墙钟）。 */
  async drain(): Promise<void> {
    while (this.rt && Date.now() < this.endsAt) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** 立刻停：丢掉没播的部分，并关掉流；下一次 write 会重新开。 */
  cut(): void {
    this.close();
  }

  close(): void {
    if (!this.rt) return;
    try {
      this.rt.clearOutputQueue();
      this.rt.stop();
      this.rt.closeStream();
    } finally {
      this.rt = null;
      this.rate = 0;
      this.carry = Buffer.alloc(0);
      this.endsAt = 0;
      this.lastGain = 1;
      this.lastBalance = 0;
    }
  }

  private open(sampleRate: number): void {
    const rtAudio = new this.audify.RtAudio(process.platform === 'win32' ? this.audify.RtAudioApi.WINDOWS_WASAPI : undefined);
    // openStream 返回实际帧长；write 必须按它切，不能按请求的 FRAME_SAMPLES 写死。
    const frames = rtAudio.openStream(
      { deviceId: rtAudio.getDefaultOutputDevice(), nChannels: OUTPUT_CHANNELS, firstChannel: 0 },
      null,
      this.audify.RtAudioFormat.RTAUDIO_SINT16,
      sampleRate,
      FRAME_SAMPLES,
      'cortico-audio-wave',
      null,
      null,
    );
    this.rt = rtAudio as unknown as RtAudioStream;
    this.frameBytes = (Number.isFinite(frames) && frames > 0 ? frames : FRAME_SAMPLES) * OUTPUT_CHANNELS * 2;
    this.rate = sampleRate;
    try {
      this.rt.start();
    } catch (error) {
      this.close();
      throw error;
    }
  }
}
