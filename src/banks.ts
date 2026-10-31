/** DiffSinger 声库扫描：`dsconfig.yaml` 在目录根或唯一一层子目录里；音色取 `speakers:` 段。 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BankInfo {
  /** 目录名，写进配置 `sing.voicebank`。 */
  name: string;
  label: string;
  colors: string[];
}

function rootOf(dir: string): string {
  if (existsSync(join(dir, 'dsconfig.yaml'))) return dir;
  let subs: string[] = [];
  try {
    subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return '';
  }
  const hits = subs.filter((name) => existsSync(join(dir, name, 'dsconfig.yaml')));
  return hits.length === 1 ? join(dir, hits[0]) : '';
}

function readColors(root: string): string[] {
  const path = join(root, 'dsconfig.yaml');
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^speakers:\s*$/.test(line));
  if (start < 0) return [];
  const colors: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const hit = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!hit) break;
    const short = hit[1].split('/').pop() ?? hit[1];
    colors.push(short.startsWith('acoustic_') ? short.slice('acoustic_'.length) : short);
  }
  return colors;
}

function readLabel(root: string, fallback: string): string {
  const file = join(root, 'character.txt');
  if (!existsSync(file)) return fallback;
  const hit = /^name=(.+)$/m.exec(readFileSync(file, 'utf8'));
  return hit ? hit[1].trim() || fallback : fallback;
}

export function listBanks(dir: string): BankInfo[] {
  let subs: string[] = [];
  try {
    subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const banks: BankInfo[] = [];
  for (const name of subs) {
    const root = rootOf(join(dir, name));
    if (!root) continue;
    banks.push({ name, label: readLabel(root, name), colors: readColors(root) });
  }
  return banks;
}

/** 声库根目录（`dsconfig.yaml` 所在那层）；不在或结构不对返回 null。 */
export function bankDir(dir: string, name: string): string | null {
  if (!name) return null;
  const root = rootOf(join(dir, name));
  return root || null;
}
