/**
 * 长音频变声：RVC 子进程按「请求」计时，整首歌一次转会撞上限。
 * 这里先解成 44.1k 单声道，再按固定步长切片、相邻片段留重叠，转完交叉淡化拼回原时长。
 * 短音频（不超过一片）仍旧一次转完，不付切片和拼接的代价。
 */
import { wavFileLayout } from './wav.ts';

/** 90 秒一片：单片推理远低于 RVC 的 300 秒请求上限；2 秒交叠让接缝落在淡化里。 */
export const RVC_CHUNK_SECONDS = 90;
export const RVC_OVERLAP_SECONDS = 2;

export interface RvcChunkPlan {
  start: number;
  duration: number;
}

export interface LongAudioDeps {
  /** 跑一次 ffmpeg；失败由实现方抛错。 */
  ffmpeg(args: string[], timeoutMs: number): Promise<void>;
  /** 把一段音频换成当前音色，返回推理耗时（毫秒）。 */
  convert(input: string, output: string): Promise<number>;
  /** 本次转换独占的临时文件路径。 */
  scratch(name: string): string;
  remove(path: string): void;
}

export interface LongAudioResult {
  /** 各片推理耗时之和。 */
  ms: number;
  chunks: number;
  seconds: number;
}

/** 切片计划：相邻片段重叠，最后只剩一小截时并进上一段。 */
export function planRvcChunks(
  totalSeconds: number,
  chunkSeconds = RVC_CHUNK_SECONDS,
  overlapSeconds = RVC_OVERLAP_SECONDS,
): RvcChunkPlan[] {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) throw new Error('音频时长无效。');
  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) throw new Error('切片长度无效。');
  if (!Number.isFinite(overlapSeconds) || overlapSeconds < 0 || overlapSeconds * 2 >= chunkSeconds) throw new Error('切片重叠无效。');
  if (totalSeconds <= chunkSeconds) return [{ start: 0, duration: totalSeconds }];

  const plans: RvcChunkPlan[] = [];
  let start = 0;
  for (;;) {
    const end = Math.min(totalSeconds, start + chunkSeconds);
    plans.push({ start, duration: end - start });
    if (end >= totalSeconds) break;
    const next = end - overlapSeconds;
    // 只差一个交叠长度时并进当前段，避免出现一个比淡化还短的尾段。
    if (totalSeconds - next <= overlapSeconds * 2) {
      plans[plans.length - 1].duration = totalSeconds - start;
      break;
    }
    start = next;
  }
  return plans;
}

/** 把各片按重叠长度交叉淡化拼起来，最后补齐或裁到原时长。 */
export function rvcJoinFilter(chunks: number, overlapSeconds: number, totalSeconds: number): string {
  if (!Number.isInteger(chunks) || chunks < 1) throw new Error('没有可拼接的片段。');
  const seconds = totalSeconds.toFixed(6);
  const parts: string[] = [];
  let last = '0';
  for (let index = 1; index < chunks; index += 1) {
    const label = index === chunks - 1 ? 'joined' : `j${index}`;
    parts.push(`[${last}][${index}]acrossfade=d=${overlapSeconds}:c1=tri:c2=tri[${label}]`);
    last = label;
  }
  parts.push(`[${last}]apad=whole_dur=${seconds},atrim=0:${seconds}[out]`);
  return parts.join(';');
}

export async function convertLongAudio(
  source: string,
  out: string,
  deps: LongAudioDeps,
  opts: { chunkSeconds?: number; overlapSeconds?: number; timeoutMs?: number } = {},
): Promise<LongAudioResult> {
  const chunkSeconds = opts.chunkSeconds ?? RVC_CHUNK_SECONDS;
  const overlapSeconds = opts.overlapSeconds ?? RVC_OVERLAP_SECONDS;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const decoded = deps.scratch('decoded.wav');
  const inputs: string[] = [];
  const outputs: string[] = [];
  try {
    await deps.ffmpeg([
      '-hide_banner', '-nostdin', '-v', 'error', '-y',
      '-i', source, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
      '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le',
      decoded,
    ], timeoutMs);
    const layout = wavFileLayout(decoded);
    if (!layout) throw new Error('读不出音频时长，无法分段变声。');
    const seconds = layout.dataBytes / layout.bytesPerSecond;
    const plans = planRvcChunks(seconds, chunkSeconds, overlapSeconds);

    if (plans.length === 1) {
      const ms = await deps.convert(decoded, out);
      return { ms, chunks: 1, seconds };
    }

    let ms = 0;
    for (const [index, plan] of plans.entries()) {
      const input = deps.scratch(`chunk-${index + 1}.wav`);
      const output = deps.scratch(`chunk-${index + 1}-rvc.wav`);
      inputs.push(input);
      outputs.push(output);
      await deps.ffmpeg([
        '-hide_banner', '-nostdin', '-v', 'error', '-y',
        '-i', decoded, '-ss', plan.start.toFixed(6), '-t', plan.duration.toFixed(6),
        '-c:a', 'pcm_s16le', input,
      ], timeoutMs);
      ms += await deps.convert(input, output);
    }

    await deps.ffmpeg([
      '-hide_banner', '-nostdin', '-v', 'error', '-y',
      ...outputs.flatMap((path) => ['-i', path]),
      '-filter_complex', rvcJoinFilter(plans.length, overlapSeconds, seconds),
      '-map', '[out]', '-c:a', 'pcm_s16le', out,
    ], timeoutMs);
    return { ms, chunks: plans.length, seconds };
  } finally {
    deps.remove(decoded);
    for (const path of [...inputs, ...outputs]) deps.remove(path);
  }
}
