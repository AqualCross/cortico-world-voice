import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolTextStore, toolTextFields } from '../src/tool-text.ts';

const DECLS = [{
  name: 'audio_play',
  description: 'Play a file.',
  tags: ['act'] as const,
  parameters: {
    type: 'object' as const,
    additionalProperties: false,
    properties: { path: { type: 'string', description: 'Path to the file.' } },
    required: ['path'],
  },
}];

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'audio-tooltext-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const store = (defaultDisabledTools: string[] = []): ToolTextStore => new ToolTextStore(DECLS, {
  botDir: join(root, 'bot'), packageDir: join(root, 'pkg'), id: 'audio', defaultDisabledTools,
});

describe('工具说明覆盖', () => {
  it('把工具描述与参数说明都变成可编辑字段', () => {
    const fields = toolTextFields(DECLS[0]);
    expect(fields.map((f) => f.path)).toEqual([
      '/description',
      '/parameters/description',
      '/parameters/properties/path/description',
    ]);
  });

  it('保存覆盖后 resolve() 用新文字，reset 恢复默认', () => {
    const s = store();
    const first = s.read();
    const saved = s.save({
      expectedRevision: first.revision,
      overrides: { audio_play: { '/description': '播一个文件。', '/parameters/properties/path/description': '文件路径。' } },
    });
    expect(saved.overrides.audio_play['/description']).toBe('播一个文件。');
    expect(s.resolve()[0].description).toBe('播一个文件。');
    expect(existsSync(join(root, 'bot', 'worlds', 'audio', 'tool-text.json'))).toBe(true);
    s.reset({ expectedRevision: saved.revision });
    expect(s.resolve()[0].description).toBe('Play a file.');
  });

  it('拒绝过期版本与不存在的字段', () => {
    const s = store();
    expect(() => s.save({ expectedRevision: 'stale', overrides: { audio_play: { '/description': 'x' } } })).toThrow('刷新');
    expect(() => s.save({ expectedRevision: s.read().revision, overrides: { audio_play: { '/nope': 'x' } } })).toThrow('Unknown tool text field');
  });

  it('单独保存工具开关，重建 Store 后仍隐藏，恢复默认后重新开放', () => {
    const s = store();
    const saved = s.save({ expectedRevision: s.read().revision, overrides: {}, disabledTools: ['audio_play'] });
    expect(saved.tools[0].enabled).toBe(false);
    expect(saved.tools[0].fields).not.toHaveLength(0);
    expect(store().resolve()).toEqual([]);
    expect(() => s.save({ expectedRevision: saved.revision, overrides: {}, disabledTools: ['no_such_tool'] })).toThrow('Unknown tool');
    expect(() => s.save({ expectedRevision: saved.revision, overrides: {}, disabledTools: 'audio_play' })).toThrow('array');
    const reset = s.reset({ expectedRevision: saved.revision });
    expect(reset.disabledTools).toEqual([]);
    expect(store().resolve().map((tool) => tool.name)).toEqual(['audio_play']);
  });

  it('开关与文字一起保存，旧调用方只保存文字时保留开关，再开放时保留文字', () => {
    const s = store();
    const initial = s.read();
    const saved = s.save({
      expectedRevision: initial.revision,
      overrides: { audio_play: { '/description': '播一个文件。' } },
      disabledTools: ['audio_play'],
    });
    const textOnly = s.save({ expectedRevision: saved.revision, overrides: saved.overrides });
    expect(textOnly.disabledTools).toEqual(['audio_play']);
    expect(() => s.save({ expectedRevision: initial.revision, overrides: {}, disabledTools: [] })).toThrow('刷新');
    s.save({ expectedRevision: textOnly.revision, overrides: textOnly.overrides, disabledTools: [] });
    expect(s.resolve()[0].description).toBe('播一个文件。');
    expect(s.resolve()[0]).not.toHaveProperty('enabled');
    expect(s.resolve()[0]).not.toHaveProperty('fields');
  });

  it('兼容旧说明文件；部署设置损坏时不重新暴露工具', () => {
    const path = join(root, 'bot', 'worlds', 'audio');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'tool-text.json'), JSON.stringify({ version: 1, tools: { audio_play: { '/description': '旧说明' } } }));
    const s = store();
    expect(s.resolve()[0].description).toBe('旧说明');
    writeFileSync(join(path, 'tool-text.json'), '{ broken');
    expect(s.resolve()).toEqual([]);
    const broken = s.read();
    expect(broken.warnings[0].layer).toBe('deployment');
    expect(() => s.save({ expectedRevision: broken.revision, overrides: {}, disabledTools: [] })).toThrow('恢复默认');
    s.reset({ expectedRevision: broken.revision });
    expect(s.resolve()).toHaveLength(1);
  });

  it('默认关闭可被用户显式开启并跨重启保留，恢复默认后再次关闭', () => {
    const s = store(['audio_play']);
    expect(s.resolve()).toEqual([]);
    expect(s.read().tools[0].enabled).toBe(false);
    const saved = s.save({ expectedRevision: s.read().revision, overrides: {}, disabledTools: [] });
    expect(store(['audio_play']).resolve().map((tool) => tool.name)).toEqual(['audio_play']);
    const restored = s.reset({ expectedRevision: saved.revision });
    expect(restored.disabledTools).toEqual(['audio_play']);
    expect(s.resolve()).toEqual([]);

    // 旧版只改过说明，没有开关覆盖时，也采用新的默认开关。
    const path = join(root, 'bot', 'worlds', 'audio');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'tool-text.json'), JSON.stringify({ version: 1, tools: { audio_play: { '/description': '旧说明' } } }));
    expect(s.read().tools[0].fields[0].text).toBe('旧说明');
    expect(s.resolve()).toEqual([]);
  });
});
