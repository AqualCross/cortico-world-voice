import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { runMusicCommand } from './music-command.ts';

export interface MixTrack { path: string; volume: number; delaySec: number }
export interface MusicResult { name: string; path: string }
export interface MusicTask {
  id: string;
  kind: 'separate' | 'mix';
  title: string;
  phase: 'working' | 'done' | 'error' | 'cancelled';
  detail: string;
  createdAt: string;
  outputs: MusicResult[];
  origin: 'tool' | 'ui';
}
export interface SeparatorCommand { command: string; args: string[]; env?: Record<string, string> }

function inputPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请选择音频文件。');
  const path = resolve(value.trim());
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`没有这个音频文件：${path}`);
  return path;
}

export function mixTracks(value: unknown): MixTrack[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error('混音需要 1–16 条音轨。');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('音轨参数不正确。');
    const track = item as Partial<MixTrack>;
    const volume = track.volume ?? 100, delaySec = track.delaySec ?? 0;
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 200) throw new Error('音轨音量应为 0–200%。');
    if (typeof delaySec !== 'number' || !Number.isFinite(delaySec) || delaySec < 0 || delaySec > 3600) throw new Error('音轨延迟应为 0–3600 秒。');
    return { path: inputPath(track.path), volume, delaySec };
  });
}

export function mixArgs(tracks: MixTrack[], output: string): string[] {
  const filters = tracks.map((track, index) => `[${index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${track.volume / 100},adelay=${Math.round(track.delaySec * 1000)}:all=1[t${index}]`);
  filters.push(`${tracks.map((_, index) => `[t${index}]`).join('')}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false:latency=true[out]`);
  return ['-hide_banner', '-nostdin', '-y', ...tracks.flatMap((track) => ['-i', track.path]), '-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', output];
}

/** 分离和混音均在子进程中执行；历史索引只公开已完成的输出。 */
export class MusicProcessor {
  private readonly tasks: MusicTask[];
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private stopped = false;

  constructor(private readonly opts: {
    dir: string;
    ffmpeg: () => Promise<string>;
    separator: () => SeparatorCommand;
    complete?: (task: MusicTask) => Promise<void>;
    failed?: (task: MusicTask) => Promise<void>;
  }) {
    const file = join(opts.dir, 'tasks.json');
    this.tasks = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as MusicTask[] : [];
    for (const task of this.tasks) {
      if (task.phase === 'working') { task.phase = 'error'; task.detail = '上次运行已中断，请重新开始。'; }
    }
  }

  list(): MusicTask[] { return structuredClone(this.tasks); }

  separate(value: unknown, origin: 'tool' | 'ui'): MusicTask {
    const input = inputPath(value), separator = this.opts.separator();
    return this.launch('separate', basename(input), origin, async (task, dir, signal) => {
      const ffmpeg = await this.opts.ffmpeg();
      await runMusicCommand(separator.command, [...separator.args, '--input', input, '--output', dir], {
        signal, env: { ...separator.env, PATH: `${dirname(ffmpeg)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
        onOutput: (line) => { task.detail = line; },
      });
      const files = [['人声', 'vocals.wav', 'vocals.wav'], ['伴奏', 'no_vocals.wav', 'accompaniment.wav']];
      for (const [name, source, output] of files) {
        const path = join(dir, output);
        renameSync(join(dir, 'htdemucs', source), path);
        task.outputs.push({ name, path });
      }
    });
  }

  mix(value: unknown, origin: 'tool' | 'ui'): MusicTask {
    const tracks = mixTracks(value);
    return this.launch('mix', tracks.map((track) => basename(track.path)).join(' + '), origin, async (task, dir, signal) => {
      const ffmpeg = await this.opts.ffmpeg(), partial = join(dir, 'mix.partial.wav'), path = join(dir, 'mix.wav');
      await runMusicCommand(ffmpeg, mixArgs(tracks, partial), { signal, onOutput: (line) => { task.detail = line; } });
      renameSync(partial, path);
      task.outputs.push({ name: '混音', path });
    });
  }

  cancel(id: string): void { this.active.get(id)?.abort.abort(); }

  remove(id: string): void {
    if (this.active.has(id)) throw new Error('先等待任务完成或取消任务。');
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index >= 0) { this.tasks.splice(index, 1); this.save(); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const { abort } of this.active.values()) abort.abort();
    await Promise.allSettled([...this.active.values()].map(({ done }) => done));
  }

  file(id: string, index: number): { $file: { path: string; mime: string; bytes: number; sha256: string } } {
    const task = this.tasks.find((task) => task.id === id && task.phase === 'done');
    const item = task?.outputs[index];
    if (!task || !item || !/^[a-f0-9]{32}$/.test(id)) throw new Error('找不到已完成的音频。');
    const name = task.kind === 'mix' ? 'mix.wav' : index === 0 ? 'vocals.wav' : 'accompaniment.wav';
    const path = join(this.opts.dir, task.kind, id, name);
    return { $file: { path, mime: 'audio/wav', bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } };
  }

  private save(): void {
    mkdirSync(this.opts.dir, { recursive: true });
    const path = join(this.opts.dir, 'tasks.json');
    writeFileSync(`${path}.tmp`, JSON.stringify(this.tasks, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  private launch(kind: MusicTask['kind'], title: string, origin: MusicTask['origin'], work: (task: MusicTask, dir: string, signal: AbortSignal) => Promise<void>): MusicTask {
    if (this.stopped) throw new Error('音乐任务已停止。');
    if ([...this.active.keys()].some((id) => this.tasks.find((task) => task.id === id)?.kind === kind)) throw new Error(kind === 'mix' ? '正在混音，请等待或取消。' : '正在分离，请等待或取消。');
    if (this.tasks.length >= 200) throw new Error('已保留 200 项音乐任务，请先移除部分任务记录。');
    const task: MusicTask = { id: randomUUID().replaceAll('-', ''), kind, title, phase: 'working', detail: '开始处理', createdAt: new Date().toISOString(), outputs: [], origin };
    const dir = join(this.opts.dir, kind, task.id);
    mkdirSync(dir, { recursive: true });
    this.tasks.unshift(task);
    this.save();
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30 * 60_000)]);
    const done = Promise.resolve().then(() => work(task, dir, signal)).then(async () => {
      signal.throwIfAborted();
      if (!task.outputs.every((output) => statSync(output.path).size > 44)) throw new Error('没有生成有效的音频。');
      task.phase = 'done'; task.detail = '';
      this.save();
      if (!this.stopped) await this.opts.complete?.(structuredClone(task));
    }).catch(async (error: unknown) => {
      task.phase = abort.signal.aborted ? 'cancelled' : 'error';
      task.detail = abort.signal.aborted ? '已取消' : error instanceof Error ? error.message : String(error);
      task.outputs = [];
      this.save();
      if (!this.stopped && task.phase === 'error') await this.opts.failed?.(structuredClone(task));
    }).finally(() => { this.active.delete(task.id); });
    this.active.set(task.id, { abort, done });
    return structuredClone(task);
  }
}
