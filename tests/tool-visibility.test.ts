import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { AUDIO } from '../src/definition.ts';
import type { ToolTextView } from '../src/tool-text.ts';

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'audio-visibility-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

describe('模型工具开关', () => {
  it('关闭后从 tools() 移除，保留面板条目，其他工具的 handler 不串位', async () => {
    const ctx = fakeWorldContext(AUDIO, { scratchDir, packageDir: join(scratchDir, 'pkg') });
    const world = AUDIO.create(ctx);
    const invoke = world.webUi!().invoke!;
    const initial = await invoke('tools', 'list', []) as ToolTextView;
    const names = world.tools().map((tool) => tool.name);
    expect(initial.tools.find((tool) => tool.name === 'audio_listen')?.enabled).toBe(false);
    expect(names).not.toContain('audio_listen');
    const enabled = await invoke('tools', 'save', [{ expectedRevision: initial.revision, overrides: {}, disabledTools: [] }]) as ToolTextView;
    expect(AUDIO.create(ctx).tools().map((tool) => tool.name)).toContain('audio_listen');
    // 关闭前两项及监听，确保被过滤的前项不会导致其后 handler 错配。
    const disabledTools = ['audio_status', 'audio_play', 'audio_listen'];
    const saved = await invoke('tools', 'save', [{ expectedRevision: enabled.revision, overrides: {}, disabledTools }]) as ToolTextView;
    expect(world.tools().map((tool) => tool.name)).toEqual(names.filter((name) => !disabledTools.includes(name)));
    expect(saved.tools.find((tool) => tool.name === 'audio_listen')?.enabled).toBe(false);
    const queue = world.tools().find((tool) => tool.name === 'audio_queue')!;
    expect(await queue.handler({ act: 'list' }, {} as ToolCallContext)).toContain('正在播放：');
    expect(AUDIO.create(ctx).tools().map((tool) => tool.name)).not.toContain('audio_listen');
    const restored = await invoke('tools', 'reset', [{ expectedRevision: saved.revision }]) as ToolTextView;
    expect(restored.tools.filter((tool) => !tool.enabled).map((tool) => tool.name)).toEqual(['audio_listen']);
    expect(world.tools().map((tool) => tool.name)).toEqual(names);
  });
});
