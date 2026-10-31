import { describe, it, expect } from 'vitest';
import { SingEngine } from './../src/singer.ts';

/** 用 node -e 当假子进程：就绪一行，之后读一行回一行；歌词里带「炸」就失败。 */
const STUB = [
  'let buf = "";',
  'process.stdout.write(JSON.stringify({ type: "ready", voicebank: "Qixuan", sampleRate: 44100, speakers: [] }) + "\\n");',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => {',
  '  buf += d;',
  '  let i;',
  '  while ((i = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
  '    if (!line.trim()) continue;',
  '    const req = JSON.parse(line);',
  '    const out = String(req.lyrics).includes("炸")',
  '      ? { id: req.id, ok: false, kind: "infer", error: "唱不上去" }',
  '      : { id: req.id, ok: true, ms: 5, seconds: 3.2, notes: 8, sungChars: 6, sampleRate: 44100 };',
  '    process.stdout.write(JSON.stringify(out) + "\\n");',
  '  }',
  '});',
].join('\n');

const make = (idleMs = 5000): SingEngine => new SingEngine({ command: process.execPath, args: ['-e', STUB], idleMs });

const request = (lyrics = '大肥鱼呀') => ({
  out: 'C:/tmp/out.wav',
  lyrics,
  bpm: 96,
  keyShift: 0,
  scale: 'major',
  seed: 0,
  speaker: '',
  maxSeconds: 60,
});

describe('本机唱歌子进程', () => {
  it('就绪行带来声库与采样率，唱完带回时长与音符数', async () => {
    const engine = make();
    try {
      expect(engine.state().phase).toBe('stopped');
      const result = await engine.sing(request());
      expect(result).toEqual({ ms: 5, seconds: 3.2, notes: 8, sungChars: 6, sampleRate: 44100 });
      const state = engine.state();
      expect(state.phase).toBe('ready');
      expect(state.voicebank).toBe('Qixuan');
      expect(state.sampleRate).toBe(44100);
    } finally {
      engine.dispose();
    }
  });

  it('一首失败不带走进程：下一首照常唱', async () => {
    const engine = make();
    try {
      await expect(engine.sing(request('炸了'))).rejects.toThrow('唱不上去');
      const ok = await engine.sing(request());
      expect(ok.notes).toBe(8);
    } finally {
      engine.dispose();
    }
  });

  it('空闲到时自己退出，下次再拉起', async () => {
    const engine = make(30);
    try {
      await engine.sing(request());
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(engine.state().phase).toBe('stopped');
      expect((await engine.sing(request())).sampleRate).toBe(44100);
    } finally {
      engine.dispose();
    }
  });
});
