import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClipsStore } from '../src/clips.ts';
import { importLegacyRecords } from '../src/import-legacy.ts';
import { audioHome, audioPath, migrateLayout } from '../src/storage.ts';
import { TranscriptsStore } from '../src/transcripts.ts';

let root: string;
let dataDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'audio-records-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 一段能算出时长的 WAV：16 kHz 单声道 16-bit。 */
function wav(seconds = 0.5): Buffer {
  const rate = 16_000;
  const total = Math.round(rate * seconds);
  const b = Buffer.alloc(44 + total * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + total * 2, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(total * 2, 40);
  return b;
}

describe('记录仓库', () => {
  it('转写记录：新增、列表、按 id 删除、清空', () => {
    const store = new TranscriptsStore(join(root, 'transcripts'), 10);
    const item = store.add({
      text: '你好',
      source: { kind: 'file', ref: 'D:/a.wav' },
      model: 'SenseVoiceSmall',
      protocol: 'sensevoice',
      language: 'zh',
      seconds: 1.5,
      audioBytes: 100,
    });
    expect(store.count).toBe(1);
    expect(store.list()[0].text).toBe('你好');
    expect(store.list()[0].source).toEqual({ kind: 'file', ref: 'D:/a.wav' });
    expect(JSON.parse(readFileSync(store.indexFile, 'utf8')).items[0].id).toBe(item.id);

    // 重启：新实例从索引读回。
    const again = new TranscriptsStore(join(root, 'transcripts'), 10);
    expect(again.count).toBe(1);
    expect(again.remove(item.id)).toBe(true);
    expect(again.count).toBe(0);

    again.add({ text: 'a' });
    again.add({ text: 'b' });
    expect(again.clear()).toBe(2);
    expect(again.count).toBe(0);
  });

  it('转写记录：导入按 id 去重，新的在前，超出上限截断', () => {
    const store = new TranscriptsStore(join(root, 'transcripts'), 2);
    store.add({ text: '新' });
    const added = store.importItems([
      { id: 'old1', text: '旧一', createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'old2', text: '旧二', createdAt: '2026-10-02T00:00:00.000Z' },
      { id: 'old2', text: '旧二', createdAt: '2026-10-02T00:00:00.000Z' },
    ]);
    expect(added).toBe(2);
    expect(store.count).toBe(2);
    expect(store.list().map((item) => item.text)).toEqual(['新', '旧二']);
  });

  it('语音仓库：文件落盘，删除与清空会带走自己的文件', () => {
    const store = new ClipsStore(join(root, 'clips'));
    const item = store.add({ bytes: wav(0.5), ext: 'wav', text: '早安', voice: 'xll.wav', model: 'GPT-SoVITS' });
    expect(existsSync(item.path)).toBe(true);
    expect(item.bytes).toBeGreaterThan(44);
    expect(store.list()[0].text).toBe('早安');
    expect(store.totalBytes).toBe(item.bytes);

    expect(store.remove(item.id)).toBe(true);
    expect(existsSync(item.path)).toBe(false);

    const second = store.add({ bytes: wav(0.2), ext: 'wav', text: '二' });
    expect(store.clear()).toBe(1);
    expect(existsSync(second.path)).toBe(false);
  });

  it('记录时间用传进来的本地钟，不写成 UTC', () => {
    const local = '2026-10-31T20:04:54.694+08:00';
    const clips = new ClipsStore(join(root, 'clips'), 10, () => local);
    const transcripts = new TranscriptsStore(join(root, 'transcripts'), 10, () => local);
    expect(clips.add({ bytes: wav(0.2), text: '变声' }).createdAt).toBe(local);
    expect(transcripts.add({ text: '你好' }).createdAt).toBe(local);
  });

  it('目标已存在时不动旧条目', () => {
    mkdirSync(audioHome(dataDir), { recursive: true });
    writeFileSync(join(dataDir, 'lanes.json'), 'old');
    writeFileSync(audioPath(dataDir, 'lanes.json'), 'new');

    expect(migrateLayout(dataDir)).toEqual([]);
    expect(readFileSync(join(dataDir, 'lanes.json'), 'utf8')).toBe('old');
    expect(readFileSync(audioPath(dataDir, 'lanes.json'), 'utf8')).toBe('new');
  });

  it('audio/clips 改名 audio/out：目录搬过去，旧索引的绝对路径按文件名找回', () => {
    const oldDir = audioPath(dataDir, 'clips');
    mkdirSync(oldDir, { recursive: true });
    const file = '20261001-000000-aaaaaaaa.wav';
    writeFileSync(join(oldDir, file), wav(0.3));
    writeFileSync(join(oldDir, 'index.json'), JSON.stringify({
      version: 1,
      items: [{ id: 'aaaaaaaa', file, path: join(oldDir, file), text: '旧的语音', voice: 'xll', createdAt: '2026-10-01T00:00:00.000Z' }],
    }));

    expect(migrateLayout(dataDir)).toEqual([]);
    expect(existsSync(oldDir)).toBe(false);
    const store = new ClipsStore(audioPath(dataDir, 'out'));
    expect(store.count).toBe(1);
    expect(store.list()[0].text).toBe('旧的语音');
    expect(store.list()[0].path.startsWith(audioPath(dataDir, 'out'))).toBe(true);
    expect(existsSync(store.list()[0].path)).toBe(true);
  });

  it('旧三个 World 的记录一次性并进来：复制音频、改路径、旧文件不动', () => {
    mkdirSync(join(dataDir, 'stt'), { recursive: true });
    writeFileSync(join(dataDir, 'stt', 'index.json'), JSON.stringify({
      version: 1,
      items: [{ id: 't1', text: '旧的转写', source: { kind: 'file', ref: 'D:/old.wav' }, createdAt: '2026-10-01T00:00:00.000Z' }],
    }));
    mkdirSync(join(dataDir, 'tts'), { recursive: true });
    writeFileSync(join(dataDir, 'tts', '20261001-000000-aaaaaaaa.wav'), wav(0.4));
    writeFileSync(join(dataDir, 'tts', 'index.json'), JSON.stringify({
      version: 1,
      items: [{
        id: 'aaaaaaaa', file: '20261001-000000-aaaaaaaa.wav', path: join(dataDir, 'tts', '20261001-000000-aaaaaaaa.wav'),
        text: '旧的语音', voice: 'xll.wav', model: 'qwen-tts', createdAt: '2026-10-01T00:00:00.000Z',
      }],
    }));
    const transcripts = new TranscriptsStore(audioPath(dataDir, 'transcripts'));
    const clips = new ClipsStore(audioPath(dataDir, 'clips'));
    const report = importLegacyRecords(dataDir, { transcripts, clips });
    expect(report).toMatchObject({ stt: 1, tts: 1, skipped: false });

    expect(transcripts.list()[0].text).toBe('旧的转写');
    expect(clips.list()[0].text).toBe('旧的语音');
    expect(clips.list()[0].path.startsWith(audioPath(dataDir, 'clips'))).toBe(true);
    expect(existsSync(clips.list()[0].path)).toBe(true);
    expect(existsSync(join(dataDir, 'tts', '20261001-000000-aaaaaaaa.wav'))).toBe(true);

    const again = importLegacyRecords(dataDir, { transcripts, clips });
    expect(again.skipped).toBe(true);
  });
});
