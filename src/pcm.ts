/**
 * PCM16 的几件小算术：RMS / 峰值电平（dBFS）与拼接。
 * 切分器（vad.ts）与流式识别（stream-asr.ts）共用，避免两边各写一份。
 */

/** 一帧的 RMS 电平（dBFS）；全零帧记 -100。 */
export function rmsDb(frame: Int16Array): number {
  if (!frame.length) return -100;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / frame.length);
  return rms <= 1e-5 ? -100 : Math.max(-100, 20 * Math.log10(rms));
}

/** 一帧的峰值电平（dBFS）。 */
export function peakDb(frame: Int16Array): number {
  if (!frame.length) return -100;
  let peak = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = Math.abs(frame[i]);
    if (v > peak) peak = v;
  }
  return peak <= 0 ? -100 : Math.max(-100, 20 * Math.log10(peak / 32768));
}

export function joinInt16(frames: Int16Array[]): Int16Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** 一组帧的峰值电平（dBFS）。 */
export function peakOfFrames(frames: Int16Array[]): number {
  let peak = -100;
  for (const frame of frames) {
    const db = peakDb(frame);
    if (db > peak) peak = db;
  }
  return peak;
}
