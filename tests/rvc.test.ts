import { describe, it, expect } from 'vitest';
import { RvcEngine } from './../src/rvc.ts';

/** 用 node -e 当假子进程：就绪一行，之后读一行回一行；model 路径里带 broken 就失败。 */
const STUB = [
  'let buf = "";',
  'process.stdout.write(JSON.stringify({ type: "ready", device: "cuda:0" }) + "\\n");',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => {',
  '  buf += d;',
  '  let i;',
  '  while ((i = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
  '    if (!line.trim()) continue;',
  '    const req = JSON.parse(line);',
  '    if (String(req.model).includes("broken")) {',
  '      process.stdout.write(JSON.stringify({ id: req.id, ok: false, kind: "infer", error: "推理炸了" }) + "\\n");',
  '    } else {',
  '      process.stdout.write(JSON.stringify({ id: req.id, ok: true, ms: 12, loadMs: 34, sampleRate: 40000 }) + "\\n");',
  '    }',
  '  }',
  '});',
].join('\n');

const make = (idleMs = 5000): RvcEngine => new RvcEngine({ command: process.execPath, args: ['-e', STUB], idleMs });

const request = (model = 'D:/voices/a.pth') => ({
  input: 'D:/in.wav',
  output: 'D:/out.wav',
  model,
  pitch: 0,
  indexRate: 0.3,
  protect: 0.33,
});

describe('本机变声子进程', () => {
  it('就绪行带来设备，转完带回耗时与采样率', async () => {
    const engine = make();
    try {
      expect(engine.state().phase).toBe('stopped');
      const result = await engine.convert(request());
      expect(result).toEqual({ ms: 12, loadMs: 34, sampleRate: 40000 });
      expect(engine.state().phase).toBe('ready');
      expect(engine.state().device).toBe('cuda:0');
      expect(engine.state().model).toBe('a.pth');
    } finally {
      engine.dispose();
    }
  });

  it('一次失败不带走进程：下一次照常转', async () => {
    const engine = make();
    try {
      await expect(engine.convert(request('D:/voices/broken.pth'))).rejects.toThrow('推理炸了');
      const ok = await engine.convert(request());
      expect(ok.ms).toBe(12);
    } finally {
      engine.dispose();
    }
  });

  it('空闲到时自己退出，下次再拉起', async () => {
    const engine = make(30);
    try {
      await engine.convert(request());
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(engine.state().phase).toBe('stopped');
      const again = await engine.convert(request());
      expect(again.sampleRate).toBe(40000);
    } finally {
      engine.dispose();
    }
  });
});
