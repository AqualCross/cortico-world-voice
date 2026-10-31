import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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

const store = (): ToolTextStore => new ToolTextStore(DECLS, { botDir: join(root, 'bot'), packageDir: join(root, 'pkg'), id: 'audio' });

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
});
