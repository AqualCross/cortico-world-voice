import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { AUDIO } from '../src/definition.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'audio-')); });
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

describe('Audio World', () => {
  it('干装载不报失败：装载器会接受它', async () => {
    const report = await dryMountWorld(AUDIO, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('挂载时不投递启动事件', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    const host = new FakeHost();
    await world.start(host);
    expect(host.events).toEqual([]);
    await world.stop();
  });

  it('audio_status 如实报告：监听与播放已接入，其余还没有', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    const status = world.tools().find((t) => t.name === 'audio_status')!;
    const text = String(await status.handler({}, {} as ToolCallContext));
    expect(text).toContain('音频播放');
    expect(text).toContain('未接入：');
    // 默认引擎是免密钥的 Edge，所以「文本转语音」一装上就是已接入。
    expect(text).toContain('文本转语音');
    expect(text).not.toContain('还没有接入任何引擎');
    expect(text).toContain('监听：没有勾选的来源');
  });
  it('面板顺序：依赖、说话、听、音乐、工具；播放与记录收进说话/听的二级页', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    const panels = world.webUi?.().panels?.map((panel) => panel.id) ?? [];
    expect(panels).toEqual(['deps', 'speak', 'listen', 'music', 'tools']);
  });

  it('导入、选中参考音频与变声音色都写回配置', async () => {
    const ctx = fakeWorldContext(AUDIO, { scratchDir });
    const deep = (base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
      for (const [key, value] of Object.entries(patch)) {
        const cur = base[key];
        base[key] = value && typeof value === 'object' && !Array.isArray(value) && cur && typeof cur === 'object'
          ? deep(cur as Record<string, unknown>, value as Record<string, unknown>)
          : value;
      }
      return base;
    };
    ctx.persist = (patch) => { deep(ctx.cfg as unknown as Record<string, unknown>, patch as Record<string, unknown>); };
    const source = join(scratchDir, 'ref.wav');
    writeFileSync(source, Buffer.from('RIFF0000WAVE'));
    const voice = join(scratchDir, 'a.pth');
    writeFileSync(voice, Buffer.from('pth'));

    const world = AUDIO.create(ctx);
    (world as unknown as { gpuCache: unknown }).gpuCache = { at: Date.now(), report: { state: 'absent', gpus: [], tier: 'cpu', detail: null } };
    const invoke = world.webUi!().invoke as (panel: string, method: string, args: unknown[]) => Promise<unknown>;
    type State = {
      speak: { gptSovits: { refAudio: string; refText: string } };
      timbres: Array<{ file: string; text: string }>;
      refFile: string;
      rvcVoices: string[];
      rvcFile: string;
    };

    const imported = await invoke('speak', 'importTimbreFromPath', [source]) as State;
    expect(imported.timbres.map((item) => item.file)).toEqual(['ref.wav']);
    expect(imported.refFile).toBe('ref.wav');
    expect(imported.speak.gptSovits.refAudio).toContain('ref.wav');

    const texted = await invoke('speak', 'setTimbreText', ['ref.wav', '你好呀']) as State;
    expect(texted.speak.gptSovits.refText).toBe('你好呀');
    expect(texted.timbres[0].text).toBe('你好呀');

    const cleared = await invoke('speak', 'useTimbre', ['']) as State;
    expect(cleared.refFile).toBe('');
    expect(cleared.speak.gptSovits.refAudio).toBe('');

    const rvc = await invoke('speak', 'importRvcVoice', [voice]) as State;
    expect(rvc.rvcVoices).toEqual(['a.pth']);
    expect(rvc.rvcFile).toBe('a.pth');
  });

  it('面板写配置：按声明的键深合并，未知键与错类型都拒绝', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    const patches: unknown[] = [];
    // 用记录 persist 的上下文，替代 dry-mount 的浅合并。
    (world as unknown as { opts: { persist(patch: unknown): void } }).opts.persist = (patch) => { patches.push(patch); };

    const invoke = world.webUi!().invoke as (panel: string, method: string, args: unknown[]) => Promise<unknown>;
    const saved = await invoke('speak', 'setConfigValue', ['worlds.audio.speak.gptSovits.tier', 'gpu1']);
    expect(saved).toEqual({ ok: true, key: 'worlds.audio.speak.gptSovits.tier', value: 'gpu1' });
    expect(patches).toEqual([{ speak: { gptSovits: { tier: 'gpu1' } } }]);

    const volume = await invoke('queue', 'setConfigValue', ['worlds.audio.volume', '65']);
    expect(volume).toEqual({ ok: true, key: 'worlds.audio.volume', value: 65 });

    const balance = await invoke('queue', 'setConfigValue', ['worlds.audio.balance', '-45']);
    expect(balance).toEqual({ ok: true, key: 'worlds.audio.balance', value: -45 });

    await expect(invoke('speak', 'setConfigValue', ['worlds.audio.nope', 1])).rejects.toThrow('未知配置项');
    await expect(invoke('speak', 'setConfigValue', ['worlds.audio.volume', 500])).rejects.toThrow('不能大于');
    await expect(invoke('queue', 'setConfigValue', ['worlds.audio.balance', -500])).rejects.toThrow('不能小于');
    await expect(invoke('listen', 'setConfigValue', ['worlds.audio.stt.dashscope.itn', 'yes'])).rejects.toThrow('要布尔值');
  });

  it('说话页状态带上参考音频、变声音色与声库', async () => {
    const ctx = fakeWorldContext(AUDIO, { scratchDir });
    mkdirSync(join(ctx.dataDir, 'audio', 'timbre'), { recursive: true });
    writeFileSync(join(ctx.dataDir, 'audio', 'timbre', 'xll.zh.wav'), Buffer.from('RIFF0000WAVE'));
    writeFileSync(join(ctx.dataDir, 'audio', 'timbre', 'timbre.json'), JSON.stringify({
      items: [{ file: 'xll.zh.wav', name: 'xll.zh', text: '你听起来有点累，要不要休息一下？', addedAt: '2026-10-30T00:00:00.000Z' }],
    }));
    const world = AUDIO.create(ctx);
    // 跳过真显卡检测，测试不跑 nvidia-smi。
    (world as unknown as { gpuCache: unknown }).gpuCache = { at: Date.now(), report: { state: 'absent', gpus: [], tier: 'cpu', detail: null } };

    const invoke = world.webUi!().invoke as (panel: string, method: string, args: unknown[]) => Promise<unknown>;
    const state = await invoke('speak', 'state', []) as {
      timbres: Array<{ file: string; text: string }>;
      refFile: string;
      rvcVoices: string[];
      rvcRuntime: { ready: boolean; missing: string[]; engine: { phase: string } };
      singRuntime: { ready: boolean; missing: string[]; engine: { phase: string } };
      lastSing: unknown;
      lastConvert: unknown;
      banks: unknown[];
      gpus: unknown[];
    };
    expect(state.timbres.map((item) => item.file)).toEqual(['xll.zh.wav']);
    expect(state.timbres[0].text).toContain('休息');
    expect(state.refFile).toBe('');
    expect(Array.isArray(state.rvcVoices)).toBe(true);
    expect(Array.isArray(state.banks)).toBe(true);
    expect(state.gpus).toEqual([]);
    // 没装源码/环境时如实报缺什么，不假装能转。
    expect(state.rvcRuntime.ready).toBe(false);
    expect(state.rvcRuntime.missing).toContain('RVC 源码');
    expect(state.rvcRuntime.engine.phase).toBe('stopped');
    expect(state.lastConvert).toBeNull();
    expect(state.singRuntime.ready).toBe(false);
    expect(state.lastSing).toBeNull();
  });

  it('audio_sing：缺声库/环境时只回一句话，不起引擎', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    const sing = world.tools().find((tool) => tool.name === 'audio_sing')!;
    const text = String(await sing.handler({ lyrics: '大肥鱼呀大肥鱼' }, {} as ToolCallContext));
    expect(text).toContain('[audio_sing 没执行]');
    expect(text).toContain('DiffSinger 声库');
    expect(text).toContain('DiffSinger 环境');
  });

  it('audio_convert：没选音色、缺依赖都只回一句话，不起引擎', async () => {
    const ctx = fakeWorldContext(AUDIO, { scratchDir });
    const source = join(scratchDir, 'clip.wav');
    writeFileSync(source, Buffer.from('RIFF0000WAVE'));
    const world = AUDIO.create(ctx);
    const convert = world.tools().find((tool) => tool.name === 'audio_convert')!;

    const noVoice = String(await convert.handler({ path: source }, {} as ToolCallContext));
    expect(noVoice).toContain('[audio_convert 没执行]');
    expect(noVoice).toContain('变声音色');

    // 选了音色但运行时会缺：说清缺哪一项，不动子进程。
    mkdirSync(join(ctx.dataDir, 'audio', 'rvc'), { recursive: true });
    writeFileSync(join(ctx.dataDir, 'audio', 'rvc', 'a.pth'), Buffer.from('pth'));
    (ctx.cfg as { convert: { model: string } }).convert.model = join(ctx.dataDir, 'audio', 'rvc', 'a.pth');
    const missing = String(await convert.handler({ path: source }, {} as ToolCallContext));
    expect(missing).toContain('还缺：');
    expect(missing).toContain('RVC 源码');
  });

  it('六个页签的读取方法都回得出状态', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    (world as unknown as { gpuCache: unknown }).gpuCache = { at: Date.now(), report: { state: 'absent', gpus: [], tier: 'cpu', detail: null } };
    const invoke = world.webUi!().invoke as (panel: string, method: string, args: unknown[]) => Promise<unknown>;

    const deps = await invoke('deps', 'state', []) as {
      vad: { silero: { phase: string }; firered: { phase: string } };
      env: { gpt: { phase: string }; rvc: { phase: string } };
      stt: { sensevoice: { phase: string }; paraformer: { phase: string } };
    };
    for (const phase of [deps.vad.silero.phase, deps.vad.firered.phase,
      deps.env.gpt.phase, deps.env.rvc.phase, deps.stt.sensevoice.phase, deps.stt.paraformer.phase]) {
      expect(phase).toBeDefined();
    }

    for (const [panel, method] of [['speak', 'state'], ['listen', 'state'], ['queue', 'list'], ['records', 'state'], ['tools', 'list']] as const) {
      const value = await invoke(panel, method, []);
      expect(value).not.toBeUndefined();
    }
    // 二级页签：播放走 speak/queue，语音记录走 speak/clips，转写记录走 listen/transcripts。
    expect(await invoke('speak', 'queue', ['list'])).not.toBeUndefined();
    expect(await invoke('speak', 'clips', ['state'])).not.toBeUndefined();
    expect(await invoke('listen', 'transcripts', ['state'])).not.toBeUndefined();
  });

  it('听到的一句写进转写记录，不再落音频文件', async () => {
    const ctx = fakeWorldContext(AUDIO, { scratchDir });
    const world = AUDIO.create(ctx);
    const host = new FakeHost();
    await world.start(host);
    await (world as unknown as {
      shipHeard(chunk: unknown, text: string, info: { transcribeError: string }): Promise<void>;
    }).shipHeard(
      { at: '2026-10-31T20:00:00.000+08:00', startedAt: '2026-10-31T11:59:58.000Z', durationMs: 1200, source: 'system', app: '', target: '系统声音', forced: false, peakDb: -20 },
      '你好呀',
      { transcribeError: '' },
    );
    const invoke = world.webUi!().invoke as (panel: string, method: string, args: unknown[]) => Promise<unknown>;
    const state = await invoke('records', 'state', []) as {
      transcripts: { items: Array<{ text: string; source: { kind: string; ref: string } }> };
      clips: { count: number };
    };
    expect(state.transcripts.items[0]).toMatchObject({ text: '你好呀', source: { kind: 'live', ref: '系统声音' } });
    expect('listen' in state).toBe(false);
    // 不建块目录、不写 WAV：整套数据里只有转写的 index.json。
    expect(existsSync(join(ctx.dataDir, 'audio', 'listen'))).toBe(false);
    expect(host.events.map((event) => event.type)).toContain('audio.heard');
    await world.stop();
  });

  it('通知 Coo 时 audio.heard 带 debounce 触发；只归档时不投递', async () => {
    const ctx = fakeWorldContext(AUDIO, { scratchDir });
    const listen = (ctx.cfg as unknown as { listen: { deliver: string } }).listen;
    const world = AUDIO.create(ctx);
    const host = new FakeHost();
    (world as unknown as { host: FakeHost }).host = host;
    const ship = (text: string): Promise<void> => (world as unknown as {
      shipHeard(chunk: unknown, text: string, info: { transcribeError: string }): Promise<void>;
    }).shipHeard(
      { at: '2026-10-31T20:00:00.000+08:00', startedAt: '2026-10-31T11:59:58.000Z', durationMs: 1200, source: 'system', app: '', target: '系统声音', forced: false, peakDb: -20 },
      text,
      { transcribeError: '' },
    );

    listen.deliver = 'notify';
    await ship('第一句');
    expect(host.events.filter((event) => event.type === 'audio.heard')).toHaveLength(1);
    // 每块一条事件，合批与唤醒节奏交给内核 WakeBus。
    expect(host.pushOpts[host.events.length - 1]).toMatchObject({ deliver: true, trigger: 'debounce' });

    listen.deliver = 'record';
    await ship('第二句');
    expect(host.pushOpts[host.events.length - 1]).toEqual({ deliver: false });
    (world as unknown as { host: unknown }).host = null;
  });

  it('导航状态灯：四项能力各一盏，没有车在听时不显示徽章', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    const ui = world.webUi!() as unknown as {
      lamps?: Array<{ label: string; state: string; hint?: string }>;
      badges?: Array<{ label: string; value: number; tone: string }>;
    };
    expect(ui.lamps?.map((lamp) => lamp.label)).toEqual(['听', '说话', '变声', '唱歌']);
    // 默认的 Edge 引擎免密钥、免安装，说话一装上就是 online；其余三项没配好就如实 offline。
    const lampOf = (label: string): { state: string; hint?: string } | undefined => ui.lamps?.find((lamp) => lamp.label === label);
    expect(lampOf('说话')).toMatchObject({ state: 'online', hint: 'Edge 在线音色' });
    for (const label of ['听', '变声', '唱歌']) expect(lampOf(label)?.state).not.toBe('online');
    expect(lampOf('变声')?.hint).toContain('还缺');
    expect(ui.badges).toEqual([]);
    const en = world.webUi!('en') as unknown as { lamps?: Array<{ label: string }> };
    expect(en.lamps?.map((lamp) => lamp.label)).toEqual(['Listen', 'Speech', 'Convert', 'Sing']);
  });

  it('记录页：两栏回快照，清空只清自己栏，转写不能试听', async () => {
    const ctx = fakeWorldContext(AUDIO, { scratchDir });
    const dir = join(ctx.dataDir, 'audio', 'transcripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.json'), JSON.stringify({
      items: [{ id: 't1', text: '你好', createdAt: '2026-10-31T07:00:00.000Z' }],
    }));
    const world = AUDIO.create(ctx);
    const invoke = world.webUi!().invoke as (panel: string, method: string, args: unknown[]) => Promise<unknown>;
    type State = { transcripts: { count: number }; clips: { count: number } };

    const state = await invoke('listen', 'transcripts', ['state']) as State;
    expect(state.transcripts.count).toBe(1);
    expect(state.clips.count).toBe(0);

    await expect(invoke('listen', 'transcripts', ['play', 't1'])).rejects.toThrow('不能试听');

    const cleared = await invoke('listen', 'transcripts', ['clear']) as State;
    expect(cleared.transcripts.count).toBe(0);
  });

  it('挂载时把旧布局搬进 audio/，并把旧 World 的记录并进来', async () => {
    const ctx = fakeWorldContext(AUDIO, { scratchDir });
    mkdirSync(join(ctx.dataDir, 'uv'), { recursive: true });
    writeFileSync(join(ctx.dataDir, 'uv', 'uv.exe'), 'uv');
    mkdirSync(join(ctx.dataDir, 'stt'), { recursive: true });
    writeFileSync(join(ctx.dataDir, 'stt', 'index.json'), JSON.stringify({
      items: [{ id: 't1', text: '旧的转写', createdAt: '2026-10-01T00:00:00.000Z' }],
    }));

    const world = AUDIO.create(ctx);
    const host = new FakeHost();
    await world.start(host);
    expect(existsSync(join(ctx.dataDir, 'uv'))).toBe(false);
    expect(existsSync(join(ctx.dataDir, 'audio', 'uv', 'uv.exe'))).toBe(true);

    const invoke = world.webUi!().invoke as (panel: string, method: string, args: unknown[]) => Promise<unknown>;
    const state = await invoke('records', 'state', []) as { transcripts: { count: number } };
    expect(state.transcripts.count).toBe(1);
    await world.stop();
  });

  it('audio_play 把左右平衡带进队列并掐到 -100…100', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    // 播放挂起，队列停在当前条目上，方便看它拿到的平衡值。
    (world as unknown as { playAny: () => Promise<void> }).playAny = () => new Promise<void>(() => {});
    const file = join(scratchDir, 'pan.wav');
    writeFileSync(file, Buffer.from('RIFF0000WAVE'));
    const play = world.tools().find((tool) => tool.name === 'audio_play')!;
    await play.handler({ path: file, balance: 140 }, {} as ToolCallContext);
    const snap = (world as unknown as { queue: { snapshot(): { current: { balance: number } | null } } }).queue.snapshot();
    expect(snap.current?.balance).toBe(100);
  });

  it('audio_say 把左右平衡记到这一句上并掐到范围内', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    // 占住播放，让这一句留在队列当前条目上，不真的去合成/播放。
    (world as unknown as { playSpeech: () => Promise<number | null> }).playSpeech = () => new Promise<number | null>(() => {});
    const say = world.tools().find((tool) => tool.name === 'audio_say')!;
    await say.handler({ text: '你好', balance: -180 }, {} as ToolCallContext);
    const snap = (world as unknown as { queue: { snapshot(): { current: { balance: number; text: string } | null } } }).queue.snapshot();
    expect(snap.current?.balance).toBe(-100);
    expect(snap.current?.text).toBe('你好');
  });

  it('audio_say 立刻回执，不等合成', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    (world as unknown as { playSpeech: () => Promise<number | null> }).playSpeech = () => new Promise<number | null>(() => {});
    const say = world.tools().find((tool) => tool.name === 'audio_say')!;
    const text = String(await say.handler({ text: '你好' }, {} as ToolCallContext));
    expect(text).toContain('待说队列');
    expect(text).toContain('不用等它');
  });

  it('audio_say 的 silent 也立刻回执，失败以事件带回', async () => {
    // 默认 Edge 会真的联网；这里换成没填密钥的 DashScope，让失败路径确定地发生。
    const ctx = fakeWorldContext(AUDIO, { scratchDir });
    ctx.cfg.speak = { ...ctx.cfg.speak, engine: 'dashscope' };
    const world = AUDIO.create(ctx);
    const host = new FakeHost();
    (world as unknown as { host: FakeHost }).host = host;
    const say = world.tools().find((tool) => tool.name === 'audio_say')!;
    const text = String(await say.handler({ text: '你好', silent: true }, {} as ToolCallContext));
    expect(text).toContain('后台开始合成');
    expect(text).toContain('audio.say_done');
    // 引擎没有密钥：这一句合成失败，错误等后台推成事件。
    for (let i = 0; i < 100 && !host.events.some((event) => event.type === 'audio.failed'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const failure = host.events.find((event) => event.type === 'audio.failed');
    expect(failure).toMatchObject({ origin: 'external' });
    expect(failure?.text).toContain('audio_say（say1）没说出来：');
    (world as unknown as { host: unknown }).host = null;
  });

  it('audio_transcribe 立刻回执，文字等事件带回', async () => {
    const ctx = fakeWorldContext(AUDIO, { scratchDir });
    // defaults 是浅拷贝，嵌套段要复制一份，别让改动漏到后面的用例。
    ctx.cfg.stt = { ...ctx.cfg.stt, engine: 'openai' };
    ctx.secret = (name: string) => (name === ctx.cfg.stt.openai.apiKeySecret ? 'test-key' : '');
    const world = AUDIO.create(ctx);
    const file = join(scratchDir, 'b.wav');
    writeFileSync(file, Buffer.from('RIFF0000WAVE'));
    const transcribe = world.tools().find((tool) => tool.name === 'audio_transcribe')!;
    const text = String(await transcribe.handler({ path: file }, {} as ToolCallContext));
    expect(text).toContain('已开始转写');
    expect(text).toContain('audio.transcribed');
  });

  it('audio_transcribe 在本机识别没装好时指向依赖页', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    const file = join(scratchDir, 'a.wav');
    writeFileSync(file, Buffer.from('RIFF0000WAVE'));
    const transcribe = world.tools().find((tool) => tool.name === 'audio_transcribe')!;
    const text = String(await transcribe.handler({ path: file }, {} as ToolCallContext));
    expect(text).toContain('本机识别还没装好');
  });

  it('重新获取 GPT-SoVITS 先停本机服务，再动项目目录', async () => {
    const world = AUDIO.create(fakeWorldContext(AUDIO, { scratchDir }));
    const order: string[] = [];
    const inner = world as unknown as {
      sovits: { stop(): Promise<void> } | null;
      project: { install(): Promise<void>; status(): { phase: string } };
      gpuCache: unknown;
      prepareGpt(): Promise<void>;
    };
    inner.sovits = { stop: async () => { order.push('停服务'); } };
    // 任务换成立刻失败的壳：只验证顺序，不真的去下载。
    inner.project = { install: async () => { order.push('装项目'); }, status: () => ({ phase: 'absent' }) };
    inner.gpuCache = { at: Date.now(), report: { state: 'absent', gpus: [], tier: 'cpu', detail: null } };
    await inner.prepareGpt();
    expect(order).toEqual(['停服务', '装项目']);
  });
});
