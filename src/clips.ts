/**
 * 音频输出仓库（`audio/out/`）：一个目录 + 一份 index.json，每段一个音频文件。
 * 说话、变声、唱歌的成品都进这里。
 *
 * 只有本进程写它，索引常驻内存，落盘走「写临时文件再 rename」。
 * 索引坏了或文件被外部删掉时不抛错，静默当空/跳过，一个坏文件不卡死面板。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const INDEX_FILE = 'index.json';
const VERSION = 1;

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/pcm': 'pcm',
};

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  pcm: 'audio/pcm',
};

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function stampOf(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function newId(): string {
  return randomBytes(4).toString('hex');
}

function intOf(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

function secondsOf(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

export interface ClipRecord {
  id: string;
  file: string;
  path: string;
  mime: string;
  ext: string;
  bytes: number;
  seconds: number | null;
  text: string;
  note: string;
  voice: string;
  model: string;
  format: string;
  source: string;
  createdAt: string;
}

export interface ClipInput {
  bytes: Buffer;
  ext?: string;
  mime?: string;
  seconds?: number | null;
  text?: string;
  note?: string;
  voice?: string;
  model?: string;
  format?: string;
  source?: string;
}

export class ClipsStore {
  private items: ClipRecord[] = [];
  private loaded = false;

  /** `clock` 给记录时间用；面板按「本地墙钟串」直接切片显示，别写成 UTC。 */
  constructor(readonly dir: string, private readonly keep = 200, private readonly clock: () => string = () => new Date().toISOString()) {}

  get indexFile(): string {
    return join(this.dir, INDEX_FILE);
  }

  get count(): number {
    this.load();
    return this.items.length;
  }

  get totalBytes(): number {
    this.load();
    return this.items.reduce((sum, item) => sum + item.bytes, 0);
  }

  list(limit = 24): ClipRecord[] {
    this.load();
    const n = Math.max(0, intOf(limit, 24));
    return (n > 0 ? this.items.slice(0, n) : this.items).map((item) => ({ ...item }));
  }

  get(ref: string): ClipRecord | null {
    this.load();
    const key = String(ref ?? '').trim();
    if (!key) return null;
    const lower = key.toLowerCase();
    const item = this.items.find((it) => it.id === lower
      || it.file.toLowerCase() === lower
      || it.path.toLowerCase() === lower
      || it.path.toLowerCase() === resolve(key).toLowerCase());
    return item ? { ...item } : null;
  }

  /** 存一段语音并返回记录。 */
  add(entry: ClipInput): ClipRecord {
    this.load();
    const mime = String(entry.mime ?? 'audio/wav');
    const ext = String(entry.ext ?? EXT_BY_MIME[mime] ?? 'wav').replace(/^\./, '').toLowerCase();
    const now = new Date();
    const id = newId();
    const file = `${stampOf(now)}-${id}.${ext}`;
    const path = join(this.dir, file);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path, entry.bytes);
    const item: ClipRecord = {
      id,
      file,
      path,
      mime: MIME_BY_EXT[ext] ?? mime,
      ext,
      bytes: entry.bytes.length,
      seconds: secondsOf(entry.seconds),
      text: String(entry.text ?? '').slice(0, 2000),
      note: String(entry.note ?? '').slice(0, 200),
      voice: String(entry.voice ?? ''),
      model: String(entry.model ?? ''),
      format: String(entry.format ?? ext),
      source: String(entry.source ?? 'tool'),
      createdAt: this.clock(),
    };
    this.items.unshift(item);
    this.prune();
    this.save();
    return { ...item };
  }

  remove(ref: string): boolean {
    this.load();
    const item = this.get(ref);
    if (!item) return false;
    this.items = this.items.filter((it) => it.id !== item.id);
    this.unlink(item.path);
    this.save();
    return true;
  }

  clear(): number {
    this.load();
    const removed = this.items.length;
    for (const item of this.items) this.unlink(item.path);
    this.items = [];
    this.save();
    return removed;
  }

  /** 合并旧 World 的条目：按 id 去重、按时间重新排，超出 keep 截断。 */
  importItems(entries: unknown[]): number {
    this.load();
    const known = new Set(this.items.map((item) => item.id));
    let added = 0;
    for (const raw of entries) {
      const item = normalize(raw, this.dir);
      if (!item || known.has(item.id)) continue;
      known.add(item.id);
      this.items.push(item);
      added += 1;
    }
    this.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.prune();
    this.save();
    return added;
  }

  summary(limit = 60): { dir: string; count: number; totalBytes: number; items: ClipRecord[] } {
    this.load();
    return { dir: this.dir, count: this.items.length, totalBytes: this.totalBytes, items: this.list(limit) };
  }

  private unlink(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      // 文件已经不在了，或者被别的程序占着；索引照删。
    }
  }

  private prune(): void {
    if (!this.keep || this.items.length <= this.keep) return;
    const dropped = this.items.splice(this.keep);
    for (const item of dropped) this.unlink(item.path);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.indexFile)) return;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(readFileSync(this.indexFile, 'utf8'));
    } catch {
      return;
    }
    const raw = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null)?.items;
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      const item = normalize(entry, this.dir);
      if (item) this.items.push(item);
    }
    const before = this.items.length;
    this.prune();
    if (this.items.length !== before) this.save();
  }

  private save(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const body = JSON.stringify({ version: VERSION, items: this.items }, null, 2);
      const tmp = `${this.indexFile}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, this.indexFile);
    } catch {
      // 磁盘写不进去时不让合成失败；下一次成功写入会覆盖。
    }
  }
}

function normalize(entry: unknown, dir: string): ClipRecord | null {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry as Record<string, unknown>;
  if (typeof raw.file !== 'string' || !raw.file) return null;
    // 存的是绝对路径；目录整体搬过家后按文件名在新目录里找，记录不会凭空消失。
  const wanted = typeof raw.path === 'string' && isAbsolute(raw.path) ? raw.path : join(dir, raw.file);
  const path = existsSync(wanted) ? wanted : join(dir, raw.file);
  let bytes = intOf(raw.bytes);
  try {
    if (!existsSync(path)) return null;
    bytes = statSync(path).size;
  } catch {
    return null;
  }
  const ext = String(raw.ext ?? path.split('.').pop() ?? 'wav').toLowerCase();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    file: raw.file,
    path,
    mime: String(raw.mime ?? MIME_BY_EXT[ext] ?? 'audio/wav'),
    ext,
    bytes,
    seconds: secondsOf(raw.seconds),
    text: String(raw.text ?? '').slice(0, 2000),
    note: String(raw.note ?? '').slice(0, 200),
    voice: String(raw.voice ?? ''),
    model: String(raw.model ?? ''),
    format: String(raw.format ?? ext),
    source: String(raw.source ?? 'api'),
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
  };
}
