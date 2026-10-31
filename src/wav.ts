/**
 * WAV 的两件小事：从文件头读时长、把 PCM16 包成 WAV。
 * 采集切出来的块按 16 kHz 单声道存；别人的 mp3/ogg 认不出时长，调用方别编一个假的。
 */

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
 * 从 WAV 头里读时长（秒）；不是能认的 RIFF/WAVE 就返回 null。
 * 云端返回的 mp3/ogg 认不出来，调用方别据此编一个假时长。
 */
export function wavSeconds(bytes: Buffer): number | null {
  if (!bytes || bytes.length < 44) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
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
      dataBytes = Math.min(size, Math.max(0, bytes.length - body));
    }
    // 块按字对齐：奇数长度后面补一个 0 字节。
    off = body + size + (size % 2);
  }
  if (!fmt || !fmt.channels || !fmt.sampleRate || !fmt.bits || !dataBytes) return null;
  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
  if (!bytesPerSecond) return null;
  return dataBytes / bytesPerSecond;
}
