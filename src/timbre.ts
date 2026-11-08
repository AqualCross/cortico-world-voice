/** 参考音频（音色样本）的存放与索引：文件复制进 `<dataDir>/timbre/`，每个音频绑定自己的台本。 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export interface Timbre {
  /** 文件名（不含目录），在 timbre 目录下。 */
  file: string;
  /** 显示名：去掉扩展名。 */
  name: string;
  /** 这个音频里说的原话。 */
  text: string;
  addedAt: string;
}

interface IndexFile {
  items: Timbre[];
}

/** WAV 判定：头部是 RIFF....WAVE；改过扩展名的假 WAV 过不了这一关。 */
export function isWavBytes(bytes: Buffer): boolean {
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
}

/** 路径版：扩展名是 .wav 且文件头对得上。 */
export function isWavFile(path: string): boolean {
  if (extname(path).toLowerCase() !== '.wav') return false;
  try {
    const head = Buffer.alloc(12);
    const fd = openSync(path, 'r');
    try { readSync(fd, head, 0, 12, 0); } finally { closeSync(fd); }
    return isWavBytes(head);
  } catch {
    return false;
  }
}

export class TimbreStore {
  constructor(readonly dir: string) {}

  private get index(): string {
    return join(this.dir, 'timbre.json');
  }

  list(): Timbre[] {
    if (!existsSync(this.index)) return [];
    try {
      const data = JSON.parse(readFileSync(this.index, 'utf8')) as IndexFile;
      return Array.isArray(data.items) ? data.items.filter((item) => item && typeof item.file === 'string') : [];
    } catch {
      return [];
    }
  }

  private save(items: Timbre[]): Timbre[] {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.index, JSON.stringify({ items }, null, 2) + '\n');
    return items;
  }

  get(file: string): Timbre | undefined {
    return this.list().find((item) => item.file === file);
  }

  /** 同一目录下重名就加时间戳后缀，不覆盖已有音色。 */
  private unique(name: string): string {
    const stem = name.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'timbre';
    const ext = '.wav';
    const taken = new Set(this.list().map((item) => item.file));
    let candidate = `${stem}${ext}`;
    let seq = 1;
    while (taken.has(candidate) || existsSync(join(this.dir, candidate))) {
      candidate = `${stem}-${seq}${ext}`;
      seq += 1;
    }
    return candidate;
  }

  private add(file: string, text = ''): Timbre {
    const item: Timbre = { file, name: basename(file, extname(file)), text, addedAt: new Date().toISOString() };
    this.save([...this.list(), item]);
    return item;
  }

  /** 从任意位置导入一个 WAV（复制进 timbre 目录）。 */
  importFile(src: string): Timbre {
    if (!isWavFile(src)) throw new Error('参考音频要是 WAV 文件。');
    const file = this.unique(basename(src, extname(src)));
    mkdirSync(this.dir, { recursive: true });
    copyFileSync(src, join(this.dir, file));
    return this.add(file);
  }

  /** 从拖进来的字节导入。 */
  importBytes(name: string, bytes: Buffer): Timbre {
    if (!bytes.length) throw new Error('文件是空的。');
    if (!isWavBytes(bytes)) throw new Error('参考音频要是 WAV 文件。');
    const file = this.unique(basename(name, extname(name)));
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, file), bytes);
    return this.add(file);
  }

  /** 改某个音频的台本。 */
  setText(file: string, text: string): Timbre[] {
    const items = this.list().map((item) => (item.file === file ? { ...item, text } : item));
    return this.save(items);
  }

  /** 绝对路径，交给推理用。 */
  pathOf(file: string): string {
    return join(this.dir, file);
  }
}
