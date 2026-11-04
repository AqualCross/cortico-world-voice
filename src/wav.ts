/**
 * WAV 的几件小事：从文件头读时长、把 PCM16 包成 WAV。
 * 采集切出来的块按 16 kHz 单声道存；别人的 mp3/ogg 认不出时长，调用方别编一个假的。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

export interface WavLayout {
  /** `data` 块正文的起点。 */
  dataOffset: number;
  /** `data` 块正文长度；声明值与文件实际大小取小。 */
  dataBytes: number;
  bytesPerSecond: number;
}

/** 把 16-bit 单声道 PCM 包成 WAV（44 字节头）。 */
export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // 单声道
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i += 1) out.writeInt16LE(pcm[i], 44 + i * 2);
  return out;
}

/**
 * 解析 RIFF 块；`data` 的声明大小可能被截断，调用方可用 `fileBytes` 给出整份文件长度。
 */
export function wavLayout(bytes: Buffer, fileBytes = bytes.length): WavLayout | null {
  if (!bytes || bytes.length < 44) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let dataOffset = 0;
  let dataBytes = 0;
  while (off + 8 <= bytes.length) {
    const id = bytes.toString('ascii', off, off + 4);
    const size = bytes.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) {
      fmt = {
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = Math.min(size, Math.max(0, fileBytes - body));
      if (dataBytes) break;
    }
    // 块按字对齐：奇数长度后面补一个 0 字节。
    off = body + size + (size % 2);
  }
  if (!fmt || !dataOffset || !dataBytes) return null;
  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
  if (!bytesPerSecond) return null;
  return { dataOffset, dataBytes, bytesPerSecond };
}

/** 只读文件头拿布局，不把整个 WAV 读进内存。 */
export function wavFileLayout(path: string): WavLayout | null {
  const fileBytes = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(fileBytes, 64 * 1024));
    readSync(fd, head, 0, head.length, 0);
    return wavLayout(head, fileBytes);
  } finally {
    closeSync(fd);
  }
}

/**
 * 从 WAV 头里读时长（秒）；不是能认的 RIFF/WAVE 就返回 null。
 * 云端返回的 mp3/ogg 认不出来，调用方别据此编一个假时长。
 */
export function wavSeconds(bytes: Buffer): number | null {
  const layout = wavLayout(bytes);
  return layout ? layout.dataBytes / layout.bytesPerSecond : null;
}

/**
 * 流式 WAV 的头是在第一块数据之前写出的，RIFF / data 长度是 0 或占位值。
 * 收齐后按实际字节补上，落盘的文件才能被别的播放器正确读出时长。
 */
export function patchWavSizes(bytes: Buffer): Buffer {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return bytes;
  let off = 12;
  let dataAt = -1;
  while (off + 8 <= bytes.length) {
    const id = bytes.toString('ascii', off, off + 4);
    const size = bytes.readUInt32LE(off + 4);
    if (id === 'data') {
      dataAt = off;
      break;
    }
    off = off + 8 + size + (size % 2);
  }
  if (dataAt < 0) return bytes;
  const dataBytes = bytes.length - (dataAt + 8);
  if (bytes.readUInt32LE(dataAt + 4) === dataBytes && bytes.readUInt32LE(4) === bytes.length - 8) return bytes;
  const out = Buffer.from(bytes);
  out.writeUInt32LE(dataBytes, dataAt + 4);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
