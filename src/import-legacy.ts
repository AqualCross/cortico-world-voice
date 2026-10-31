/**
 * 旧两个 World（stt / tts）的记录一次性并进本 World；旧 listen 的切块不再并（本包不再存块音频）。
 *
 * 只读旧目录、复制音频到自己的仓库，旧文件一律不动；写完标记就不再扫。
 * 复制失败的那几条跳过、不写标记，下次启动再试（按 id 去重，重复复制无害）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ClipsStore } from './clips.ts';
import { audioHome } from './storage.ts';
import type { TranscriptsStore } from './transcripts.ts';

const MARKER = 'imported.json';

export interface LegacyImportReport {
  /** 每个来源新并进来的条数。 */
  stt: number;
  tts: number;
  /** 标记已存在，这次没有扫旧目录。 */
  skipped: boolean;
}

interface Stores {
  transcripts: TranscriptsStore;
  clips: ClipsStore;
}

export function importLegacyRecords(dataDir: string, stores: Stores): LegacyImportReport {
  const marker = join(audioHome(dataDir), MARKER);
  if (existsSync(marker)) return { stt: 0, tts: 0, skipped: true };

  const tts = copyAndImport(join(dataDir, 'tts'), stores.clips.dir, stores.clips);
  const report: LegacyImportReport = {
    stt: stores.transcripts.importItems(readIndex(join(dataDir, 'stt'))),
    tts: tts.added,
    skipped: false,
  };
  // 有复制失败的先不写标记：下次启动按 id 去重再补一次。
  if (tts.failed) return report;
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ version: 1, at: new Date().toISOString(), sources: report }) + '\n');
  return report;
}

/** 旧索引里的 items；目录或索引不在就当没有。 */
function readIndex(dir: string): unknown[] {
  const file = join(dir, 'index.json');
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { items?: unknown } | unknown[] | null;
    const items = Array.isArray(parsed) ? parsed : parsed?.items;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/** 复制条目引用的音频进新目录，再把 path 改到新位置；源文件已经不在的条目照旧丢弃。 */
function copyAndImport(
  sourceDir: string,
  targetDir: string,
  store: { importItems(entries: unknown[]): number },
): { added: number; failed: number } {
  let failed = 0;
  const entries = readIndex(sourceDir).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const raw = entry as Record<string, unknown>;
    if (typeof raw.file !== 'string' || !raw.file) return [];
    const file = basename(raw.file);
    const target = join(targetDir, file);
    if (!existsSync(target)) {
      mkdirSync(targetDir, { recursive: true });
      try {
        copyFileSync(join(sourceDir, file), target);
      } catch {
        // 源音频被删了或复制失败：这条先不要，下次启动再试。
        failed += 1;
        return [];
      }
    }
    return [{ ...raw, file, path: target }];
  });
  return { added: store.importItems(entries), failed };
}
