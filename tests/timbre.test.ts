import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimbreStore } from '../src/timbre.ts';

let root: string;
let store: TimbreStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'audio-timbre-'));
  store = new TimbreStore(join(root, 'timbre'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const wav = Buffer.from('RIFF0000WAVEfmt ');

describe('参考音频', () => {
  it('导入时复制进 timbre 目录，重名加序号', () => {
    const src = join(root, '小肥鱼.wav');
    writeFileSync(src, wav);
    const first = store.importFile(src);
    const second = store.importFile(src);
    expect(first.file).toBe('小肥鱼.wav');
    expect(second.file).toBe('小肥鱼-1.wav');
    expect(readFileSync(store.pathOf(first.file)).equals(wav)).toBe(true);
    expect(store.list()).toHaveLength(2);
  });

  it('只收 WAV；字节导入检查 RIFF/WAVE 头', () => {
    const bad = join(root, 'a.mp3');
    writeFileSync(bad, wav);
    expect(() => store.importFile(bad)).toThrow(/WAV/);
    expect(() => store.importBytes('b.wav', Buffer.from('nope'))).toThrow(/WAV/);
    expect(store.importBytes('c.wav', wav).file).toBe('c.wav');
  });

  it('扩展名是 .wav 但内容不是 WAV 的也拒收', () => {
    const fake = join(root, 'fake.wav');
    writeFileSync(fake, Buffer.from('RIFF0000WEBP....'));
    expect(() => store.importFile(fake)).toThrow(/WAV/);
    expect(store.list()).toHaveLength(0);
  });

  it('台本按音频各自保存', () => {
    const item = store.importBytes('a.wav', wav);
    store.importBytes('b.wav', wav);
    store.setText(item.file, '今天天气不错');
    expect(store.get('a.wav')?.text).toBe('今天天气不错');
    expect(store.get('b.wav')?.text).toBe('');
  });
});
