/**
 * 「听」页：照听觉的「来源」页——一行一路声音（系统声音 / 麦克风 / 正在出声的应用），
 * 勾选即监听（记录到 lanes.json），右侧选这一路的处理方式；下面是默认处理参数与转文本设置。
 */
import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { recordsSection } from './records.ts';

type Lang = 'zh' | 'en';

interface Lane {
  id: string;
  vad: string;
}

interface AppRow {
  id: string;
  name: string;
  pid: number;
  title: string;
}

interface ListenState {
  listen: {
    vad: {
      kind: string;
      threshold: number;
      thresholdDb: number;
      minSpeechMs: number;
      minSilenceMs: number;
      maxUtteranceMs: number;
      minUtteranceMs: number;
    };
    transcribe: boolean;
    deliver: string;
    classify?: string;
  };
  stt: {
    engine: string;
    langHint: string;
    context: string;
    sampleRate: number;
    maxMb: number;
    sensevoice: { modelDir: string };
    moonshine: { modelDir: string };
    dashscope: { baseUrl: string; model: string; apiKeySecret: string; itn: boolean; keepDialect: boolean };
    openai: { baseUrl: string; model: string; apiKeySecret: string };
  };
  secrets: { dashscope: boolean; openai: boolean };
  lanes: Lane[];
  runtime?: {
    module: { ok: boolean; error: string };
    listening: boolean;
    paused: boolean;
    lanes: RuntimeLane[];
    silero: { path: string; exists: boolean };
    stream?: { engine: string; dir: string; ready: boolean };
    aed?: { ready: boolean };
  };
}

interface RuntimeLane {
  id: string;
  vad: string;
  listening: boolean;
  level: number;
  active: boolean;
  chunks: number;
  error: string;
}

interface LevelsFrame {
  t: 'levels';
  listening: boolean;
  paused: boolean;
  lanes: Array<{ id: string; level: number; active: boolean; listening: boolean; error: string }>;
}

interface AppsResp {
  apps: AppRow[];
  error: string | null;
}

const TEXT = {
  zh: {
    system: '系统声音',
    systemSub: '整个系统的输出',
    mic: '麦克风',
    micSub: '本机麦克风输入',
    appsTitle: '应用监听',
    loading: '正在读取…',
    noApps: '现在没有应用在出声。',
    addLabel: '应用（进程名或 PID）',
    add: '添加',
    addPlaceholder: 'chrome.exe / 1234',
    vadDefault: '跟随默认',
    defaultVad: '默认切分',
    listenNow: '监听总开关',
    listenOn: (n: number) => `${n} 路在听`,
    listenOff: '停着',
    listenNone: '没有勾选来源',
    listenBad: '采集模块不可用',
    vadKind: '处理方式',
    threshold: 'VAD 阈值',
    thresholdDb: '能量门限（dBFS）',
    minSpeech: '最短语音（毫秒）',
    minSilence: '最短静音（毫秒）',
    maxUtterance: '最长一句（毫秒）',
    minUtterance: '最短片段（毫秒）',
    transcribe: '切分后转成文字',
    classify: '细分',
    classifyNone: '不细分',
    classifyAed: '区分音乐与人声',
    classifyNote: '音乐块只写事件：不转写、不唤醒，也不留音频。',
    classifyMissingNote: 'AED 模型还没下载：去「依赖」页对「FireRed VAD」点「获取」。',
    notifyCoo: '通知 Coo',
    level: '现在的音量',
    laneError: '这一路没在听：',
    tabListen: '监听',
    tabStt: '转文本',
    tabStream: '流式转文本',
    tabRecords: '记录',
    streamUseNote: '用法：到「监听」页把某一行的切分方式切成「流式转文本」，这一路就会直连该引擎；其余来源仍按各自的切分方式走整段识别。',
    streamEngine: 'Paraformer 流式（中英）',
    streamReady: '模型 已装',
    streamMissing: '模型 未装',
    streamNote: '这一路不切分：帧直接交给引擎，引擎只负责解码；连续低于「能量门限」达到「最短静音」就算一句说完，一句一条转写记录。「最长一句」到点强切，太短的片段丢掉。',
    streamMissingNote: '模型还没下载：去「依赖」页对「Paraformer 流式」点「获取」（约 226 MB）。在那之前把某一路切成「流式转文本」，那一路会明确报缺模型。',
    legacyEngine: '配置里还是 Moonshine（已停用）：它只能离线识别，选一个引擎会写回配置。',
    engine: '引擎',
    langHint: '语言提示',
    context: '识别上下文',
    sampleRate: '采样率（0 自动）',
    maxMb: '单次上限（MB）',
    model: '模型',
    baseUrl: '接口地址',
    dashscopeBase: 'DashScope 地址',
    keyName: '密钥变量名',
    key: '密钥',
    saveKey: '保存密钥',
    keySet: '已填',
    keyMissing: '未填',
    keySaved: '密钥已写入部署 .env',
    saveFailed: '保存失败：',
    appsFailed: '读不到正在出声的应用：',
  },
  en: {
    system: 'System audio',
    systemSub: 'Everything the machine plays',
    mic: 'Microphone',
    micSub: 'Local microphone input',
    appsTitle: 'Applications',
    loading: 'Reading…',
    noApps: 'No application is playing audio.',
    addLabel: 'Application (process name or PID)',
    add: 'Add',
    addPlaceholder: 'chrome.exe / 1234',
    vadDefault: 'Default',
    defaultVad: 'Default splitter',
    listenNow: 'Listening master switch',
    listenOn: (n: number) => `${n} source${n === 1 ? '' : 's'} live`,
    listenOff: 'stopped',
    listenNone: 'nothing checked',
    listenBad: 'capture module unavailable',
    vadKind: 'Processing',
    threshold: 'VAD threshold',
    thresholdDb: 'Energy gate (dBFS)',
    minSpeech: 'Min speech (ms)',
    minSilence: 'Min silence (ms)',
    maxUtterance: 'Max utterance (ms)',
    minUtterance: 'Min chunk (ms)',
    transcribe: 'Transcribe after cutting',
    classify: 'Split by content',
    classifyNone: 'No',
    classifyAed: 'Music vs voice',
    classifyNote: 'Music chunks raise the event only: no transcription, no wake, no audio kept.',
    classifyMissingNote: 'AED model missing: press Get on "FireRed VAD" on the Dependencies page.',
    notifyCoo: 'Notify Coo',
    level: 'Live level',
    laneError: 'Not listening: ',
    tabListen: 'Listen',
    tabStt: 'Transcription',
    tabStream: 'Streaming',
    tabRecords: 'Records',
    streamUseNote: 'Usage: on the Listen tab set a source splitter to Streaming and that lane feeds this engine directly; other sources keep their own splitter and use the chunk engine.',
    streamEngine: 'Paraformer streaming (zh/en)',
    streamReady: 'model installed',
    streamMissing: 'model missing',
    streamNote: 'No splitting: frames go straight to the engine, which only decodes. A sentence ends when the level stays under the energy gate for the min silence, one record per sentence with its text. Max utterance hard-cuts; very short pieces are dropped.',
    streamMissingNote: 'Model not downloaded: press Get on "Paraformer streaming" on the Dependencies page (~226 MB). Until then a Streaming source reports the missing model.',
    legacyEngine: 'Config still says Moonshine (retired): it is offline-only; picking an engine writes it back.',
    engine: 'Engine',
    langHint: 'Language hint',
    context: 'Context',
    sampleRate: 'Sample rate (0 = auto)',
    maxMb: 'Size limit (MB)',
    model: 'Model',
    baseUrl: 'Base URL',
    dashscopeBase: 'DashScope base URL',
    keyName: 'Secret name',
    key: 'Secret',
    saveKey: 'Save secret',
    keySet: 'set',
    keyMissing: 'missing',
    keySaved: 'Secret written to the deployment .env',
    saveFailed: 'Save failed: ',
    appsFailed: 'Cannot list audio apps: ',
  },
} as const;

type Tab = 'listen' | 'stt' | 'stream' | 'records';

/** 二级页签跨挂载保留：切走再回来还在原页。 */
let activeTab: Tab = 'listen';

const ENGINES = [
  { value: 'sensevoice', label: { zh: '本机 SenseVoice', en: 'Local SenseVoice' } },
  { value: 'dashscope', label: { zh: 'HTTP · DashScope', en: 'HTTP · DashScope' } },
  { value: 'dashscope-async', label: { zh: 'HTTP · DashScope 文件转写', en: 'HTTP · DashScope file transcription' } },
  { value: 'openai', label: { zh: 'HTTP · OpenAI 兼容', en: 'HTTP · OpenAI-compatible' } },
] as const;

const VADS = [
  { value: '', label: { zh: '跟随默认', en: 'Default' } },
  { value: 'energy', label: { zh: '能量门限切分', en: 'Energy gate splitting' } },
  { value: 'silero', label: { zh: 'Silero VAD', en: 'Silero VAD' } },
  { value: 'firered', label: { zh: 'FireRed VAD', en: 'FireRed VAD' } },
  { value: 'stream', label: { zh: '流式转文本', en: 'Streaming' } },
] as const;

const SRC_STYLE = `
.aud-src { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 4px; max-width: 900px; }
.aud-src-row { display: grid; grid-template-columns: auto minmax(0, 1fr) 88px 150px; gap: 10px; align-items: center; border: 1px solid rgba(128,128,128,.28); border-radius: 10px; padding: 8px 10px; }
.aud-src-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.aud-src-name > b { font-weight: 600; }
.aud-src-sub { font-size: 11px; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aud-meter { height: 6px; border-radius: 3px; background: rgba(128,128,128,.2); overflow: hidden; }
.aud-meter > i { display: block; height: 100%; width: 0; background: var(--accent, #5b7cfa); opacity: .5; transition: width .12s linear; }
.aud-meter.on > i { opacity: 1; }
.aud-switch { position: relative; flex: 0 0 auto; width: 36px; height: 20px; border: 0; padding: 0; border-radius: 10px; background: rgba(128,128,128,.38); cursor: pointer; transition: background .15s; }
.aud-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
.aud-switch.on { background: var(--accent, #5b7cfa); }
.aud-switch.on::after { transform: translateX(16px); }
.aud-switch:focus-visible { outline: 2px solid var(--accent, #5b7cfa); outline-offset: 2px; }
.aud-src-error { grid-column: 2 / -1; font-size: 11px; line-height: 1.5; color: #d9534f; opacity: .9; word-break: break-word; }
.aud-note { font-size: 12px; line-height: 1.6; opacity: .7; margin: 2px 0 4px; }
.aud-tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid rgba(128,128,128,.25); margin: 4px 0 12px; max-width: 900px; }
.aud-tab { font: inherit; font-size: 13px; background: none; border: 0; color: inherit; opacity: .62; padding: 6px 10px 8px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.aud-tab:hover { opacity: .85; }
.aud-tab.on { opacity: 1; font-weight: 600; border-bottom-color: var(--accent, #5b7cfa); }
.aud-src-add { display: flex; gap: 8px; align-items: center; margin-top: 8px; max-width: 900px; }
.aud-src-add input { flex: 1; }
.aud-apps { max-width: 900px; margin: 10px 0 4px; border: 1px solid rgba(128,128,128,.3); border-radius: 10px; }
.aud-apps-summary { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; }
.aud-apps-title { font-weight: 600; }
.aud-apps-count { margin-left: auto; font-size: 11px; opacity: .65; }
.aud-apps-body { padding: 0 12px 12px; }
.aud-apps-loading, .aud-apps-empty { font-size: 12px; opacity: .6; padding: 6px 2px; }
.sp-row { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 10px; align-items: center; margin: 6px 0; max-width: 900px; }
.sp-label { font-size: 12px; opacity: .75; }
.sp-slider { display: flex; gap: 10px; align-items: center; }
.sp-slider input[type=range] { flex: 1 1 auto; }
.sp-value { width: 72px; text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; }
`;

export const listenPanel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext) {
    const lang: Lang = ctx.language?.startsWith('zh') ? 'zh' : 'en';
    const t = TEXT[lang];
    const doc = ctx.root.ownerDocument;
    let state = await ctx.invoke<ListenState>('state');
    let pending: { dispose(): void } | null = null;
    /** 应用列表按需读：折叠着就不枚举（PowerShell 扫会话要半秒左右）。 */
    let expanded = false;
    let appList: AppRow[] | null = null;
    let appErr: string | null = null;
    let loadingApps = false;
    /** 电平条：按车道 id 登记，10Hz 的推送只改这里，不重建 DOM。 */
    const meters = new Map<string, { bar: HTMLElement; wrap: HTMLElement }>();
    let lastLevels: LevelsFrame | null = null;
    let streamLive = false;

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
    /** 滑动条 + 右侧可编辑读数（与说话页同一个控件）。 */
    const slider = (value: number, opts: { min: number; max: number; step: number }, onChange: (v: number) => void, format: (v: number) => string): HTMLElement => {
      const wrap = el('div', 'sp-slider');
      const input = doc.createElement('input');
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
        commit(Number(readout.value));
        readout.value = format(Number(input.value));
      }, { signal: ctx.signal });
      wrap.append(input, readout);
      return wrap;
    };
    const textInput = (value: string, onInput: (v: string) => void): HTMLInputElement => ctx.ui.input({ value, onInput });
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
    const check = (checked: boolean, onChange: (v: boolean) => void): HTMLElement => ctx.ui.checkbox('', { checked, onChange }).el;
    /** 总开关：真开关（role=switch），不用勾选框。 */
    const toggle = (checked: boolean, label: string, onChange: (v: boolean) => void): HTMLButtonElement => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = checked ? 'aud-switch on' : 'aud-switch';
      btn.setAttribute('role', 'switch');
      btn.setAttribute('aria-checked', String(checked));
      btn.setAttribute('aria-label', label);
      btn.title = label;
      btn.addEventListener('click', () => {
        const next = !btn.classList.contains('on');
        btn.classList.toggle('on', next);
        btn.setAttribute('aria-checked', String(next));
        onChange(next);
      }, { signal: ctx.signal });
      return btn;
    };
    const runtimeLane = (id: string): RuntimeLane | undefined => state.runtime?.lanes?.find((lane) => lane.id === id);
    /** dBFS → 条的宽度；-60 以下当没有声音。 */
    const pct = (db: number): number => Math.min(100, Math.max(0, ((db + 60) / 60) * 100));
    const applyLevels = (frame: LevelsFrame | null): void => {
      if (!frame) return;
      for (const lane of frame.lanes) {
        const meter = meters.get(lane.id);
        if (!meter) continue;
        meter.bar.style.width = `${pct(lane.level).toFixed(1)}%`;
        meter.wrap.classList.toggle('on', lane.active);
        meter.wrap.title = `${t.level} ${Math.round(lane.level)} dBFS`;
      }
    };
    const choose = <T extends readonly { value: string; label: Record<Lang, string> }[]>(options: T, value: string, onChange: (v: string) => void): HTMLSelectElement =>
      ctx.ui.select({ options: options.map((option) => ({ value: option.value, label: option.label[lang] })), value, onInput: onChange });
    const keyRow = (kind: 'dashscope' | 'openai'): HTMLElement => {
      const row = ctx.ui.rowbar();
      const input = ctx.ui.input({ type: 'password', placeholder: t.key });
      const dot = ctx.ui.pill(state.secrets[kind] ? t.keySet : t.keyMissing, state.secrets[kind] ? 'on' : 'off');
      const name = kind === 'dashscope' ? state.stt.dashscope.apiKeySecret : state.stt.openai.apiKeySecret;
      row.append(input, ctx.ui.button(t.saveKey, {
        size: 'sm',
        onClick: async () => {
          const value = input.value.trim();
          if (!value) return;
          try {
            state = await ctx.invoke<ListenState>('saveSecret', [name, value]);
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

    const style = el('style');
    style.textContent = SRC_STYLE;
    ctx.root.append(style);

    const root = el('section');
    ctx.root.append(root);

    async function call(method: string, args: unknown[] = []): Promise<void> {
      try {
        state = await ctx.invoke<ListenState>(method, args);
        render();
      } catch (err) {
        ctx.ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    }

    /** 旧状态里没有 lanes 就当空表，别让面板挂掉。 */
    const lanes = (): Lane[] => state.lanes ?? [];

    function laneOf(id: string): Lane | undefined {
      return lanes().find((lane) => lane.id === id);
    }

    /** 读一次正在出声的应用；内容没变就不重绘。 */
    async function loadApps(): Promise<void> {
      if (loadingApps) return;
      loadingApps = true;
      try {
        const resp = await ctx.invoke<AppsResp>('apps');
        const next = resp?.apps ?? [];
        const error = resp?.error ?? null;
        const same = JSON.stringify([next, error]) === JSON.stringify([appList, appErr]);
        appList = next;
        appErr = error;
        if (!same) render();
      } catch (err) {
        appErr = err instanceof Error ? err.message : String(err);
        appList = [];
        render();
      } finally {
        loadingApps = false;
      }
    }

    function sourceRow(id: string, name: string, sub: string): HTMLElement {
      const row = el('div', 'aud-src-row');
      const lane = laneOf(id);
      const runtime = runtimeLane(id);
      row.append(check(!!lane, (checked) => {
        if (checked) void call('setLane', [id, laneOf(id)?.vad ?? '']);
        else void call('removeLane', [id]);
      }));
      const label = el('div', 'aud-src-name');
      label.append(el('b', '', name), el('div', 'aud-src-sub', sub));
      row.append(label);
      const meter = el('div', 'aud-meter');
      const bar = el('i');
      bar.style.width = `${pct(runtime?.level ?? -100).toFixed(1)}%`;
      meter.append(bar);
      meter.title = `${t.level} ${Math.round(runtime?.level ?? -100)} dBFS`;
      meter.classList.toggle('on', Boolean(runtime?.active));
      meters.set(id, { bar, wrap: meter });
      row.append(meter);
      row.append(choose(VADS, lane?.vad ?? '', (vad) => {
        if (laneOf(id)) void call('setLane', [id, vad]);
      }));
      if (runtime?.error) row.append(el('div', 'aud-src-error', `${t.laneError}${runtime.error}`));
      return row;
    }

    /** 四个页签：监听 / 转文本 / 流式转文本 / 记录（转写）。 */
    const TABS: ReadonlyArray<[Tab, string]> = [['listen', t.tabListen], ['stt', t.tabStt], ['stream', t.tabStream], ['records', t.tabRecords]];
    // 转写记录作为二级页签挂在这里；只挂一次，切页签只移动节点。
    const recordsPane = el('div');
    let recordsMounted = false;

    function render(): void {
      if (ctx.signal.aborted) return;
      root.replaceChildren();
      meters.clear();

      const bar = el('div', 'aud-tabs');
      bar.setAttribute('role', 'tablist');
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
          render();
        }, { signal: ctx.signal });
        bar.append(btn);
      }
      root.append(bar);

      if (activeTab === 'listen') renderListen();
      else if (activeTab === 'stt') renderStt();
      else if (activeTab === 'stream') renderStream();
      else {
        if (!recordsMounted) {
          recordsMounted = true;
          const sub = {
            ...ctx,
            root: recordsPane,
            invoke: (method: string, args?: unknown[]) => (method === 'setConfigValue'
              ? ctx.invoke(method, args)
              : ctx.invoke('transcripts', [method, ...(args ?? []).slice(1)])),
          } as unknown as WebUiPanelContext;
          void recordsSection('transcripts').mount(sub);
        }
        root.append(recordsPane);
      }
      applyLevels(lastLevels);
    }

    /** 监听：来源、总开关与切分参数。 */
    function renderListen(): void {
      const list = el('div', 'aud-src');
      list.append(sourceRow('system', t.system, t.systemSub));
      list.append(sourceRow('mic', t.mic, t.micSub));
      root.append(list);

      const known = new Set(['system', 'mic']);
      const card = el('details', 'aud-apps') as HTMLDetailsElement;
      card.open = expanded;
      const summary = el('summary', 'aud-apps-summary');
      summary.append(el('span', 'aud-apps-title', t.appsTitle));
      if (appList) summary.append(el('span', 'aud-apps-count', `${appList.length}`));
      card.append(summary);
      card.addEventListener('toggle', () => {
        if (card.open === expanded) return;
        expanded = card.open;
        if (expanded) {
          render();
          void loadApps();
        }
      }, { signal: ctx.signal });
      if (expanded) {
        const body = el('div', 'aud-apps-body');
        const rows = el('div', 'aud-src');
        if (!appList) {
          rows.append(el('div', 'aud-apps-loading', t.loading));
        } else if (!appList.length) {
          rows.append(el('div', 'aud-apps-empty', t.noApps));
        }
        for (const app of appList ?? []) {
          known.add(app.id);
          const sub = [app.title, `PID ${app.pid}`].filter(Boolean).join(' · ');
          rows.append(sourceRow(app.id, app.name, sub));
        }
        // 之前手动加过、但现在没在出声的，保留一行，方便取消。
        for (const lane of lanes()) {
          if (known.has(lane.id)) continue;
          known.add(lane.id);
          rows.append(sourceRow(lane.id, lane.id.replace(/^app:/, ''), lane.id.startsWith('app:') ? '' : lane.id));
        }
        body.append(rows);

        const add = el('div', 'aud-src-add');
        const input = textInput('', () => {});
        input.placeholder = t.addPlaceholder;
        add.append(input, ctx.ui.button(t.add, {
          size: 'sm',
          onClick: () => {
            const text = input.value.trim();
            if (text) void call('addApp', [text]).then(() => loadApps());
          },
        }));
        body.append(field(t.addLabel, add));
        if (appErr) body.append(ctx.ui.msgline(`${t.appsFailed}${appErr}`, true));
        card.append(body);
      }
      root.append(card);

      const runtime = state.runtime;
      const live = runtime ? runtime.lanes.filter((lane) => lane.listening).length : 0;
      const master = ctx.ui.rowbar();
      master.append(
        toggle(live > 0, t.listenNow, (on) => { void call(on ? 'start' : 'stop'); }),
        el('span', 'aud-src-sub', !runtime
          ? ''
          : !runtime.module.ok
            ? `${t.listenBad}：${runtime.module.error}`
            : live
              ? t.listenOn(live)
              : runtime.paused
                ? t.listenOff
                : t.listenNone),
      );
      root.append(field(t.listenNow, master));

      const notify = state.listen.deliver === 'notify';
      root.append(field(t.notifyCoo, toggle(notify, t.notifyCoo, (on) => {
        state.listen.deliver = on ? 'notify' : 'record';
        save('listen.deliver', state.listen.deliver, true);
      })));

      const vad = state.listen.vad;
      root.append(field(t.vadKind, choose(VADS.slice(1), vad.kind, (v) => {
        vad.kind = v;
        save('listen.vad.kind', v, true);
        render();
      })));
      // 流式转文本不切分：切分参数都不显示。
      if (vad.kind !== 'stream') {
        if (vad.kind === 'energy') {
          root.append(field(t.thresholdDb, numberInput(vad.thresholdDb ?? -42, { min: -80, max: -10, step: 1 }, (v) => save('listen.vad.thresholdDb', v))));
        } else {
          root.append(field(t.threshold, slider(vad.threshold, { min: 0, max: 1, step: 0.01 }, (v) => save('listen.vad.threshold', v), (v) => v.toFixed(2))));
        }
        root.append(field(t.minSpeech, numberInput(vad.minSpeechMs ?? 250, { min: 50, max: 2000, step: 10 }, (v) => save('listen.vad.minSpeechMs', v))));
        root.append(field(t.minSilence, numberInput(vad.minSilenceMs, { min: 100, max: 5000, step: 50 }, (v) => save('listen.vad.minSilenceMs', v))));
        root.append(field(t.maxUtterance, numberInput(vad.maxUtteranceMs, { min: 2000, max: 120000, step: 500 }, (v) => save('listen.vad.maxUtteranceMs', v))));
        root.append(field(t.minUtterance, numberInput(vad.minUtteranceMs ?? 400, { min: 100, max: 5000, step: 50 }, (v) => save('listen.vad.minUtteranceMs', v))));
      }

      // 流式转文本不切分，也就没有按块细分的对象。
      if (vad.kind !== 'stream') {
        const classify = state.listen.classify === 'aed' ? 'aed' : 'none';
        root.append(field(t.classify, choose([
          { value: 'none', label: { zh: t.classifyNone, en: t.classifyNone } },
          { value: 'aed', label: { zh: t.classifyAed, en: t.classifyAed } },
        ], classify, (v) => {
          state.listen.classify = v === 'aed' ? 'aed' : 'none';
          save('listen.classify', state.listen.classify, true);
          render();
        })));
        if (classify === 'aed') {
          root.append(el('div', 'aud-note', t.classifyNote));
          if (state.runtime && !state.runtime.aed?.ready) root.append(el('div', 'aud-note', t.classifyMissingNote));
        }
      }
    }

    /** 转文本：切后转不转，以及整段识别的引擎。 */
    function renderStt(): void {
      root.append(field(t.transcribe, toggle(state.listen.transcribe !== false, t.transcribe, (v) => save('listen.transcribe', v, true))));

      const legacy = state.stt.engine === 'moonshine';
      root.append(field(t.engine, choose(ENGINES, legacy ? 'sensevoice' : state.stt.engine, (v) => {
        state.stt.engine = v;
        save('stt.engine', v, true);
        render();
      })));
      if (legacy) root.append(el('div', 'aud-note', t.legacyEngine));
      root.append(field(t.langHint, textInput(state.stt.langHint, (v) => save('stt.langHint', v))));
      root.append(field(t.context, textInput(state.stt.context, (v) => save('stt.context', v))));
      root.append(field(t.sampleRate, numberInput(state.stt.sampleRate, { min: 0, max: 48000, step: 1000 }, (v) => save('stt.sampleRate', v))));
      root.append(field(t.maxMb, numberInput(state.stt.maxMb, { min: 1, max: 50, step: 1 }, (v) => save('stt.maxMb', v))));
      if (state.stt.engine === 'dashscope' || state.stt.engine === 'dashscope-async') {
        root.append(field(t.dashscopeBase, textInput(state.stt.dashscope.baseUrl, (v) => save('stt.dashscope.baseUrl', v))));
        root.append(field(t.model, textInput(state.stt.dashscope.model, (v) => save('stt.dashscope.model', v))));
        root.append(field(t.keyName, textInput(state.stt.dashscope.apiKeySecret, (v) => save('stt.dashscope.apiKeySecret', v))));
        root.append(field(t.key, keyRow('dashscope')));
        if (state.stt.engine === 'dashscope') {
          root.append(ctx.ui.checkbox('数字/日期规范化', { checked: state.stt.dashscope.itn, onChange: (v) => save('stt.dashscope.itn', v, true) }).el);
          root.append(ctx.ui.checkbox('保留方言', { checked: state.stt.dashscope.keepDialect, onChange: (v) => save('stt.dashscope.keepDialect', v, true) }).el);
        }
      } else if (state.stt.engine === 'openai') {
        root.append(field(t.baseUrl, textInput(state.stt.openai.baseUrl, (v) => save('stt.openai.baseUrl', v))));
        root.append(field(t.model, textInput(state.stt.openai.model, (v) => save('stt.openai.model', v))));
        root.append(field(t.keyName, textInput(state.stt.openai.apiKeySecret, (v) => save('stt.openai.apiKeySecret', v))));
        root.append(field(t.key, keyRow('openai')));
      }
    }

    /** 流式转文本：本机 Paraformer 流式引擎的状态与用法。 */
    function renderStream(): void {
      const streamReady = state.runtime?.stream?.ready === true;
      const head = ctx.ui.rowbar();
      head.append(
        el('b', '', t.streamEngine),
        ctx.ui.pill(streamReady ? t.streamReady : t.streamMissing, streamReady ? 'on' : 'off'),
      );
      root.append(field(t.engine, head));
      root.append(el('div', 'aud-note', streamReady ? t.streamNote : t.streamMissingNote));
      root.append(el('div', 'aud-note', t.streamUseNote));
    }

    render();

    /** 轮询比较用的签名：电平、帧数这类每 100ms 都在变的不算「状态变了」，免得白重建 DOM。 */
    const signature = (next: ListenState): string => JSON.stringify({
      listen: next.listen,
      stt: next.stt,
      secrets: next.secrets,
      lanes: next.lanes,
      runtime: next.runtime
        ? {
          module: next.runtime.module,
          listening: next.runtime.listening,
          paused: next.runtime.paused,
          silero: next.runtime.silero,
          lanes: next.runtime.lanes.map((lane) => [lane.id, lane.vad, lane.listening, lane.chunks, lane.error]),
        }
        : null,
    });

    // 电平走推送：连上就不轮询；连不上（旧宿主/测试）退回 400ms 轮询。
    const streamFn = (ctx as unknown as {
      stream?: (handlers: { message(text: string): void; open?(): void; close?(retry: boolean): void }) => { dispose(): void };
    }).stream;
    if (typeof streamFn === 'function' && typeof ctx.own === 'function') {
      const handle = streamFn.call(ctx, {
        message: (text: string) => {
          let frame: unknown;
          try {
            frame = JSON.parse(text);
          } catch {
            return;
          }
          const data = frame as { t?: string };
          if (data?.t === 'state') {
            void refresh();
            return;
          }
          lastLevels = frame as LevelsFrame;
          applyLevels(lastLevels);
        },
        open: () => {
          streamLive = true;
        },
        close: () => {
          streamLive = false;
        },
      });
      ctx.own(handle);
    }
    ctx.interval(() => {
      if (streamLive || ctx.signal.aborted) return;
      void ctx.invoke<Omit<LevelsFrame, 't'>>('levels').then((frame) => {
        lastLevels = { t: 'levels', ...frame };
        applyLevels(lastLevels);
      }).catch(() => {});
    }, 400);

    async function refresh(): Promise<void> {
      try {
        state = await ctx.invoke<ListenState>('state');
        render();
      } catch {
        // 面板随手重连；失败就等下一次。
      }
    }
    ctx.interval(() => {
      if (document.activeElement !== doc.body) return;
      void ctx.invoke<ListenState>('state').then((next) => {
        // 没变就别重建 DOM（会和勾选/下拉抢焦点）。
        if (signature(next) === signature(state)) return;
        state = next;
        render();
      }).catch(() => {});
    }, 3000);
    // 展开时跟着刷新应用列表；折叠着不碰 PowerShell。
    ctx.interval(() => {
      if (expanded && document.activeElement === doc.body) void loadApps();
    }, 5000);
  },
};
