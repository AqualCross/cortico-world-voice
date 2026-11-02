// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createWebUi } from 'cortico/web/client/ui/index.ts';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import client from '../src/webui/client.ts';

const state = {
  gpu: { state: 'ok', gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 3080', vramMB: 10240, driver: '566.36' }], tier: 'cuda', detail: null },
  tier: 'cuda',
  uv: { path: 'C:/Users/x/.local/bin/uv.exe', version: '0.8.15', source: 'known', detail: null },
  uvJob: { phase: 'absent', done: 0, total: 0, detail: null },
  ffmpeg: { path: 'C:/tools/ffmpeg/bin/ffmpeg.exe', version: '7.1-full_build', source: 'known', detail: null },
  ffmpegJob: { phase: 'absent', done: 0, total: 0, detail: null },
  project: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/runtimes/audio/gpt-sovits/e91506f1f' },
  weights: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/models/audio/gpt-sovits', bytes: 1584257 },
  rvc: {
    project: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/runtimes/audio/rvc/81eed5e8f' },
    assets: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/models/audio/rvc', bytes: 370391200 },
  },
  singer: { models: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/models/audio/singer' } },
  demucs: {
    source: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/runtimes/audio/demucs-onnx/source/0.3.4' },
    environment: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/runtimes/audio/demucs-onnx' },
    weights: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/models/audio/demucs-onnx' },
  },
  env: {
    gpt: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/runtimes/audio/gpt-sovits/e91506f1f' },
    rvc: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/runtimes/audio/rvc/81eed5e8f' },
    stt: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/runtimes/audio/stt-sensevoice' },
    sing: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/runtimes/audio/singer' },
  },
  vad: {
    silero: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/models/audio/vad' },
    firered: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/models/audio/vad/firered', bytes: 2307353 },
  },
  stt: {
    sensevoice: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/models/audio/stt/sensevoice', bytes: 239549735 },
    paraformer: { phase: 'absent', done: 0, total: 0, detail: null, dir: 'D:/home/models/audio/stt/paraformer', bytes: 237202501 },
  },
  installed: {
    uv: false, ffmpeg: false, gpt: false, rvc: false, singer: false,
    demucs: false, silero: false, firered: false, sensevoice: false, paraformer: false,
  },
};

describe('依赖页', () => {
  it('各项依赖逐行显示状态', async () => {
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: async () => state,
      interval: () => ({ dispose: () => {} }),
    } as unknown as WebUiPanelContext;

    await client.panels.deps.mount(ctx);
    const text = root.textContent ?? '';
    expect(text).toContain('显卡');
    expect(text).toContain('GeForce RTX 3080');
    expect(text).toContain('uv');
    expect(text).toContain('0.8.15');
    expect(text).toContain('ffmpeg');
    expect(text).toContain('7.1-full_build');
    expect(text).toContain('GPT-SoVITS');
    expect(text).toContain('RVC');
    expect(text).toContain('DiffSinger');
    expect(text).toContain('Demucs 分离');
    expect(text).toContain('Silero VAD');
    expect(text).toContain('FireRed VAD');
    expect(text).toContain('SenseVoice');
    expect(text).toContain('Paraformer 流式');
    expect(text).not.toContain('源码 无');
  });

  it('已装时源码只写状态，不写 commit 哈希', async () => {
    const ready = structuredClone(state) as any;
    ready.project = { ...ready.project, phase: 'ready' };
    ready.rvc.project = { ...ready.rvc.project, phase: 'ready' };
    ready.vad.firered = { ...ready.vad.firered, phase: 'ready' };
    for (const key of ['source', 'environment', 'weights']) ready.demucs[key].phase = 'ready';
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: async () => ready,
      interval: () => ({ dispose: () => {} }),
    } as unknown as WebUiPanelContext;

    await client.panels.deps.mount(ctx);
    const text = root.textContent ?? '';
    expect(text).toContain('源码 已装');
    expect(text).toContain('源码 已装 · 环境 已装 · 权重 已装');
    expect(text).not.toContain('e91506f1f');
    expect(text).not.toContain('c30ec49e8');
  });

  it('在跑的任务给阶段和已下载量，有总量的给百分比', async () => {
    const working = structuredClone(state) as any;
    working.project = { ...working.project, phase: 'working', done: 12 * 1024 * 1024, total: 0, detail: '下载源码' };
    working.weights = { ...working.weights, phase: 'working', done: 50, total: 200, detail: 's2Gv5turbo.pth' };
    working.demucs.source.phase = 'ready';
    working.demucs.environment = { ...working.demucs.environment, phase: 'working', detail: '安装中' };
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: async () => working,
      interval: () => ({ dispose: () => {} }),
    } as unknown as WebUiPanelContext;
    await client.panels.deps.mount(ctx);
    const text = root.textContent ?? '';
    expect(text).toContain('下载源码');
    expect(text).toContain('12.0 MB');
    expect(text).toContain('25%');
    expect(text).toContain('源码 已装 · 环境 安装中');
    expect(text).not.toContain('装 torch');
  });

  it('检测没回来之前只显示「识别中」，按钮先不出现', async () => {
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    let release: (value: unknown) => void = () => {};
    const pendingState = new Promise((resolve) => { release = resolve; });
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: () => pendingState,
      interval: () => ({ dispose: () => {} }),
    } as unknown as WebUiPanelContext;

    const mounting = client.panels.deps.mount(ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.textContent).toContain('识别中');
    const shown = Array.from(root.querySelectorAll('button'))
      .filter((button) => !(button as HTMLButtonElement).hidden && button.textContent === '获取');
    expect(shown.length).toBe(0);

    release(state);
    await mounting;
    expect(root.textContent).toContain('0.8.15');
  });

  it('没有信息的行里，「获取」的字形和上面的值同一条左边缘', async () => {
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: async () => state,
      interval: () => ({ dispose: () => {} }),
    } as unknown as WebUiPanelContext;
    await client.panels.deps.mount(ctx);

    const rowOf = (name: string): HTMLElement =>
      Array.from(root.querySelectorAll('.dep-row')).find((row) => row.querySelector('.dep-name')?.textContent === name) as HTMLElement;
    // 没装的行：值区整个藏起来（flex 的 12px 间距随之消失），按钮盒子左移 12px（11px padding + 1px 边框）。
    const gptValue = rowOf('GPT-SoVITS').querySelector('.dep-value') as HTMLElement;
    expect(gptValue.hidden).toBe(true);
    expect((rowOf('GPT-SoVITS').querySelector('.dep-acts') as HTMLElement).style.marginLeft).toBe('-12px');
    // 已装的行：有文字，按钮不存在，不位移。
    expect((rowOf('uv').querySelector('.dep-value') as HTMLElement).hidden).toBe(false);
    expect((rowOf('uv').querySelector('.dep-acts') as HTMLElement).style.marginLeft).toBe('');
  });

  it('失败原因只留一句，长原文进「复制错误信息」', async () => {
    const failed = structuredClone(state) as any;
    failed.weights = {
      ...failed.weights,
      phase: 'error',
      detail: 'HTTP 403 https://example.invalid/very/long/path/to/a/weight/file/that/keeps/going.bin?token=abc',
    };
    const written: string[] = [];
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text); } },
    });
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: async () => failed,
      interval: () => ({ dispose: () => {} }),
    } as unknown as WebUiPanelContext;
    await client.panels.deps.mount(ctx);

    const row = Array.from(root.querySelectorAll('.dep-row'))
      .find((item) => item.querySelector('.dep-name')?.textContent === 'GPT-SoVITS') as HTMLElement;
    const line = row.querySelector('.dep-err-text') as HTMLElement;
    expect(line.textContent).toContain('权重：HTTP 403');
    expect(line.textContent!.endsWith('…')).toBe(true);
    expect(root.textContent).not.toContain('token=abc');

    const copy = Array.from(row.querySelectorAll('button'))
      .find((button) => button.textContent === '复制错误信息') as HTMLButtonElement;
    expect(copy.hidden).toBe(false);
    copy.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written).toEqual([`权重：${failed.weights.detail}`]);
  });

  it('装过的行才给「卸载」，确认后才调用；系统里的 uv 不给', async () => {
    const installed = structuredClone(state);
    installed.installed.gpt = true;
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    ui.confirm = vi.fn(async () => true);
    const invoke = vi.fn(async () => installed);
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke,
      interval: () => ({ dispose: () => {} }),
    } as unknown as WebUiPanelContext;
    await client.panels.deps.mount(ctx);

    const rowOf = (name: string): HTMLElement =>
      Array.from(root.querySelectorAll('.dep-row')).find((row) => row.querySelector('.dep-name')?.textContent === name) as HTMLElement;
    const uninstallOf = (name: string): HTMLButtonElement =>
      Array.from(rowOf(name).querySelectorAll('button')).find((button) => button.textContent === '卸载') as HTMLButtonElement;

    expect(uninstallOf('GPT-SoVITS').hidden).toBe(false);
    expect(uninstallOf('uv').hidden).toBe(true);
    uninstallOf('GPT-SoVITS').click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('uninstall', ['gpt']));
    expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: '卸载 GPT-SoVITS？',
      body: expect.stringContaining('Python 环境'),
      danger: true,
    }));
  });
});

describe('说话页', () => {
  const speakState = {
    speak: {
      engine: 'gpt-sovits', textLang: 'auto',
      gptSovits: { tier: 'auto', refAudio: '', refText: '', speed: 1 },
      dashscope: { baseUrl: 'https://maas.qianwenaiapi.com', model: 'qwen-audio-3.1-tts-flash', voice: 'longanhuan_v3.1', apiKeySecret: 'AUDIO_API_KEY', format: 'wav', sampleRate: 24000, instruction: '', languageHints: '', seed: -1 },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy', apiKeySecret: 'OPENAI_API_KEY', format: 'wav', sampleRate: 0, languageHints: '' },
    },
    convert: { engine: 'rvc', model: '', pitch: 0, indexRate: 0.3, protect: 0.33 },
    timbres: [],
    refFile: '',
    rvcVoices: ['a.pth'],
    rvcFile: 'a.pth',
    rvcRuntime: { ready: true, voice: 'a.pth', missing: [], engine: { phase: 'stopped', device: null, model: null, detail: null } },
    lastConvert: null,
    banks: [],
    sing: { engine: 'diffsinger', voicebank: '', color: '', bpm: 96, keyShift: 0, scale: 'major', seed: 0, convert: false },
    singRuntime: { ready: true, bank: '', missing: [], engine: { phase: 'stopped', voicebank: null, sampleRate: null, speakers: [], detail: null } },
    lastSing: null,
    gpus: [
      { index: 0, name: 'NVIDIA GeForce RTX 3080', vramMB: 10240 },
      { index: 1, name: 'NVIDIA GeForce RTX 4090', vramMB: 24576 },
    ],
    secrets: { dashscope: false, openai: true },
  };

  async function mount() {
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    const calls: string[] = [];
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: async (method: string, args?: unknown[]) => {
        // 播放 / 记录子面板挂在说话页下，各给一份空快照。
        if (method === 'queue') {
          const act = String(args?.[0] ?? '');
          if (act === 'subtitle') return { enabled: true, size: 34, color: '#FFFFFF', vertical: 'bottom', align: 'center' };
          return { current: null, pending: [], counts: { current: 0, pending: 0 }, volume: 80, lastError: null };
        }
        if (method === 'clips') return { transcripts: { count: 0, items: [] }, clips: { count: 0, items: [] } };
        calls.push(String(method) + (args ? ':' + String(args[0]) : ''));
        return speakState;
      },
      interval: () => ({ dispose: () => {} }),
      pickPath: async () => null,
      memo: { get: (_k: string, fallback: unknown) => fallback, set: () => {} },
    } as unknown as WebUiPanelContext;
    await client.panels.speak.mount(ctx);
    // 页签跨挂载保留；测试统一从「说话」页开始。
    await openTab(root, '说话');
    return { root, calls };
  }

  const openTab = async (root: HTMLElement, label: string): Promise<void> => {
    const tab = Array.from(root.querySelectorAll('.aud-tab'))
      .find((node) => node.textContent === label) as HTMLButtonElement | undefined;
    if (!tab) throw new Error(`没有这个页签：${label}`);
    if (tab.getAttribute('aria-selected') === 'true') return;
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  /** 当前页签里看得到的内容。 */
  const paneText = (root: HTMLElement): string => Array.from(root.querySelectorAll<HTMLElement>('[role="tabpanel"]'))
    .filter((pane) => !pane.hidden)
    .map((pane) => pane.textContent ?? '')
    .join('\n');

  it('二级页签：说话 / 变声 / 唱歌，默认 gpt-sovits 显示本地那组字段', async () => {
    const { root } = await mount();
    const tabs = Array.from(root.querySelectorAll('.aud-tab')).map((node) => node.textContent);
    expect(tabs).toEqual(['说话', '变声', '唱歌', '播放', '记录']);
    const text = paneText(root);
    expect(text).toContain('参考音频');
    expect(text).not.toContain('接口地址');
    expect(text).not.toContain('变调');
    expect(text).not.toContain('声库');
    // 推理档只暴露 自动 / CPU / 每张显卡，不提模型版本。
    const tier = Array.from(root.querySelectorAll('select'))
      .find((s) => Array.from((s as HTMLSelectElement).options).some((o) => o.value === 'gpu0')) as HTMLSelectElement;
    expect(Array.from(tier.options).map((o) => o.value)).toEqual(['auto', 'cpu', 'gpu0', 'gpu1']);
    expect(root.textContent).not.toContain('V5');
    expect(root.textContent).not.toContain('v2Pro');
  });

  it('切到变声、唱歌才显示各自字段', async () => {
    const { root } = await mount();
    expect(paneText(root)).not.toContain('变调');
    await openTab(root, '变声');
    expect(paneText(root)).toContain('变调');
    expect(paneText(root)).not.toContain('参考音频');
    await openTab(root, '唱歌');
    expect(paneText(root)).toContain('声库');
    expect(paneText(root)).not.toContain('变调');
    await openTab(root, '播放');
    expect(paneText(root)).toContain('默认音量');
    await openTab(root, '记录');
    expect(paneText(root)).toContain('还没有合成语音。');
  });

  it('变声页：选好音频点「转换」带上路径；没选音频只提示不起转换', async () => {
    const { root, calls } = await mount();
    await openTab(root, '变声');
    const text = paneText(root);
    expect(text).toContain('音频文件');
    expect(text).toContain('转换');

    const convertButton = (): HTMLButtonElement => Array.from(root.querySelectorAll('button'))
      .find((node) => node.textContent === '转换') as HTMLButtonElement;

    convertButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.some((c) => c.startsWith('convert:'))).toBe(false);

    const input = root.querySelector('input[placeholder="WAV / MP3 / M4A …"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = 'D:/in.wav';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    convertButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain('convert:D:/in.wav');
  });

  it('唱歌页：写歌词点「唱」调 sing，参数与转成变声音色可写回', async () => {
    const { root, calls } = await mount();
    await openTab(root, '唱歌');
    const text = paneText(root);
    expect(text).toContain('速度（BPM）');
    expect(text).toContain('移调（半音）');
    expect(text).toContain('歌词');
    expect(text).toContain('唱完变声');
    const lyrics = root.querySelector('textarea.sp-text') as HTMLTextAreaElement;
    expect(lyrics).not.toBeNull();
    lyrics.value = '大肥鱼呀大肥鱼';
    lyrics.dispatchEvent(new Event('input', { bubbles: true }));
    const singBtn = Array.from(root.querySelectorAll('button')).find((node) => node.textContent === '唱') as HTMLButtonElement;
    expect(singBtn).toBeTruthy();
    singBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain('sing:大肥鱼呀大肥鱼');
  });

  it('切换引擎后换成对应字段，并把选择写回配置', async () => {
    const { root, calls } = await mount();
    const selects = Array.from(root.querySelectorAll('select')) as HTMLSelectElement[];
    const engine = selects.find((s) => Array.from(s.options).some((o) => o.value === 'dashscope'))!;
    engine.value = 'openai';
    engine.dispatchEvent(new Event('change'));
    expect(calls.some((c) => c.startsWith('setConfigValue:worlds.audio.speak.engine'))).toBe(true);
    const text = root.textContent ?? '';
    expect(text).toContain('接口地址');
    expect(text).not.toContain('参考音频');
  });
});

describe('听页', () => {
  const listenState = {
    listen: {
      vad: { kind: 'silero', threshold: 0.5, minSilenceMs: 400, maxUtteranceMs: 15000 },
    },
    stt: {
      engine: 'sensevoice', langHint: '', context: '', sampleRate: 0, maxMb: 10,
      sensevoice: { modelDir: '' },
      dashscope: { baseUrl: 'https://dashscope.aliyuncs.com', model: 'qwen3-asr-flash', apiKeySecret: 'AUDIO_API_KEY', itn: false, keepDialect: false },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', apiKeySecret: 'OPENAI_API_KEY' },
    },
    secrets: { dashscope: false, openai: true },
    lanes: [{ id: 'system', vad: '' }],
  };
  const listenApps = {
    apps: [
      { id: 'app:4242', name: 'cloudmusic', pid: 4242, title: 'Door · 高橋李依' },
      { id: 'app:5555', name: 'mpv', pid: 5555, title: '' },
    ],
    error: null,
  };

  async function mount(extra: Record<string, unknown> = {}, state: unknown = listenState) {
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    const calls: string[] = [];
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: async (method: string, args?: unknown[]) => {
        if (method === 'transcripts') return { transcripts: { count: 0, items: [] }, clips: { count: 0, items: [] } };
        calls.push(String(method) + (args ? ':' + String(args[0]) : ''));
        return method === 'apps' ? listenApps : state;
      },
      interval: () => ({ dispose: () => {} }),
      pickPath: async () => null,
      memo: { get: (_k: string, fallback: unknown) => fallback, set: () => {} },
      ...extra,
    } as unknown as WebUiPanelContext;
    await client.panels.listen.mount(ctx);
    // 页签跨挂载保留；测试统一从「监听」页开始。
    await openTab(root, '监听');
    return { root, calls };
  }

  const openTab = async (root: HTMLElement, label: string): Promise<void> => {
    const tab = Array.from(root.querySelectorAll('.aud-tab'))
      .find((node) => node.textContent === label) as HTMLButtonElement | undefined;
    if (!tab) throw new Error(`没有这个页签：${label}`);
    if (tab.getAttribute('aria-selected') === 'true') return;
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const expandApps = async (root: HTMLElement, calls: string[]): Promise<void> => {
    const card = root.querySelector('.aud-apps') as HTMLDetailsElement;
    card.open = true;
    card.dispatchEvent(new Event('toggle'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain('apps');
  };

  it('来源先列系统声音与麦克风，应用列表收起时不读', async () => {
    const { root, calls } = await mount();
    const text = root.textContent ?? '';
    expect(text).toContain('系统声音');
    expect(text).toContain('麦克风');
    expect(text).toContain('应用监听');
    expect(text).not.toContain('cloudmusic');
    expect(calls).not.toContain('apps');
    // 监听页：两路来源是勾选框，总开关与「通知 Coo」是 role=switch 的按钮。
    expect(root.querySelectorAll('input[type="checkbox"]').length).toBe(2);
    expect(root.querySelectorAll('.aud-switch').length).toBe(2);
    // 标签与控件同一行；VAD 阈值是滑动条 + 读数。
    expect(root.querySelectorAll('.sp-row').length).toBeGreaterThanOrEqual(7);
    expect(root.querySelectorAll('input[type="range"]').length).toBe(1);
    // 每一路都有自己的电平条。
    expect(root.querySelectorAll('.aud-meter').length).toBe(2);
  });

  it('电平推送来了就把条填上去', async () => {
    type StreamHandlers = { message(text: string): void; open?(): void; close?(): void };
    let handlers: StreamHandlers | null = null;
    const { root } = await mount({
      stream: (next: StreamHandlers) => {
        handlers = next;
        return { dispose: () => {} };
      },
      own: <T,>(value: T) => value,
    });
    expect(handlers).not.toBeNull();
    handlers!.open?.();
    handlers!.message(JSON.stringify({
      t: 'levels',
      listening: true,
      paused: false,
      lanes: [{ id: 'system', level: -20, active: true, listening: true, error: '' }],
    }));
    const first = root.querySelector('.aud-src-row .aud-meter') as HTMLElement;
    expect(first.classList.contains('on')).toBe(true);
    const bar = first.querySelector('i') as HTMLElement;
    expect(bar.style.width).toBe('66.7%');

    handlers!.message(JSON.stringify({ t: 'levels', listening: true, paused: false, lanes: [{ id: 'system', level: -80, active: false, listening: true, error: '' }] }));
    expect(first.classList.contains('on')).toBe(false);
    expect(bar.style.width).toBe('0%');
  });

  it('展开后列出应用，带窗口标题与切分下拉', async () => {
    const { root, calls } = await mount();
    await expandApps(root, calls);
    const text = root.textContent ?? '';
    expect(text).toContain('cloudmusic');
    expect(text).toContain('PID 4242');
    expect(text).toContain('mpv');
    expect(text).toContain('跟随默认');
    expect(root.querySelectorAll('input[type="checkbox"]').length).toBe(4);
  });

  it('二级页签：监听 / 转文本 / 流式转文本各放各的', async () => {
    const { root, calls } = await mount();
    const tabs = Array.from(root.querySelectorAll('.aud-tab')).map((node) => node.textContent);
    expect(tabs).toEqual(['监听', '转文本', '流式转文本', '记录']);
    await openTab(root, '记录');
    expect(root.textContent ?? '').toContain('还没有转写记录。');
    await openTab(root, '监听');

    // 监听页：系统/麦克风 + 处理方式（含流式转文本）。
    const vadSelect = Array.from(root.querySelectorAll('select'))
      .find((s) => Array.from((s as HTMLSelectElement).options).some((o) => o.value === 'silero')) as HTMLSelectElement;
    const vadValues = Array.from(vadSelect.options).map((o) => o.value);
    expect(vadValues).toContain('stream');
    expect(root.textContent).toContain('流式转文本');

    // 细分：不细分 / 区分音乐与人声。
    const classifySelect = Array.from(root.querySelectorAll('select'))
      .find((s) => Array.from((s as HTMLSelectElement).options).some((o) => o.value === 'aed')) as HTMLSelectElement;
    expect(classifySelect).toBeTruthy();
    expect(Array.from(classifySelect.options).map((o) => o.value)).toEqual(['none', 'aed']);
    classifySelect.value = 'aed';
    classifySelect.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.some((call) => call.startsWith('setConfigValue:worlds.audio.listen.classify'))).toBe(true);
    expect(root.textContent).toContain('音乐块只写事件');

    // 转文本页：整段识别的引擎；本机引擎不露云端字段，也没有模型目录一行。
    await openTab(root, '转文本');
    const engineSelect = Array.from(root.querySelectorAll('select'))
      .find((s) => Array.from((s as HTMLSelectElement).options).some((o) => o.value === 'sensevoice')) as HTMLSelectElement;
    const engineValues = Array.from(engineSelect.options).map((o) => o.value);
    expect(engineValues).not.toContain('moonshine');
    expect(root.textContent).not.toContain('模型目录');
    expect(root.textContent).not.toContain('接口地址');
    expect(root.textContent).not.toContain('密钥变量名');
    // 切后转文字留在这一页；投递开关不在这一页。
    expect(root.querySelectorAll('.aud-switch').length).toBe(1);
    expect(root.textContent).not.toContain('通知 Coo');

    // 流式转文本页：引擎与模型状态、用法。
    await openTab(root, '流式转文本');
    const text = root.textContent ?? '';
    expect(text).toContain('Paraformer 流式（中英）');
    expect(text).toContain('模型 未装');
    expect(text).toContain('用法');
  });

  it('处理方式选流式转文本时不摆切分参数，也不写说明句', async () => {
    const streamState = {
      ...listenState,
      listen: { ...listenState.listen, vad: { ...listenState.listen.vad, kind: 'stream' } },
    };
    const { root } = await mount({}, streamState);
    const text = root.textContent ?? '';
    expect(text).toContain('处理方式');
    expect(text).toContain('能量门限切分');
    expect(text).not.toContain('最短语音');
    expect(text).not.toContain('最短静音');
    expect(text).not.toContain('最长一句');
    expect(text).not.toContain('最短片段');
    expect(text).not.toContain('VAD 阈值');
    expect(text).not.toContain('能量门限（dBFS）');
    expect(text).not.toContain('流式来源不切分');
    expect(text).not.toContain('细分');
    expect(text).not.toContain('音乐块只写事件');
  });

  it('监听总开关用开关控件，点一下就开/停', async () => {
    const { root, calls } = await mount();
    const sw = root.querySelector('.aud-switch') as HTMLButtonElement;
    expect(sw).not.toBeNull();
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    sw.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.some((call) => call.startsWith('start'))).toBe(true);
  });

  it('「通知 Coo」开关在监听页，打开就写回投递配置', async () => {
    const { root, calls } = await mount();
    const sw = root.querySelectorAll('.aud-switch')[1] as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    sw.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain('setConfigValue:worlds.audio.listen.deliver');
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('勾选一路应用会把车道写回', async () => {
    const { root, calls } = await mount();
    await expandApps(root, calls);
    const rows = Array.from(root.querySelectorAll('.aud-src-row'));
    const appRow = rows.find((row) => (row.textContent ?? '').includes('cloudmusic'))!;
    const box = appRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain('setLane:app:4242');
  });

  it('切到 HTTP 引擎后换成对应字段并写回配置', async () => {
    const { root, calls } = await mount();
    await openTab(root, '转文本');
    const select = Array.from(root.querySelectorAll('select'))
      .find((s) => Array.from((s as HTMLSelectElement).options).some((o) => o.value === 'openai')) as HTMLSelectElement;
    select.value = 'openai';
    select.dispatchEvent(new Event('change'));
    expect(calls.some((c) => c.startsWith('setConfigValue:worlds.audio.stt.engine'))).toBe(true);
    const text = root.textContent ?? '';
    expect(text).toContain('接口地址');
    expect(text).not.toContain('模型目录');
  });
});

describe('工具页', () => {
  const view = {
    revision: 'r1',
    overrides: {},
    warnings: [],
    tools: [{
      name: 'audio_play',
      tags: ['act'],
      summary: { zh: '播放一个音频文件，后面的排队。', en: 'Plays an audio file.' },
      fields: [{
        path: '/description', location: 'audio_play', keyword: 'description',
        defaultText: 'Play a file.', inheritedText: 'Play a file.', inheritedSource: 'default',
        text: 'Play a file.', source: 'default',
      }],
    }],
  };

  it('列出工具并给出可编辑的说明', async () => {
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: async () => view,
      interval: () => ({ dispose: () => {} }),
      guardLeave: () => ({ dispose: () => {} }),
      memo: { get: (_k: string, fallback: unknown) => fallback, set: () => {} },
    } as unknown as WebUiPanelContext;

    await client.panels.tools.mount(ctx);
    const text = root.textContent ?? '';
    expect(text).toContain('工具');
    expect(text).toContain('audio_play');
    expect(text).toContain('播放一个音频文件');
    const area = root.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(area?.value).toBe('Play a file.');
  });
});

describe('队列页', () => {
  const snap = {
    current: { id: 'q1', shown: 'a.wav', ref: 'D:/a.wav', volume: 80, origin: 'tool', position: 0, elapsedSec: 3 },
    pending: [{ id: 'q2', shown: 'b.wav', ref: 'D:/b.wav', volume: 80, origin: 'tool', position: 1, elapsedSec: 0 }],
    counts: { current: 1, pending: 1 },
    volume: 80,
    lastError: null,
  };

  it('显示当前与排队，并给出跳过/移除按钮', async () => {
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: async () => snap,
      interval: () => ({ dispose: () => {} }),
    } as unknown as WebUiPanelContext;

    await client.panels.queue.mount(ctx);
    const text = root.textContent ?? '';
    // 当前这条只由下面的卡片表示，顶部不再重复。
    expect(text.split('a.wav').length - 1).toBe(1);
    const slider = root.querySelector('input[type="range"]') as HTMLInputElement | null;
    expect(slider?.value).toBe('80');
    expect(text).toContain('a.wav');
    expect(text).toContain('b.wav');
    expect(text).toContain('已 3 秒');
    expect(text).toContain('跳过');
    expect(text).toContain('移除');
    expect(text).toContain('默认音量');
    expect(text).not.toContain('80%');
    const readout = root.querySelector('.sp-value') as HTMLInputElement | null;
    expect(readout?.value).toBe('80');
  });

  const style = { enabled: true, size: 34, color: '#FFD54F', vertical: 'top', align: 'right' };

  const mountQueue = async (view: unknown, calls: unknown[][] = []): Promise<HTMLElement> => {
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: async (method: string, args: unknown[] = []) => {
        if (method === 'subtitle') return style;
        calls.push([method, ...args]);
        return view;
      },
      interval: () => ({ dispose: () => {} }),
      timeout: (fn: () => void) => fn(),
    } as unknown as WebUiPanelContext;
    await client.panels.queue.mount(ctx);
    return root;
  };

  it('字幕设置按当前样式铺开：开关、字号、颜色、位置与预览', async () => {
    const root = await mountQueue(snap);
    const text = root.textContent ?? '';
    expect(text).toContain('桌面字幕');
    expect(text).toContain('字号');
    expect(text).toContain('颜色');
    expect(text).toContain('位置');
    expect(text).toContain('预览字幕');
    const color = root.querySelector('.aq-color') as HTMLInputElement;
    expect(color.value).toBe('#ffd54f');
    const selects = Array.from(root.querySelectorAll('select')) as HTMLSelectElement[];
    expect(selects[0].value).toBe('top');
    expect(selects[1].value).toBe('right');
    const size = root.querySelector('input[type="range"]:not(.aq-volume)') as HTMLInputElement;
    expect(size.value).toBe('34');
  });

  it('改字幕设置写回配置项', async () => {
    const calls: unknown[][] = [];
    const root = await mountQueue(snap, calls);
    const sw = root.querySelector('button[role="switch"]') as HTMLButtonElement;
    sw.click();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    const selects = Array.from(root.querySelectorAll('select')) as HTMLSelectElement[];
    selects[0].value = 'middle';
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    expect(calls).toContainEqual(['setConfigValue', 'worlds.audio.subtitle.enabled', false]);
    expect(calls).toContainEqual(['setConfigValue', 'worlds.audio.subtitle.vertical', 'middle']);
  });
});


describe('记录页', () => {
  const state = {
    transcripts: {
      count: 2,
      items: [
        {
          id: 't1', text: '叫んだよ、何回ない。', note: '', source: { kind: 'file', ref: 'D:/data/log2ca.wav' },
          model: 'SenseVoiceSmall', language: 'ja', seconds: 15, audioBytes: 480 * 1024,
          createdAt: '2026-10-31T07:50:01.000Z',
        },
        {
          id: 't2', text: '', note: '', source: { kind: 'file', ref: '' },
          model: 'whisper-1', language: '', seconds: null, audioBytes: 0,
          createdAt: '2026-10-31T07:51:01.000Z',
        },
      ],
    },
    clips: {
      count: 1,
      items: [{
        id: 'c1', file: '20261031-080212-b938c607.wav', path: 'D:/audio/clips/20261031-080212-b938c607.wav',
        bytes: 318 * 1024, seconds: 6.8, text: '早。昨晚歌听那么久，今天脖子该酸了。', note: '',
        voice: 'xll.zh.wav', model: 'GPT-SoVITS', createdAt: '2026-10-31T08:02:12.000Z',
      }],
    },
  };

  const mount = async (data: unknown): Promise<{ root: HTMLElement; copies: string[] }> => {
    const copies: string[] = [];
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copies.push(text); } },
    });
    const root = document.createElement('div');
    const ui = createWebUi({
      memo: { get: (_k, fallback) => fallback, set: () => {} },
      overlayHost: document.body,
      signal: new AbortController().signal,
    });
    const ctx = {
      root,
      ui,
      language: 'zh',
      signal: new AbortController().signal,
      invoke: async (method: string) => (method === 'state' ? data : { ok: true }),
      interval: () => ({ dispose: () => {} }),
    } as unknown as WebUiPanelContext;
    await client.panels.records.mount(ctx);
    return { root, copies };
  };

  it('两栏各就各位：转写文字、语音试听', async () => {
    const { root } = await mount(state);
    const text = root.textContent ?? '';
    expect(text).toContain('转写');
    expect(text).toContain('叫んだよ、何回ない。');
    expect(text).toContain('D:/data/log2ca.wav');
    expect(text).toContain('语音');
    expect(text).toContain('早。昨晚歌听那么久');
    expect(text).toContain('6.8s');
    expect(text).toContain('GPT-SoVITS');

    const labels = Array.from(root.querySelectorAll('button')).map((button) => button.textContent);
    expect(labels.filter((label) => label === '试听').length).toBe(1);
    expect(labels.filter((label) => label === '复制文字').length).toBe(1);
    expect(labels.filter((label) => label === '复制路径').length).toBe(1);
  });

  it('时间按本机时区显示：老记录（UTC）换成本地，新记录（带偏移）直接切', async () => {
    const localClock = (iso: string): string => {
      const date = new Date(iso);
      const pad = (n: number): string => String(n).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };
    // 老记录：07:50:01Z 在这台机器上应该是 15:50:01（东八区）。
    const legacy = await mount(state);
    expect(legacy.root.textContent ?? '').toContain(localClock('2026-10-31T07:50:01.000Z'));

    // 新记录：服务端给本地墙钟串，原样显示，不再叠一次时区。
    const fresh = structuredClone(state);
    fresh.clips.items[0].createdAt = '2026-10-31T20:04:54.694+08:00';
    fresh.transcripts.items[0].createdAt = '2026-10-31T20:05:01.694+08:00';
    const now = await mount(fresh);
    expect(now.root.textContent ?? '').toContain('20:04:54');
    expect(now.root.textContent ?? '').toContain('20:05:01');
  });

  it('二级页签：一次只显示一栏，每条记录都是收起的折叠块', async () => {
    const { root } = await mount(state);
    const tabs = Array.from(root.querySelectorAll('.rec-tab')).map((tab) => tab.textContent);
    expect(tabs).toEqual(['转写', '语音']);

    const visible = (text: string): boolean =>
      Array.from(root.querySelectorAll<HTMLElement>('.rec-block'))
        .filter((block) => !block.hidden)
        .some((block) => block.textContent?.includes(text) ?? false);
    expect(visible('叫んだよ、何回ない。')).toBe(true);
    expect(visible('GPT-SoVITS')).toBe(false);

    const details = Array.from(root.querySelectorAll('details.rec-item'));
    expect(details.length).toBe(3);
    expect(details.every((el) => !(el as HTMLDetailsElement).open)).toBe(true);

    const voiceTab = Array.from(root.querySelectorAll<HTMLButtonElement>('.rec-tab'))
      .find((tab) => tab.textContent === '语音') as HTMLButtonElement;
    voiceTab.click();
    expect(voiceTab.getAttribute('aria-selected')).toBe('true');
    expect(visible('GPT-SoVITS')).toBe(true);
  });

  it('复制文字拿到正文；没有文字的记录不铺空行', async () => {
    const { root, copies } = await mount(state);
    const copy = Array.from(root.querySelectorAll('button'))
      .find((button) => button.textContent === '复制文字') as HTMLButtonElement;
    copy.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copies).toEqual(['叫んだよ、何回ない。']);
    expect(root.textContent).toContain('没有文字');
  });

  it('空栏写清原因，模板里不会出现「无」占位', async () => {
    const empty = {
      transcripts: { count: 0, items: [] },
      clips: { count: 0, items: [] },
    };
    const { root } = await mount(empty);
    const text = root.textContent ?? '';
    expect(text).toContain('还没有转写记录。');
    expect(text).toContain('还没有合成语音。');
    expect(text).not.toContain('无');
  });
});
