/**
 * 监听车道：选了哪几路声音、每路用哪种切分。存在 World 数据目录的 `lanes.json`，
 * 因为配置面只收标量，放不下「数组 + 每项一份设置」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Lane {
  /** `system` / `mic` / `app:<pid>`。 */
  id: string;
  /** 这一路的切分方式；空串表示跟全局默认。 */
  vad: string;
}

export function readLanes(file: string): Lane[] {
  // 没有文件 = 一路都没勾：采集会真的开始录，默认不该替人决定。
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { lanes?: unknown };
    if (!Array.isArray(data.lanes)) return [];
    return data.lanes
      .filter((lane): lane is Lane => !!lane && typeof lane === 'object' && typeof (lane as Lane).id === 'string')
      .map((lane) => ({ id: lane.id, vad: typeof lane.vad === 'string' ? lane.vad : '' }));
  } catch {
    return [];
  }
}

export function writeLanes(file: string, lanes: Lane[]): Lane[] {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ lanes }, null, 2) + '\n');
  return lanes;
}

/** 勾选一路；已在就只更新切分方式。 */
export function setLane(lanes: Lane[], id: string, vad: string): Lane[] {
  if (!id) return lanes;
  const existing = lanes.find((lane) => lane.id === id);
  if (existing) {
    existing.vad = vad;
    return lanes;
  }
  return [...lanes, { id, vad }];
}

/** 取消勾选一路。 */
export function removeLane(lanes: Lane[], id: string): Lane[] {
  return lanes.filter((lane) => lane.id !== id);
}
