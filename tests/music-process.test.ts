import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MusicProcessor, mixTracks, type MusicTask } from '../src/music-process.ts';
import { encodeWav } from '../src/wav.ts';

let dir: string, processor: MusicProcessor | undefined;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audio-music-')); });
afterEach(async () => { await processor?.stop(); processor = undefined; rmSync(dir, { recursive: true, force: true }); });
const wav = (frequency = 440): Buffer => encodeWav(Int16Array.from({ length: 3200 }, (_, index) => Math.round(Math.sin(index * frequency * 2 * Math.PI / 16000) * 6553)), 16000);
const wait = async (task: MusicTask): Promise<MusicTask> => {
  await expect.poll(() => processor!.list().find((item) => item.id === task.id)!.phase, { timeout: 5000 }).not.toBe('working');
  return processor!.list().find((item) => item.id === task.id)!;
};

describe('音乐处理', () => {
  it('分离任务非阻塞返回，保留两轨、源文件及重启后的历史', async () => {
    const input = join(dir, 'song with spaces.wav'), source = wav(); writeFileSync(input, source);
    const worker = join(dir, 'separator.cjs');
    writeFileSync(worker, `const fs=require('node:fs'),path=require('node:path'); const args=process.argv.slice(2),out=path.join(args[args.indexOf('--output')+1],'htdemucs'),input=args[args.indexOf('--input')+1]; fs.mkdirSync(out,{recursive:true}); for(const stem of ['vocals','no_vocals']) fs.copyFileSync(input,path.join(out,stem+'.wav'));`);
    processor = new MusicProcessor({ dir, ffmpeg: async () => 'ffmpeg', separator: () => ({ command: process.execPath, args: [worker] }) });
    const queued = processor.separate(input, 'ui');
    expect(queued.phase).toBe('working');
    const task = await wait(queued);
    expect(task.phase).toBe('done');
    expect(task.outputs.map((output) => output.name)).toEqual(['人声', '伴奏']);
    expect(readFileSync(input)).toEqual(source);
    expect(readFileSync(processor.file(task.id, 0).$file.path)).toEqual(source);
    expect(() => processor!.file('../bad', 0)).toThrow('找不到');
    await processor.stop();
    processor = new MusicProcessor({ dir, ffmpeg: async () => 'ffmpeg', separator: () => ({ command: '', args: [] }) });
    expect(processor.list()[0].outputs).toEqual(task.outputs);
    processor.remove(task.id);
    expect(processor.list()).toEqual([]);
    expect(existsSync(task.outputs[0].path)).toBe(true);
  });

  it('失败保留原因，取消终止子进程且不暴露半成品', async () => {
    const input = join(dir, 'source.wav'); writeFileSync(input, wav());
    let args = ['-e', 'console.error("separation engine failed"); process.exit(2)', '--'];
    const failures: MusicTask[] = [];
    processor = new MusicProcessor({ dir, ffmpeg: async () => 'ffmpeg', separator: () => ({ command: process.execPath, args }), failed: async (task) => { failures.push(task); } });
    const failed = await wait(processor.separate(input, 'tool'));
    expect(failed.phase).toBe('error'); expect(failed.detail).toContain('separation engine failed');
    expect(failures[0].id).toBe(failed.id);
    args = ['-e', 'setInterval(()=>{},1000)', '--'];
    const queued = processor.separate(input, 'ui');
    processor.cancel(queued.id);
    expect((await wait(queued)).phase).toBe('cancelled');
    expect(() => processor!.file(queued.id, 0)).toThrow('找不到');
    expect(existsSync(input)).toBe(true);
  });

  it('拒绝无效音量、延迟与不存在的音轨', () => {
    const input = join(dir, 'source.wav'); writeFileSync(input, wav());
    expect(() => mixTracks([{ path: input, volume: Number.NaN }])).toThrow('音量');
    expect(() => mixTracks([{ path: input, delaySec: -1 }])).toThrow('延迟');
    expect(() => mixTracks([{ path: join(dir, 'absent.wav') }])).toThrow('没有');
    expect(() => mixTracks([])).toThrow('1–16');
  });

  const ffmpeg = process.env.AUDIO_TEST_FFMPEG || 'ffmpeg';
  it.skipIf(spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status !== 0)('真实 FFmpeg 按音量和延迟混音，最长音轨尾部仍保留', async () => {
    const first = join(dir, 'a.wav'), second = join(dir, 'b.wav'); writeFileSync(first, wav()); writeFileSync(second, wav(880));
    processor = new MusicProcessor({ dir, ffmpeg: async () => ffmpeg, separator: () => ({ command: '', args: [] }) });
    const task = await wait(processor.mix([{ path: first, volume: 50 }, { path: second, volume: 100, delaySec: 0.1 }], 'ui'));
    expect(task.phase, task.detail).toBe('done');
    const result = execFileSync(ffmpeg, ['-v', 'error', '-i', task.outputs[0].path, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { windowsHide: true });
    const rms = (start: number, end: number): number => {
      let energy = 0; for (let index = start * 16000; index < end * 16000; index++) energy += (result.readInt16LE(Math.round(index) * 2) / 32768) ** 2;
      return Math.sqrt(energy / ((end - start) * 16000));
    };
    expect(result.length / 2 / 16000).toBeCloseTo(0.3, 2);
    // 单声道扩成立体声使用恒功率分配；验证音量比例与延迟前、中、后的能量。
    expect(rms(0.03, 0.07)).toBeCloseTo(0.05, 2);
    expect(rms(0.12, 0.18)).toBeCloseTo(0.1118, 2);
    expect(rms(0.23, 0.27)).toBeCloseTo(0.1, 2);
  });
});
