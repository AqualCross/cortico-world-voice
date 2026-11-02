import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertLongAudio, planRvcChunks, rvcJoinFilter, type LongAudioDeps } from '../src/rvc-long.ts';
import { encodeWav, wavFileLayout, wavLayout, wavSeconds } from '../src/wav.ts';

const wav = (seconds: number): Buffer => encodeWav(new Int16Array(Math.round(seconds * 16_000)), 16_000);

describe('长音频变声切片', () => {
  it('不超过一片时原样一次转完', () => {
    expect(planRvcChunks(60, 90, 2)).toEqual([{ start: 0, duration: 60 }]);
  });

  it('按步长切片并保留重叠，尾段太短就并进上一段', () => {
    const plans = planRvcChunks(312.293333, 90, 2);
    expect(plans.map((plan) => plan.start)).toEqual([0, 88, 176, 264]);
    expect(plans.map((plan) => Number(plan.duration.toFixed(6)))).toEqual([90, 90, 90, 48.293333]);
    const joined = plans.reduce((sum, plan) => sum + plan.duration, 0) - 2 * (plans.length - 1);
    expect(joined).toBeCloseTo(312.293333, 6);
    expect(planRvcChunks(91, 90, 2)).toEqual([{ start: 0, duration: 91 }]);
    expect(planRvcChunks(93, 90, 2).map((plan) => plan.start)).toEqual([0, 88]);
  });

  it('拒绝无效的时长和切片参数', () => {
    expect(() => planRvcChunks(0)).toThrow('时长');
    expect(() => planRvcChunks(10, 4, 2)).toThrow('重叠');
    expect(() => planRvcChunks(10, 4, -1)).toThrow('重叠');
  });

  it('拼接链按相邻片段交叉淡化，最后补齐到原时长', () => {
    expect(rvcJoinFilter(3, 2, 312.293333)).toBe(
      '[0][1]acrossfade=d=2:c1=tri:c2=tri[j1];'
      + '[j1][2]acrossfade=d=2:c1=tri:c2=tri[joined];'
      + '[joined]apad=whole_dur=312.293333,atrim=0:312.293333[out]',
    );
    expect(rvcJoinFilter(2, 1, 10)).toBe(
      '[0][1]acrossfade=d=1:c1=tri:c2=tri[joined];'
      + '[joined]apad=whole_dur=10.000000,atrim=0:10.000000[out]',
    );
    expect(() => rvcJoinFilter(0, 2, 10)).toThrow();
  });
});

describe('WAV 文件头', () => {
  const bytes = wav(0.2);

  it('读出 data 起点、长度和每秒字节数', () => {
    const layout = wavLayout(bytes);
    expect(layout).toEqual({ dataOffset: 44, dataBytes: 6400, bytesPerSecond: 32_000 });
    expect(wavSeconds(bytes)).toBeCloseTo(0.2, 6);
    expect(wavLayout(bytes, bytes.length + 1000)?.dataBytes).toBe(6400);
    expect(wavLayout(Buffer.from('not a wav'))).toBeNull();
  });

  it('不读整个文件也能拿到布局', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rvc-wav-'));
    const path = join(dir, 'a.wav');
    try {
      writeFileSync(path, bytes);
      expect(wavFileLayout(path)).toEqual({ dataOffset: 44, dataBytes: 6400, bytesPerSecond: 32_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('长音频转换编排', () => {
  interface Call { kind: 'decode' | 'split' | 'join' | 'convert'; args: string[] }

  function setup(seconds: number) {
    const dir = mkdtempSync(join(tmpdir(), 'rvc-long-'));
    const source = join(dir, 'source.wav');
    const out = join(dir, 'out.wav');
    writeFileSync(source, wav(seconds));
    const calls: Call[] = [];
    const made: string[] = [];
    let seq = 0;
    const deps: LongAudioDeps = {
      async ffmpeg(args: string[]) {
        const target = args[args.length - 1];
        if (args.includes('-filter_complex')) {
          calls.push({ kind: 'join', args });
          writeFileSync(target, Buffer.alloc(0));
          return;
        }
        if (args.includes('-ss')) {
          calls.push({ kind: 'split', args });
          writeFileSync(target, Buffer.alloc(0));
          return;
        }
        calls.push({ kind: 'decode', args });
        writeFileSync(target, wav(seconds));
      },
      async convert(input: string, output: string) {
        calls.push({ kind: 'convert', args: [input, output] });
        writeFileSync(output, Buffer.alloc(0));
        return 12;
      },
      scratch(name: string) {
        const path = join(dir, `s${++seq}-${name}`);
        made.push(path);
        return path;
      },
      remove(path: string) {
        rmSync(path, { force: true });
      },
    };
    return { dir, source, out, calls, made, deps, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('长音频切片、逐片转换，再按交叠拼回', async () => {
    const test = setup(10);
    try {
      const result = await convertLongAudio(test.source, test.out, test.deps, { chunkSeconds: 4, overlapSeconds: 1 });
      expect(result.chunks).toBe(3);
      expect(result.seconds).toBeCloseTo(10, 6);
      expect(result.ms).toBe(36);
      expect(test.calls.filter((call) => call.kind === 'split')).toHaveLength(3);
      expect(test.calls.filter((call) => call.kind === 'convert')).toHaveLength(3);
      const join = test.calls.find((call) => call.kind === 'join')!;
      const filter = join.args[join.args.indexOf('-filter_complex') + 1];
      expect(filter.match(/acrossfade/g)).toHaveLength(2);
      expect(filter).toContain('apad=whole_dur=10.000000');
      expect(existsSync(test.out)).toBe(true);
      for (const path of test.made) expect(existsSync(path)).toBe(false);
    } finally {
      test.done();
    }
  });

  it('短音频不切片，直接进引擎', async () => {
    const test = setup(3);
    try {
      const result = await convertLongAudio(test.source, test.out, test.deps, { chunkSeconds: 4, overlapSeconds: 1 });
      expect(result).toMatchObject({ chunks: 1, ms: 12 });
      expect(test.calls.filter((call) => call.kind === 'split')).toHaveLength(0);
      expect(test.calls.filter((call) => call.kind === 'convert')).toHaveLength(1);
      expect(test.calls.filter((call) => call.kind === 'join')).toHaveLength(0);
    } finally {
      test.done();
    }
  });
});
