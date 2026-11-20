import { describe, it, expect } from 'vitest';
import { LocalAsr } from './../src/local-asr.ts';

/** 用 node -e 当假子进程：读到一行回一行，pcm 是 RkFJTA==（"FAIL"）时就回错误。 */
const STUB = [
  'process.stdin.setEncoding("utf8");',
  'let buf = "";',
  'process.stdin.on("data", (d) => {',
  '  buf += d;',
  '  let i;',
  '  while ((i = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
  '    if (!line.trim()) continue;',
  '    const req = JSON.parse(line);',
  '    const out = req.pcm === "RkFJTA=="',
  '      ? { id: req.id, ok: false, error: "音频解不出来" }',
  '      : { id: req.id, ok: true, text: "第" + req.id + "条", lang: "<|zh|>", emotion: "<|HAPPY|>", event: "<|BGM|>", ms: 3 };',
  '    process.stdout.write(JSON.stringify(out) + "\\n");',
  '  }',
  '});',
].join('\n');

const make = (): LocalAsr => new LocalAsr({ command: process.execPath, args: ['-e', STUB], idleMs: 50 });

describe('本机识别子进程', () => {
  it('请求按 id 配对，字段原样带回', async () => {
    const asr = make();
    try {
      const first = await asr.transcribe(Buffer.from('x'));
      const second = await asr.transcribe(Buffer.from('y'));
      expect(first.text).toBe('第1条');
      expect(second.text).toBe('第2条');
      expect(second.emotion).toBe('<|HAPPY|>');
      expect(second.ms).toBe(3);
    } finally {
      asr.dispose();
    }
  });

  it('子进程报错时拒绝这一次，不影响下一次', async () => {
    const asr = make();
    try {
      await expect(asr.transcribe(Buffer.from('FAIL'))).rejects.toThrow('音频解不出来');
      const ok = await asr.transcribe(Buffer.from('z'));
      expect(ok.text).toBe('第2条');
    } finally {
      asr.dispose();
    }
  });

  it('闲置 0 常驻：到时不杀进程', async () => {
    const asr = new LocalAsr({ command: process.execPath, args: ['-e', STUB], idleMs: 0 });
    try {
      await asr.transcribe(Buffer.from('x'));
      const child = (asr as unknown as { child: unknown }).child;
      expect(child).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect((asr as unknown as { child: unknown }).child).toBe(child);
    } finally {
      asr.dispose();
    }
  });

  it('getter 热改后 refreshIdle 立刻按新值重算', async () => {
    let ms = 30;
    const asr = new LocalAsr({ command: process.execPath, args: ['-e', STUB], idleMs: () => ms });
    try {
      await asr.transcribe(Buffer.from('x'));
      ms = 0;
      asr.refreshIdle();
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect((asr as unknown as { child: unknown }).child).not.toBeNull();
      ms = 30;
      asr.refreshIdle();
      await new Promise((resolve) => setTimeout(resolve, 120));
      // kill 后下一次调用静默拉起新进程。
      expect((asr as unknown as { child: unknown }).child).toBeNull();
      expect((await asr.transcribe(Buffer.from('z'))).text).toBe('第2条');
    } finally {
      asr.dispose();
    }
  });
});
