/**
 * 本 World 的数据根：`<dataDir>/audio/`。data 根目录留给部署和框架自己的文件，
 * 别的 World 也各占一个子目录，不混在一起。
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function audioHome(dataDir: string): string {
  return join(dataDir, 'audio');
}

export function audioPath(dataDir: string, ...parts: string[]): string {
  return join(audioHome(dataDir), ...parts);
}

/** 旧版直接写在 data 根下的条目；搬过去后 data 根只剩部署自己的文件。 */
const LEGACY: ReadonlyArray<[from: string, to: string]> = [
  ['uv', 'uv'],
  ['ffmpeg', 'ffmpeg'],
  ['clips', 'out'],
  ['timbre', 'timbre'],
  ['rvc', 'rvc'],
  ['lanes.json', 'lanes.json'],
  // 已经撤掉的调用账本；留着给人查，不再写。
  ['audio-usage.jsonl', 'usage-legacy.jsonl'],
];

/** 已经在 `audio/` 里、后来改了名字的目录。 */
const RENAMED: ReadonlyArray<[from: string, to: string]> = [
  ['clips', 'out'],
];

/**
 * 把旧版写在 data 根下的条目搬进 `audio/`，再把 audio 里改过名的目录换到新名字。
 * 目标已存在或搬不动（文件被占）就跳过，下次启动再试；返回失败项给人看。
 */
export function migrateLayout(dataDir: string): string[] {
  const home = audioHome(dataDir);
  const failed: string[] = [];
  const move = (from: string, to: string, name: string): void => {
    if (!existsSync(from) || existsSync(to)) return;
    try {
      mkdirSync(home, { recursive: true });
      renameSync(from, to);
    } catch (err) {
      failed.push(`${name}：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  for (const [name, target] of LEGACY) move(join(dataDir, name), join(home, target), name);
  for (const [from, to] of RENAMED) move(join(home, from), join(home, to), `audio/${from}`);
  return failed;
}
