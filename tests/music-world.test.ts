import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { AUDIO } from '../src/definition.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { testBank } from './music-abc/fixture.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'music-world-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('声音 World 的音乐集成', () => {
  it('ABC 工具、音源、乐谱和 WAV 作品在 audio 下工作，事件按 external 交付', async () => {
    const ctx = fakeWorldContext(AUDIO, { scratchDir: dir });
    ctx.cfg.music = structuredClone(ctx.cfg.music);
    const patches: unknown[] = []; ctx.persist = (patch) => { patches.push(patch); };
    const world = AUDIO.create(ctx), host = new FakeHost();
    await world.start(host);
    try {
      const invoke = world.webUi!().invoke!;
      const bank = join(dir, 'bank.sf2'); testBank(bank);
      await invoke('music', 'abc', ['instruments', 'import', [bank]]);
      const fonts = await invoke('music', 'abc', ['instruments', 'list', []]) as { items: Array<{ id: string }> };
      await invoke('music', 'abc', ['instruments', 'select', [fonts.items[0].id]]);
      expect(patches).toContainEqual({ music: { abc: { instrument: fonts.items[0].id } } });
      const call = {} as ToolCallContext;
      const tools = world.tools();
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['audio_separate', 'audio_mix', 'audio_abc_music_score', 'audio_abc_music_play', 'audio_abc_music_control']));
      const abc = 'X:1\nT:Integrated score\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nC D E F |]';
      await tools.find((tool) => tool.name === 'audio_abc_music_score')!.handler({ action: 'save', abc }, call);
      const scores = await invoke('music', 'abc', ['scores', 'list', []]) as { items: Array<{ id: string }> };
      const result = await tools.find((tool) => tool.name === 'audio_abc_music_play')!.handler({ score: scores.items[0].id, delivery: 'event' }, call) as { text: string; failed?: boolean };
      expect(result.failed, result.text).not.toBe(true);
      expect(host.events).toHaveLength(1);
      expect(host.events[0]).toMatchObject({ type: 'audio.abc_played', origin: 'external', source: 'audio' });
      expect(host.events[0].blobs?.[0].mime).toBe('audio/wav');
      expect(existsSync(join(ctx.dataDir, 'audio', 'music', 'abc', 'index.json'))).toBe(true);
      expect(existsSync(join(ctx.dataDir, 'music-abc'))).toBe(false);
    } finally { await world.stop(); }
  });
});
