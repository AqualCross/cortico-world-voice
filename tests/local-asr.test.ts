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
});
