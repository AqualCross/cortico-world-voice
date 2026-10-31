/**
 * 转写记录：一个目录 + 一份 index.json，只存文本与元数据。
 *
 * **不复制源音频**：记录里的 `source.ref` 只是当初的路径，源文件删了记录照在。
 * 写索引走「写临时文件再 rename」；索引损坏时静默当空，一个坏文件不卡死面板。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_FILE = 'index.json';
const VERSION = 1;
const SOURCE_KINDS = new Set(['file', 'handle', 'selftest', 'live', 'console-test']);

export interface TranscriptSource {
  kind: 'file' | 'handle' | 'selftest' | 'live' | 'console-test';
  ref: string;
}

export interface TranscriptRecord {
  id: string;
  text: string;
  note: string;
  source: TranscriptSource;
  model: string;
  protocol: string;
  language: string;
  seconds: number | null;
  audioBytes: number;
  audioMime: string;
  format: string;
  createdAt: string;
}

export interface TranscriptInput {
  text?: string;
  note?: string;
  source?: Partial<TranscriptSource> | null;
  model?: string;
  protocol?: string;
  language?: string;
  seconds?: number | null;
  audioBytes?: number;
  audioMime?: string;
  format?: string;
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

function sourceOf(value: unknown): TranscriptSource {
  if (!value || typeof value !== 'object') return { kind: 'file', ref: '' };
  const raw = value as { kind?: unknown; ref?: unknown };
  const kind = typeof raw.kind === 'string' && SOURCE_KINDS.has(raw.kind) ? raw.kind as TranscriptSource['kind'] : 'file';
  return { kind, ref: String(raw.ref ?? '').slice(0, 500) };
}

function normalize(entry: unknown, fallbackId: string): TranscriptRecord | null {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry as Record<string, unknown>;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    text: String(raw.text ?? '').slice(0, 20000),
    note: String(raw.note ?? '').slice(0, 200),
    source: sourceOf(raw.source),
    model: String(raw.model ?? '').slice(0, 200),
    protocol: String(raw.protocol ?? ''),
    language: String(raw.language ?? '').slice(0, 40),
    seconds: secondsOf(raw.seconds),
    audioBytes: intOf(raw.audioBytes),
    audioMime: String(raw.audioMime ?? ''),
    format: String(raw.format ?? ''),
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
  };
}

export class TranscriptsStore {
  private items: TranscriptRecord[] = [];
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

  get totalAudioBytes(): number {
    this.load();
    return this.items.reduce((sum, item) => sum + item.audioBytes, 0);
  }

  list(limit = 24): TranscriptRecord[] {
    this.load();
    const n = Math.max(0, intOf(limit, 24));
    return (n > 0 ? this.items.slice(0, n) : this.items).map((item) => ({ ...item }));
  }

  get(ref: string): TranscriptRecord | null {
    this.load();
    const key = String(ref ?? '').trim().toLowerCase();
    if (!key) return null;
    const item = this.items.find((it) => it.id.toLowerCase() === key);
    return item ? { ...item } : null;
  }

  add(entry: TranscriptInput): TranscriptRecord {
    this.load();
    const item = normalize({ ...entry, id: newId(), createdAt: this.clock() }, newId())!;
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
    this.save();
    return true;
  }

  clear(): number {
    this.load();
    const removed = this.items.length;
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
      const item = normalize(raw, newId());
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

  summary(limit = 60): { dir: string; count: number; totalAudioBytes: number; items: TranscriptRecord[] } {
    this.load();
    return { dir: this.dir, count: this.items.length, totalAudioBytes: this.totalAudioBytes, items: this.list(limit) };
  }

  private prune(): void {
    if (!this.keep || this.items.length <= this.keep) return;
    this.items.splice(this.keep);
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
      const item = normalize(entry, newId());
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
      // 磁盘写不进去时不打断转写；下一次成功写入会覆盖。
    }
  }
}
