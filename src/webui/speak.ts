/**
 * 「说话」页：说话 / 变声 / 唱歌三个二级页签。引擎不同，显示不同字段；
 * 本地 GPT-SoVITS 的参考音频从 `<dataDir>/timbre/` 里选（导入即可，支持拖放），台本跟音频绑定。
 */
import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { queuePanel } from './queue.ts';
import { recordsSection } from './records.ts';

type Lang = 'zh' | 'en';

interface Timbre {
  file: string;
  name: string;
  text: string;
}

interface ConvertRuntime {
  ready: boolean;
  voice: string;
  missing: string[];
  engine: { phase: string; device: string | null; model: string | null; detail: string | null };
}

interface SingRuntime {
  ready: boolean;
  bank: string;
  missing: string[];
  engine: { phase: string; voicebank: string | null; sampleRate: number | null; speakers: string[]; detail: string | null };
}

interface LastSing {
  voice: string;
  seconds: number | null;
  ms: number;
  path: string;
  at: string;
}

interface LastConvert {
  voice: string;
  seconds: number | null;
  ms: number;
  path: string;
  at: string;
}

interface SpeakState {
  speak: {
    engine: 'edge' | 'gpt-sovits' | 'dashscope' | 'openai';
    textLang: string;
    edge: { voice: string; rate: number; pitch: number };
    gptSovits: { tier: string; refAudio: string; refText: string; speed: number };
    dashscope: {
      baseUrl: string; model: string; voice: string; apiKeySecret: string;
      format: string; sampleRate: number; instruction: string; languageHints: string; seed: number;
    };
    openai: {
      baseUrl: string; model: string; voice: string; apiKeySecret: string;
      format: string; sampleRate: number; languageHints: string;
    };
  };
  timbres: Timbre[];
  refFile: string;
  rvcVoices: string[];
  rvcFile: string;
  rvcRuntime?: ConvertRuntime;
  lastConvert?: LastConvert | null;
  singRuntime?: SingRuntime;
  lastSing?: LastSing | null;
  banks: Array<{ name: string; label: string; colors: string[] }>;
  convert: { engine: string; model: string; pitch: number; indexRate: number; protect: number };
  sing: { engine: string; voicebank: string; color: string; bpm: number; keyShift: number; scale: 'major' | 'minor'; seed: number; convert: boolean };
  gpus: Array<{ index: number; name: string; vramMB: number }>;
  secrets: { dashscope: boolean; openai: boolean };
}

const TEXT = {
  zh: {
    speakTitle: '说话',
    convertTitle: '变声',
    singTitle: '唱歌',
    queueTitle: '播放',
    recordsTitle: '记录',
    engine: '引擎',
    textLang: '台词语言',
    tier: '推理档',
    refAudio: '参考音频',
    refText: '参考台本',
    refNone: '未选择',
    refImport: '导入',
    refDrop: '把 WAV 拖到这里导入',
    speed: '语速',
    model: '模型',
    voice: '音色',
    edgeRate: '语速',
    edgePitch: '音调',
    baseUrl: '接口地址',
    dashscopeBase: 'DashScope 地址',
    keyName: '密钥变量名',
    key: '密钥',
    saveKey: '保存密钥',
    keySet: '已填',
    keyMissing: '未填',
    keySaved: '密钥已写入部署 .env',
    pick: '选择文件',
    convertModel: '音色文件',
    pitch: '变调',
    indexRate: '索引率',
    protect: '保护清辅音',
    convertAudio: '音频文件',
    convertRun: '转换',
    converting: '转换中…',
    convertDone: '转换好了，已加入播放队列',
    convertNeedFile: '先选一段音频。',
    convertNeedVoice: '先导入并选中一个音色文件（.pth）。',
    convertMissing: '还缺',
    lastConvert: '最近一次',
    playAgain: '再播一次',
    convertHint: '同名 .index 会一起用；转完的结果进「记录 → 语音」。',
    voicebank: '声库',
    singBpm: '速度（BPM）',
    singKey: '移调（半音）',
    singScale: '调式',
    scaleMajor: '大调',
    scaleMinor: '小调',
    singSeed: '旋律种子（0 按歌词固定）',
    singConvert: '唱完变声',
    singLyrics: '歌词',
    singLyricsPlaceholder: '写下要唱的句子；标点断句。',
    singRun: '唱',
    singing: '演唱中…',
    singDone: '唱好了，已加入播放队列',
    singNeedLyrics: '先写一句歌词。',
    lastSing: '最近一次',
    color: '音色',
    saveFailed: '保存失败：',
    format: '音频格式',
    sampleRate: '采样率（0 不发）',
    instruction: '默认指令',
    langHints: '语言提示',
    seed: '随机种子（-1 随机）',
  },
  en: {
    speakTitle: 'Speech',
    convertTitle: 'Convert',
    singTitle: 'Sing',
    queueTitle: 'Playback',
    recordsTitle: 'Records',
    engine: 'Engine',
    textLang: 'Line language',
    tier: 'Tier',
    refAudio: 'Reference audio',
    refText: 'Reference script',
    refNone: 'None',
    refImport: 'Import',
    refDrop: 'Drop a WAV here to import',
    speed: 'Speed',
    model: 'Model',
    voice: 'Voice',
    edgeRate: 'Rate',
    edgePitch: 'Pitch',
    baseUrl: 'Base URL',
    dashscopeBase: 'DashScope base URL',
    keyName: 'Secret name',
    key: 'Secret',
    saveKey: 'Save secret',
    keySet: 'set',
    keyMissing: 'missing',
    keySaved: 'Secret written to the deployment .env',
    pick: 'Pick file',
    convertModel: 'Voice file',
    pitch: 'Pitch',
    indexRate: 'Index rate',
    protect: 'Protect',
    convertAudio: 'Audio file',
    convertRun: 'Convert',
    converting: 'Converting…',
    convertDone: 'Converted; queued for playback',
    convertNeedFile: 'Pick an audio file first.',
    convertNeedVoice: 'Import and select a voice file (.pth) first.',
    convertMissing: 'Missing',
    lastConvert: 'Last',
    playAgain: 'Play again',
    convertHint: 'A same-name .index is used when present; results land in Records → Speech.',
    voicebank: 'Voicebank',
    singBpm: 'Tempo (BPM)',
    singKey: 'Transpose (semitones)',
    singScale: 'Scale',
    scaleMajor: 'Major',
    scaleMinor: 'Minor',
    singSeed: 'Melody seed (0 = fixed by lyrics)',
    singConvert: 'Convert after singing',
    singLyrics: 'Lyrics',
    singLyricsPlaceholder: 'Write the lines to sing; punctuation splits phrases.',
    singRun: 'Sing',
    singing: 'Singing…',
    singDone: 'Sung; queued for playback',
    singNeedLyrics: 'Write a line first.',
    lastSing: 'Last',
    color: 'Color',
    saveFailed: 'Save failed: ',
    format: 'Audio format',
    sampleRate: 'Sample rate (0 = unset)',
    instruction: 'Default instruction',
    langHints: 'Language hints',
    seed: 'Seed (-1 = random)',
  },
} as const;

const FORMATS = {
  dashscope: [
    { value: 'wav', label: { zh: 'WAV', en: 'WAV' } },
    { value: 'mp3', label: { zh: 'MP3', en: 'MP3' } },
    { value: 'ogg', label: { zh: 'OGG', en: 'OGG' } },
    { value: 'opus', label: { zh: 'Opus', en: 'Opus' } },
    { value: 'pcm', label: { zh: 'PCM', en: 'PCM' } },
  ],
  openai: [
    { value: 'mp3', label: { zh: 'MP3', en: 'MP3' } },
    { value: 'wav', label: { zh: 'WAV', en: 'WAV' } },
    { value: 'ogg', label: { zh: 'OGG', en: 'OGG' } },
  ],
} as const;

type Tab = 'speak' | 'convert' | 'sing' | 'queue' | 'clips';

/** 二级页签跨挂载保留：切走再回来还在原页。 */
let activeTab: Tab = 'speak';
/** 变声页选的音频路径；重画时不清掉。 */
let convertInput = '';
/** 唱歌页写的歌词；重画时不清掉。 */
let singLyrics = '';

const ENGINES = {
  speak: [
    { value: 'edge', label: { zh: 'edge朗读', en: 'Edge read-aloud' } },
    { value: 'gpt-sovits', label: { zh: '本机 GPT-SoVITS', en: 'Local GPT-SoVITS' } },
    { value: 'dashscope', label: { zh: 'HTTP · DashScope', en: 'HTTP · DashScope' } },
    { value: 'openai', label: { zh: 'HTTP · OpenAI 兼容', en: 'HTTP · OpenAI-compatible' } },
  ],
  tier: [
    { value: 'auto', label: { zh: '自动', en: 'Auto' } },
    { value: 'cpu', label: { zh: 'CPU', en: 'CPU' } },
  ],
  lang: [
    { value: 'auto', label: { zh: '自动', en: 'Auto' } },
    { value: 'zh', label: { zh: '中文', en: 'Chinese' } },
    { value: 'en', label: { zh: '英语', en: 'English' } },
    { value: 'ja', label: { zh: '日语', en: 'Japanese' } },
    { value: 'ko', label: { zh: '韩语', en: 'Korean' } },
  ],
} as const;

export const speakPanel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext) {
    const lang: Lang = ctx.language?.startsWith('zh') ? 'zh' : 'en';
    const t = TEXT[lang];
    const doc = ctx.root.ownerDocument;
    let state = await ctx.invoke<SpeakState>('state');
    let pending: { dispose(): void } | null = null;

    const save = (key: string, value: unknown, immediate = false): void => {
      pending?.dispose();
      const fire = (): void => {
        pending = null;
        void ctx.invoke('setConfigValue', [`worlds.audio.${key}`, value]).catch((err: unknown) => {
          ctx.ui.toast(`${t.saveFailed}${err instanceof Error ? err.message : String(err)}`, 'bad');
        });
      };
      if (immediate) fire();
      else pending = ctx.timeout(fire, 350);
    };
    const call = async (method: string, args: unknown[] = []): Promise<void> => {
      try {
        state = await ctx.invoke<SpeakState>(method, args);
        render();
      } catch (err) {
        ctx.ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    };

    const el = (tag: string, cls = '', text = ''): HTMLElement => {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (text) node.textContent = text;
      return node;
    };
    const field = (label: string, control: HTMLElement): HTMLElement => {
      const row = el('div', 'sp-row');
      row.append(el('span', 'sp-label', label), control);
      return row;
    };
    /** 滑动条 + 右侧读数。 */
    const slider = (value: number, opts: { min: number; max: number; step: number }, onChange: (v: number) => void, format: (v: number) => string): HTMLElement => {
      const wrap = el('div', 'sp-slider');
      const input = ctx.ui.h('input', null) as HTMLInputElement;
      input.type = 'range';
      input.min = String(opts.min);
      input.max = String(opts.max);
      input.step = String(opts.step);
      input.value = String(value);
      const readout = ctx.ui.input({ type: 'number', value: format(value) });
      readout.classList.add('sp-value');
      readout.min = String(opts.min);
      readout.max = String(opts.max);
      readout.step = String(opts.step);
      const commit = (next: number): void => {
        if (!Number.isFinite(next)) return;
        const clamped = Math.min(opts.max, Math.max(opts.min, next));
        input.value = String(clamped);
        onChange(clamped);
      };
      input.addEventListener('input', () => {
        const next = Number(input.value);
        readout.value = format(next);
        onChange(next);
      }, { signal: ctx.signal });
      readout.addEventListener('change', () => {
        const next = Number(readout.value);
        commit(next);
        readout.value = format(Number(input.value));
      }, { signal: ctx.signal });
      wrap.append(input, readout);
      return wrap;
    };
    const textInput = (value: string, onInput: (v: string) => void, disabled = false): HTMLInputElement =>
      ctx.ui.input({ value, onInput, disabled });
    const numberInput = (value: number, opts: { min?: number; max?: number; step?: number }, onChange: (v: number) => void): HTMLInputElement => {
      const input = ctx.ui.input({ type: 'number', value: String(value) });
      if (opts.min !== undefined) input.min = String(opts.min);
      if (opts.max !== undefined) input.max = String(opts.max);
      if (opts.step !== undefined) input.step = String(opts.step);
      input.addEventListener('change', () => {
        const next = Number(input.value);
        if (Number.isFinite(next)) onChange(next);
      }, { signal: ctx.signal });
      return input;
    };
    const choose = <T extends readonly { value: string; label: Record<Lang, string> }[]>(options: T, value: string, onChange: (v: string) => void): HTMLSelectElement =>
      ctx.ui.select({ options: options.map((option) => ({ value: option.value, label: option.label[lang] })), value, onInput: onChange });
    const pathRow = (value: string, extensions: string[], onChange: (v: string) => void): HTMLElement => {
      const row = ctx.ui.rowbar();
      const input = textInput(value, onChange);
      input.classList.add('grow');
      row.append(input, ctx.ui.button(t.pick, {
        size: 'sm',
        onClick: async () => {
          const picked = await ctx.pickPath({ kind: 'file', extensions });
          if (picked) {
            input.value = picked;
            onChange(picked);
          }
        },
      }));
      return row;
    };
    const secretRow = (kind: 'dashscope' | 'openai'): HTMLElement => {
      const row = ctx.ui.rowbar();
      const input = ctx.ui.input({ type: 'password', placeholder: t.key });
      const dot = ctx.ui.pill(state.secrets[kind] ? t.keySet : t.keyMissing, state.secrets[kind] ? 'on' : 'off');
      const name = kind === 'dashscope' ? state.speak.dashscope.apiKeySecret : state.speak.openai.apiKeySecret;
      row.append(input, ctx.ui.button(t.saveKey, {
        size: 'sm',
        onClick: async () => {
          const value = input.value.trim();
          if (!value) return;
          try {
            state = await ctx.invoke<SpeakState>('saveSecret', [name, value]);
            input.value = '';
            dot.textContent = state.secrets[kind] ? t.keySet : t.keyMissing;
            dot.className = state.secrets[kind] ? 'pill on' : 'pill off';
            ctx.ui.toast(t.keySaved);
          } catch (err) {
            ctx.ui.toast(`${t.saveFailed}${err instanceof Error ? err.message : String(err)}`, 'bad');
          }
        },
      }), dot);
      return row;
    };

    /** 参考音频：下拉选已导入的，导入按钮与拖放都能加新的；台本跟着选中的音频。 */
    const timbreRow = (): HTMLElement => {
      const timbres = state.timbres ?? [];
      const selected = state.refFile ?? '';
      const box = el('div', 'timbre-box');
      const row = ctx.ui.rowbar();
      const select = ctx.ui.select({
        options: [{ value: '', label: t.refNone }, ...timbres.map((item) => ({ value: item.file, label: item.name }))],
        value: selected,
        onInput: (file) => { void call('useTimbre', [file]); },
      });
      select.classList.add('grow');
      const importBtn = ctx.ui.button(t.refImport, {
        size: 'sm',
        onClick: async () => {
          const picked = await ctx.pickPath({ kind: 'file', extensions: ['.wav'] });
          if (picked) void call('importTimbreFromPath', [picked]);
        },
      });
      row.append(select, importBtn);
      const hint = el('div', 'timbre-drop', t.refDrop);
      box.append(row, hint);
      box.addEventListener('dragover', (event) => {
        event.preventDefault();
        box.classList.add('over');
      }, { signal: ctx.signal });
      box.addEventListener('dragleave', () => box.classList.remove('over'), { signal: ctx.signal });
      box.addEventListener('drop', (event) => {
        event.preventDefault();
        box.classList.remove('over');
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        void file.arrayBuffer().then((buffer) => {
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
          void call('importTimbreBytes', [file.name, btoa(binary)]);
        });
      }, { signal: ctx.signal });
      return box;
    };

    const style = el('style');
    style.textContent = `
.timbre-box { border: 1px dashed rgba(128,128,128,.35); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.timbre-box.over { border-color: #5650ce; }
.timbre-drop { font-size: 11px; opacity: .6; text-align: center; }
.sp-row { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 10px; align-items: center; margin: 6px 0; }
.sp-label { font-size: 12px; opacity: .75; }
.sp-slider { display: flex; gap: 10px; align-items: center; }
.sp-slider input[type=range] { flex: 1 1 auto; }
.sp-value { width: 72px; text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; }
.sp-text { width: 100%; box-sizing: border-box; min-height: 76px; resize: vertical; font: inherit; font-size: 13px; color: inherit; background: transparent; border: 1px solid rgba(128,128,128,.35); border-radius: 8px; padding: 8px 10px; }
.aud-switch { position: relative; flex: 0 0 auto; width: 36px; height: 20px; border: 0; padding: 0; border-radius: 10px; background: rgba(128,128,128,.38); cursor: pointer; transition: background .15s; }
.aud-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
.aud-switch.on { background: var(--accent, #5b7cfa); }
.aud-switch.on::after { transform: translateX(16px); }
.aud-switch:focus-visible { outline: 2px solid var(--accent, #5b7cfa); outline-offset: 2px; }
.aud-tabs { position: sticky; top: 0; z-index: 5; display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid rgba(128,128,128,.25); background: var(--background, var(--paper, #fbfbfb)); margin: 0 0 12px; padding-top: 4px; max-width: 900px; }
.aud-tab { font: inherit; font-size: 13px; background: none; border: 0; color: inherit; opacity: .62; padding: 6px 10px 8px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.aud-tab:hover { opacity: .85; }
.aud-tab.on { opacity: 1; font-weight: 600; border-bottom-color: var(--accent, #5b7cfa); }
`;
    ctx.root.append(style);

    const root = el('section');
    ctx.root.append(root);

    // 播放与「语音」记录都收到这一页下：子面板共用 ctx，方法名加前缀分流到 World 的 queue/clips。
    const childPanes: Record<'queue' | 'clips', HTMLElement> = { queue: el('div'), clips: el('div') };
    const mountChild = (pane: HTMLElement, panel: WebUiPanel, prefix: string): void => {
      const sub = {
        ...ctx,
        root: pane,
        invoke: (method: string, args?: unknown[]) => (method === 'setConfigValue'
          ? ctx.invoke(method, args)
          // 记录子面板会把栏名当第一个参数传，这里剥掉，由前缀决定是哪一栏。
          : ctx.invoke(prefix, [method, ...(args ?? []).slice(prefix === 'queue' ? 0 : 1)])),
      } as unknown as WebUiPanelContext;
      void panel.mount(sub);
    };
    mountChild(childPanes.queue, queuePanel, 'queue');
    mountChild(childPanes.clips, recordsSection('clips'), 'clips');

    const TABS: ReadonlyArray<readonly [Tab, string]> = [
      ['speak', t.speakTitle],
      ['convert', t.convertTitle],
      ['sing', t.singTitle],
      ['queue', t.queueTitle],
      ['clips', t.recordsTitle],
    ];

    /** 三页各画一次，切页签只改 hidden；不重建 DOM，免得刷掉刚输入、还没保存的值。 */
    function render(): void {
      if (ctx.signal.aborted) return;
      root.replaceChildren();

      const panes: Record<Tab, HTMLElement> = { speak: el('div'), convert: el('div'), sing: el('div'), queue: childPanes.queue, clips: childPanes.clips };
      renderSpeak(panes.speak);
      renderConvert(panes.convert);
      renderSing(panes.sing);
      for (const [tab] of TABS) {
        panes[tab].setAttribute('role', 'tabpanel');
        panes[tab].hidden = tab !== activeTab;
      }

      const bar = el('div', 'aud-tabs');
      bar.setAttribute('role', 'tablist');
      const buttons: HTMLButtonElement[] = [];
      for (const [tab, label] of TABS) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = tab === activeTab ? 'aud-tab on' : 'aud-tab';
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', String(tab === activeTab));
        btn.textContent = label;
        btn.addEventListener('click', () => {
          if (activeTab === tab) return;
          activeTab = tab;
          TABS.forEach(([key], index) => {
            const other = buttons[index];
            other.className = key === tab ? 'aud-tab on' : 'aud-tab';
            other.setAttribute('aria-selected', String(key === tab));
            panes[key].hidden = key !== tab;
          });
        }, { signal: ctx.signal });
        buttons.push(btn);
        bar.append(btn);
      }

      root.append(bar, ...TABS.map(([tab]) => panes[tab]));
    }

    /** 说话：引擎、台词语言，以及该引擎自己的字段。 */
    function renderSpeak(pane: HTMLElement): void {
      pane.append(field(t.engine, choose(ENGINES.speak, state.speak.engine, (v) => {
        state.speak.engine = v as SpeakState['speak']['engine'];
        save('speak.engine', v, true);
        render();
      })));
      pane.append(field(t.textLang, choose(ENGINES.lang, state.speak.textLang, (v) => save('speak.textLang', v, true))));
      const detail = el('div');
      pane.append(detail);
      if (state.speak.engine === 'edge') {
        const e = state.speak.edge;
        detail.append(field(t.voice, textInput(e.voice, (v) => save('speak.edge.voice', v))));
        detail.append(field(t.edgeRate, slider(e.rate, { min: -50, max: 100, step: 5 }, (v) => save('speak.edge.rate', v), (v) => String(v))));
        detail.append(field(t.edgePitch, slider(e.pitch, { min: -50, max: 50, step: 1 }, (v) => save('speak.edge.pitch', v), (v) => String(v))));
      } else if (state.speak.engine === 'gpt-sovits') {
        const g = state.speak.gptSovits;
        const gpus = state.gpus ?? [];
        const tierOptions = [
          ...ENGINES.tier,
          ...gpus.map((gpu) => {
            const name = gpu.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '');
            const label = { zh: `GPU ${gpu.index} · ${name}`, en: `GPU ${gpu.index} · ${name}` };
            return { value: `gpu${gpu.index}`, label };
          }),
        ];
        const tierValue = tierOptions.some((option) => option.value === g.tier) ? g.tier : 'auto';
        detail.append(field(t.tier, choose(tierOptions, tierValue, (v) => save('speak.gptSovits.tier', v, true))));
        detail.append(field(t.refAudio, timbreRow()));
        if (state.refFile) {
          const selected = (state.timbres ?? []).find((item) => item.file === state.refFile);
          detail.append(field(t.refText, textInput(selected?.text ?? '', (v) => {
            void call('setTimbreText', [state.refFile, v]);
          })));
        }
        detail.append(field(t.speed, slider(g.speed, { min: 0.5, max: 2, step: 0.05 }, (v) => save('speak.gptSovits.speed', v), (v) => v.toFixed(2))));
      } else if (state.speak.engine === 'dashscope') {
        const d = state.speak.dashscope;
        detail.append(field(t.dashscopeBase, textInput(d.baseUrl, (v) => save('speak.dashscope.baseUrl', v))));
        detail.append(field(t.model, textInput(d.model, (v) => save('speak.dashscope.model', v))));
        detail.append(field(t.voice, textInput(d.voice, (v) => save('speak.dashscope.voice', v))));
        detail.append(field(t.format, choose(FORMATS.dashscope, d.format, (v) => save('speak.dashscope.format', v, true))));
        detail.append(field(t.sampleRate, numberInput(d.sampleRate, { min: 0, max: 48000, step: 1000 }, (v) => save('speak.dashscope.sampleRate', v))));
        detail.append(field(t.instruction, textInput(d.instruction, (v) => save('speak.dashscope.instruction', v))));
        detail.append(field(t.langHints, textInput(d.languageHints, (v) => save('speak.dashscope.languageHints', v))));
        detail.append(field(t.seed, numberInput(d.seed, { min: -1, max: 65535, step: 1 }, (v) => save('speak.dashscope.seed', v))));
        detail.append(field(t.keyName, textInput(d.apiKeySecret, (v) => save('speak.dashscope.apiKeySecret', v))));
        detail.append(field(t.key, secretRow('dashscope')));
      } else {
        const o = state.speak.openai;
        detail.append(field(t.baseUrl, textInput(o.baseUrl, (v) => save('speak.openai.baseUrl', v))));
        detail.append(field(t.model, textInput(o.model, (v) => save('speak.openai.model', v))));
        detail.append(field(t.voice, textInput(o.voice, (v) => save('speak.openai.voice', v))));
        detail.append(field(t.format, choose(FORMATS.openai, o.format, (v) => save('speak.openai.format', v, true))));
        detail.append(field(t.sampleRate, numberInput(o.sampleRate, { min: 0, max: 48000, step: 1000 }, (v) => save('speak.openai.sampleRate', v))));
        detail.append(field(t.langHints, textInput(o.languageHints, (v) => save('speak.openai.languageHints', v))));
        detail.append(field(t.keyName, textInput(o.apiKeySecret, (v) => save('speak.openai.apiKeySecret', v))));
        detail.append(field(t.key, secretRow('openai')));
      }
    }

    /** 变声：RVC 音色与三个参数，选一段音频就地转换；结果自动进播放队列。 */
    function renderConvert(pane: HTMLElement): void {
      const c = state.convert;
      const runtime = state.rvcRuntime;
      pane.append(field(t.engine, ctx.ui.select({ options: [{ value: 'rvc', label: 'RVC' }], value: c.engine })));
      const voiceRow = ctx.ui.rowbar();
      const voices = state.rvcVoices ?? [];
      const voiceSelect = ctx.ui.select({
        options: [{ value: '', label: t.refNone }, ...voices.map((file) => ({ value: file, label: file.replace(/.pth$/i, '') }))],
        value: state.rvcFile ?? '',
        onInput: (file) => { void call('useRvcVoice', [file]); },
      });
      voiceSelect.classList.add('grow');
      voiceRow.append(voiceSelect, ctx.ui.button(t.refImport, {
        size: 'sm',
        onClick: async () => {
          const picked = await ctx.pickPath({ kind: 'file', extensions: ['.pth'] });
          if (picked) void call('importRvcVoice', [picked]);
        },
      }));
      pane.append(field(t.convertModel, voiceRow));
      pane.append(field(t.pitch, slider(c.pitch, { min: -24, max: 24, step: 1 }, (v) => save('convert.pitch', v), (v) => String(v))));
      pane.append(field(t.indexRate, slider(c.indexRate, { min: 0, max: 1, step: 0.01 }, (v) => save('convert.indexRate', v), (v) => v.toFixed(2))));
      pane.append(field(t.protect, slider(c.protect, { min: 0, max: 0.5, step: 0.01 }, (v) => save('convert.protect', v), (v) => v.toFixed(2))));

      const audioRow = ctx.ui.rowbar();
      const audioInput = textInput(convertInput, (v) => { convertInput = v; });
      audioInput.classList.add('grow');
      audioInput.placeholder = 'WAV / MP3 / M4A …';
      const runBtn = ctx.ui.button(t.convertRun, { size: 'sm', onClick: () => { void run(); } });
      runBtn.disabled = !state.rvcFile;
      audioRow.append(audioInput, ctx.ui.button(t.pick, {
        size: 'sm',
        onClick: async () => {
          const picked = await ctx.pickPath({ kind: 'file', extensions: ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.opus'] });
          if (!picked) return;
          convertInput = picked;
          audioInput.value = picked;
        },
      }), runBtn);
      pane.append(field(t.convertAudio, audioRow));
      pane.append(el('div', 'timbre-drop', t.convertHint));
      if (runtime && runtime.missing?.length) {
        pane.append(el('div', 'timbre-drop', `${t.convertMissing}：${runtime.missing.join('、')}`));
      }
      const last = state.lastConvert;
      if (last) {
        const lastRow = ctx.ui.rowbar();
        const seconds = last.seconds ? ` · ${last.seconds.toFixed(1)}s` : '';
        lastRow.append(el('span', 'sp-label', `${t.lastConvert}：${last.voice}${seconds}`));
        lastRow.append(ctx.ui.button(t.playAgain, { size: 'sm', onClick: () => { void call('playLastConvert'); } }));
        pane.append(lastRow);
      }

      async function run(): Promise<void> {
        const source = convertInput.trim() || audioInput.value.trim();
        if (!source) { ctx.ui.toast(t.convertNeedFile, 'bad'); return; }
        if (!state.rvcFile) { ctx.ui.toast(t.convertNeedVoice, 'bad'); return; }
        runBtn.disabled = true;
        runBtn.textContent = t.converting;
        try {
          state = await ctx.invoke<SpeakState>('convert', [source]);
          ctx.ui.toast(t.convertDone);
          render();
        } catch (err) {
          ctx.ui.toast(err instanceof Error ? err.message : String(err), 'bad');
          runBtn.disabled = false;
          runBtn.textContent = t.convertRun;
        }
      }
    }

    /** 唱歌：DiffSinger 声库与音色。 */
    /** 唱歌：声库、音色与旋律参数，写下歌词就地唱。 */
    function renderSing(pane: HTMLElement): void {
      const s = state.sing;
      const runtime = state.singRuntime;
      pane.append(field(t.engine, ctx.ui.select({ options: [{ value: 'diffsinger', label: 'DiffSinger' }], value: s.engine })));
      const banks = state.banks ?? [];
      // 配置里没选时就显示实际会用上的第一套声库，别让人以为没声库。
      const selected = s.voicebank || banks[0]?.name || '';
      const bank = banks.find((item) => item.name === selected);
      pane.append(field(t.voicebank, ctx.ui.select({
        options: [{ value: '', label: t.refNone }, ...banks.map((item) => ({ value: item.name, label: item.label }))],
        value: selected,
        onInput: (name) => {
          state.sing.voicebank = name;
          state.sing.color = '';
          save('sing.voicebank', name, true);
          save('sing.color', '', true);
          render();
        },
      })));
      const colors = bank?.colors ?? [];
      pane.append(field(t.color, ctx.ui.select({
        options: [{ value: '', label: colors.length ? '默认' : t.refNone }, ...colors.map((name) => ({ value: name, label: name }))],
        value: s.color,
        onInput: (name) => save('sing.color', name, true),
      })));
      pane.append(field(t.singBpm, slider(s.bpm, { min: 60, max: 200, step: 1 }, (v) => save('sing.bpm', v), (v) => String(v))));
      pane.append(field(t.singKey, slider(s.keyShift, { min: -12, max: 12, step: 1 }, (v) => save('sing.keyShift', v), (v) => String(v))));
      pane.append(field(t.singScale, choose([
        { value: 'major', label: { zh: t.scaleMajor, en: t.scaleMajor } },
        { value: 'minor', label: { zh: t.scaleMinor, en: t.scaleMinor } },
      ], s.scale, (v) => save('sing.scale', v, true))));
      pane.append(field(t.singSeed, numberInput(s.seed, { min: 0, max: 99999999, step: 1 }, (v) => save('sing.seed', v))));
      const convertRow = ctx.ui.rowbar();
      const convertSwitch = el('button') as HTMLButtonElement;
      convertSwitch.type = 'button';
      convertSwitch.className = s.convert ? 'aud-switch on' : 'aud-switch';
      convertSwitch.setAttribute('role', 'switch');
      convertSwitch.setAttribute('aria-checked', String(s.convert));
      convertSwitch.setAttribute('aria-label', t.singConvert);
      convertSwitch.addEventListener('click', () => {
        const next = !convertSwitch.classList.contains('on');
        convertSwitch.classList.toggle('on', next);
        convertSwitch.setAttribute('aria-checked', String(next));
        save('sing.convert', next, true);
      }, { signal: ctx.signal });
      convertRow.append(convertSwitch);
      pane.append(field(t.singConvert, convertRow));

      const lyricsBox = doc.createElement('textarea');
      lyricsBox.className = 'sp-text';
      lyricsBox.placeholder = t.singLyricsPlaceholder;
      lyricsBox.value = singLyrics;
      lyricsBox.addEventListener('input', () => { singLyrics = lyricsBox.value; }, { signal: ctx.signal });
      const singRow = ctx.ui.rowbar();
      const singBtn = ctx.ui.button(t.singRun, { size: 'sm', onClick: () => { void singNow(); } });
      singBtn.disabled = !runtime?.ready;
      singRow.append(singBtn);
      pane.append(field(t.singLyrics, lyricsBox));
      pane.append(singRow);
      if (runtime && runtime.missing?.length) {
        pane.append(el('div', 'timbre-drop', `${t.convertMissing}：${runtime.missing.join('、')}`));
      }
      const last = state.lastSing;
      if (last) {
        const lastRow = ctx.ui.rowbar();
        const seconds = last.seconds ? ` · ${last.seconds.toFixed(1)}s` : '';
        lastRow.append(el('span', 'sp-label', `${t.lastSing}：${last.voice}${seconds}`));
        lastRow.append(ctx.ui.button(t.playAgain, { size: 'sm', onClick: () => { void call('playLastSing'); } }));
        pane.append(lastRow);
      }

      async function singNow(): Promise<void> {
        const lyrics = singLyrics.trim();
        if (!lyrics) { ctx.ui.toast(t.singNeedLyrics, 'bad'); return; }
        singBtn.disabled = true;
        singBtn.textContent = t.singing;
        try {
          state = await ctx.invoke<SpeakState>('sing', [lyrics]);
          ctx.ui.toast(t.singDone);
          render();
        } catch (err) {
          ctx.ui.toast(err instanceof Error ? err.message : String(err), 'bad');
          singBtn.disabled = false;
          singBtn.textContent = t.singRun;
        }
      }
    }

    render();
  },
};
