/**
 * 采集：把系统声音、某个应用或麦克风变成 16 kHz 单声道 PCM16 的 20ms 帧。
 *
 * 系统与按应用走 `loopback-capture`（N-API；Windows 上是 WASAPI 环回与进程树环回），
 * 送来 48 kHz 立体声 16-bit；麦克风走 audify（RtAudio / WASAPI 输入），送来 48 kHz
 * 单声道。两边在这里统一「→ 单声道 → 48k → 16k（3:1 盒式平均）→ 切 320 样本的帧」，
 * 全部按样本对齐，不丢整帧。
 *
 * 有一件事属于采集端的脾气：环回在完全安静时原生侧就不回调（低于 -70 dBFS 的包被
 * 丢掉），所以「安静」表现为「没有帧」；切分的收尾靠墙上时钟，见 vad.ts。麦克风则
 * 一直有帧（包括静音），两种来源对切分器是同一形状。
 */
import { createRequire } from 'node:module';
import type { LoopbackCapture } from 'loopback-capture';
import { loadAudify } from './audio-out.ts';

const require = createRequire(import.meta.url);

export const SRC_RATE = 48_000;
export const OUT_RATE = 16_000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (OUT_RATE * FRAME_MS) / 1000; // 320
const DECIMATE = SRC_RATE / OUT_RATE; // 3
/** 麦克风流的每包样本数（10ms，单声道）。 */
const MIC_FRAME_SAMPLES = 480;

export type CaptureTarget = { source: 'system' } | { source: 'app'; pid: number } | { source: 'mic' };

export interface CaptureStatusEvent {
  type: 'capture-error' | 'stop-error';
  detail?: string;
}

export interface CaptureModuleStatus {
  ok: boolean;
  error: string;
}

let loopback: { LoopbackCapture: new () => LoopbackCapture } | null = null;
let probe: CaptureModuleStatus | null = null;

/** 载入原生件；失败时把「装没装、能不能载」讲成人话。 */
function loadLoopback(): { LoopbackCapture: new () => LoopbackCapture } {
  if (process.platform !== 'win32') {
    throw new Error('本机声音监听目前只在 Windows 上可用（系统环回与按应用都走 WASAPI）。');
  }
  if (loopback) return loopback;
  try {
    loopback = require('loopback-capture') as { LoopbackCapture: new () => LoopbackCapture };
    return loopback;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`载入 loopback-capture 失败：${detail}。请在扩展目录里安装依赖后重启应用。`);
  }
}

/** 原生件能不能载（给面板与工具看），结果缓存。 */
export function captureModuleStatus(): CaptureModuleStatus {
  if (!probe) {
    try {
      loadLoopback();
      probe = { ok: true, error: '' };
    } catch (err) {
      probe = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return probe;
}

/** audify 的输入侧形状；输出侧的 PcmOutput 不用它。 */
interface AudifyInput {
  RtAudio: new (api?: number) => {
    openStream(
      output: null,
      input: { deviceId?: number; nChannels: number; firstChannel?: number },
      format: number,
      sampleRate: number,
      frameSize: number,
      streamName: string,
      inputCallback: ((data: Buffer) => void) | null,
      frameOutputCallback: null,
      flags?: number,
      errorCallback?: ((type: number, message: string) => void) | null,
    ): number;
    getDefaultInputDevice(): number;
    start(): void;
    stop(): void;
    closeStream(): void;
  };
  RtAudioFormat: { RTAUDIO_SINT16: number };
  RtAudioApi: { WINDOWS_WASAPI: number };
}

interface MicSession {
  rt: InstanceType<AudifyInput['RtAudio']>;
}

/** Int16Array 拼接。 */
function joinInt16(parts: Int16Array[]): Int16Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface CaptureHooks {
  /** 20ms / 320 样本的 16k 单声道帧。 */
  onFrame(frame: Int16Array): void;
  /** 采集端的边角状态：出错时把原因交出去，别把整条车道拖死。 */
  onStatus(event: CaptureStatusEvent): void;
}

export class Capturer {
  private impl: LoopbackCapture | null = null;
  private mic: MicSession | null = null;
  private srcCarry: Int16Array = new Int16Array(0);
  private monoCarry: Int16Array = new Int16Array(0);

  constructor(private readonly hooks: CaptureHooks) {}

  get running(): boolean {
    return this.impl !== null || this.mic !== null;
  }

  start(target: CaptureTarget): void {
    if (this.running) throw new Error('已经在采集了：先 stop。');
    if (target.source === 'mic') {
      this.startMic();
      return;
    }
    const mod = loadLoopback();
    const impl = new mod.LoopbackCapture();
    const callback = (buf: Buffer): void => {
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      this.ingest(pcm, 2);
    };
    if (target.source === 'app') {
      const pid = Number(target.pid);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('按应用采集需要有效的 PID。');
      impl.start(pid, true, callback);
    } else {
      impl.startSystemAudio(callback);
    }
    this.impl = impl;
  }

  stop(): void {
    const impl = this.impl;
    const mic = this.mic;
    this.impl = null;
    this.mic = null;
    this.srcCarry = new Int16Array(0);
    this.monoCarry = new Int16Array(0);
    if (impl) {
      try {
        impl.stop();
      } catch (err) {
        // 已经停了或进入错误态时 stop 可能抛；这里只报一声，不翻上去。
        this.hooks.onStatus({ type: 'stop-error', detail: err instanceof Error ? err.message : String(err) });
      }
    }
    if (mic) {
      try {
        mic.rt.stop();
        mic.rt.closeStream();
      } catch (err) {
        this.hooks.onStatus({ type: 'stop-error', detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private startMic(): void {
    const audify = loadAudify() as unknown as AudifyInput | null;
    if (!audify) throw new Error('麦克风采集要 audify 原生件，现在载入失败：先装好扩展依赖再重启。');
    const rt = new audify.RtAudio(audify.RtAudioApi.WINDOWS_WASAPI);
    const device = rt.getDefaultInputDevice();
    rt.openStream(
      null,
      { deviceId: device, nChannels: 1, firstChannel: 0 },
      audify.RtAudioFormat.RTAUDIO_SINT16,
      SRC_RATE,
      MIC_FRAME_SAMPLES,
      'cortico-audio-mic',
      (buf: Buffer) => {
        const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
        this.ingest(pcm, 1);
      },
      null,
      0,
      (type: number, message: string) => {
        this.hooks.onStatus({ type: 'capture-error', detail: `麦克风出错（${type}）：${message}` });
      },
    );
    rt.start();
    this.mic = { rt };
  }

  /** 一块原生 PCM（48k interleaved）→ 若干 16k 单声道帧。 */
  private ingest(pcm: Int16Array, channels: number): void {
    if (!this.running) return; // stop 之后迟到的包丢掉
    if (!pcm.length) return;
    const block = DECIMATE * channels;

    // 攒原始样本：跨包对齐，不丢 3 的余数。
    const src = this.srcCarry.length ? joinInt16([this.srcCarry, pcm]) : pcm;
    const usable = Math.floor(src.length / block) * block;
    const outCount = usable / block;
    if (outCount > 0) {
      const mono = new Int16Array(outCount);
      for (let i = 0; i < outCount; i += 1) {
        let sum = 0;
        const base = i * block;
        for (let j = 0; j < DECIMATE; j += 1) {
          const at = base + j * channels;
          for (let c = 0; c < channels; c += 1) sum += src[at + c];
        }
        mono[i] = Math.max(-32768, Math.min(32767, Math.round(sum / block)));
      }
      this.srcCarry = src.length > usable ? src.slice(usable) : new Int16Array(0);
      this.monoCarry = this.monoCarry.length ? joinInt16([this.monoCarry, mono]) : mono;
    } else {
      this.srcCarry = src.slice();
    }

    // 切 320 样本的帧；余数留到下一包。
    while (this.monoCarry.length >= FRAME_SAMPLES) {
      const frame = this.monoCarry.slice(0, FRAME_SAMPLES);
      this.monoCarry = this.monoCarry.slice(FRAME_SAMPLES);
      this.hooks.onFrame(frame);
    }
  }
}
