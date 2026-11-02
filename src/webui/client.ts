/**
 * 面板入口：依赖、说话、听、音乐、播放、记录、工具。
 * 「依赖」页一行一个项目：名字 · 状态灯 · 版本（没有就是「无」）· 动作按钮；不写「可用」「已检测」这类词。
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { summarizeError, errorOverflow } from './errors.ts';
import { listenPanel } from './listen.ts';
import { queuePanel } from './queue.ts';
import { recordsPanel } from './records.ts';
import { speakPanel } from './speak.ts';
import { toolsPanel } from './tools.ts';
import { musicPanel } from './music.ts';

type Tone = 'on' | 'off' | 'plain';

interface JobStateLike {
  phase: 'absent' | 'working' | 'ready' | 'error';
  done: number;
  total: number;
  detail: string | null;
}

interface DepsState {
  gpu: {
    state: 'ok' | 'absent' | 'error';
    gpus: Array<{ index: number; name: string; vramMB: number; driver: string }>;
    tier: 'cuda' | 'cpu';
    detail: string | null;
  };
  tier: 'cuda' | 'cpu';
  uv: { path: string | null; version: string | null; source: string | null; detail: string | null };
  uvJob: JobStateLike;
  ffmpeg: { path: string | null; version: string | null; source: string | null; detail: string | null };
  ffmpegJob: JobStateLike;
  project: JobStateLike & { dir: string };
  weights: JobStateLike & { dir: string; bytes: number };
  rvc: {
    project: JobStateLike & { dir: string };
    assets: JobStateLike & { dir: string; bytes: number };
  };
  singer: { models: JobStateLike & { dir: string } };
  demucs: {
    source: JobStateLike & { dir: string };
    environment: JobStateLike & { dir: string };
    weights: JobStateLike & { dir: string };
  };
  vad: {
    silero: JobStateLike & { dir: string };
    firered: JobStateLike & { dir: string; bytes: number };
    runtime?: { ok: boolean; detail: string | null };
  };
  stt: {
    sensevoice: JobStateLike & { dir: string; bytes: number };
    paraformer: JobStateLike & { dir: string; bytes: number };
  };
  env: { gpt: JobStateLike & { dir: string }; rvc: JobStateLike & { dir: string }; stt: JobStateLike & { dir: string }; sing: JobStateLike & { dir: string } };
  installed: Record<'uv' | 'ffmpeg' | 'gpt' | 'rvc' | 'singer' | 'demucs' | 'silero' | 'firered' | 'sensevoice' | 'paraformer', boolean>;
}

const DEP_STYLE = `
.dep-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 2px; border-bottom: 1px solid rgba(128,128,128,.18); }
.dep-row:last-of-type { border-bottom: 0; }
.dep-name { min-width: 108px; font-weight: 600; }
.dep-right { flex: 1 1 auto; display: flex; gap: 12px; align-items: center; justify-content: flex-start; min-width: 0; }
.dep-value { font-size: 13px; opacity: .85; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dep-err { flex-basis: 100%; color: #b4544a; font-size: 12px; }
.dep-err-inner { display: flex; gap: 8px; align-items: center; min-width: 0; }
.dep-err-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dep-acts { flex: 0 0 auto; display: flex; gap: 8px; }
.dep-row .btn.sm { font-size: 13px; }
`;

// ---------------------------------------------------------------------------
// 依赖：一行一个项目；已获取只显示信息，未获取才出现「获取」
// ---------------------------------------------------------------------------

interface DepRow {
  value: HTMLElement;
  acts: HTMLElement;
  err: HTMLElement;
  errText: HTMLElement;
  copy: HTMLButtonElement;
  full: { text: string };
  button: HTMLButtonElement;
  uninstall: HTMLButtonElement;
}

/** 检测没回来之前显示这一句，代替「获取」。 */
const CHECKING = '识别中';

/** 卸载确认：说清删什么、留什么；删的范围只限本扩展装的。 */
const UNINSTALL: Record<string, { title: string; body: string }> = {
  uv: { title: '卸载 uv？', body: '只删本扩展下载的 uv；系统里已有的 uv 不受影响。' },
  ffmpeg: { title: '卸载 ffmpeg？', body: '只删本扩展下载的 ffmpeg；系统里已有的 ffmpeg 不受影响。' },
  gpt: { title: '卸载 GPT-SoVITS？', body: '删除源码、Python 环境与权重；参考音频和已导入的音色不受影响。' },
  rvc: { title: '卸载 RVC？', body: '删除源码、Python 环境与 ContentVec / RMVPE 资产；已导入的变声音色不受影响。' },
  singer: { title: '卸载 DiffSinger？', body: '删除绮萱声库、声码器与唱歌环境；自己放进模型目录的其它声库不受影响。' },
  demucs: { title: '卸载 Demucs 分离？', body: '删除源码、Python 环境与 ONNX 权重；已分离的音频不受影响。' },
  silero: { title: '卸载 Silero VAD？', body: '删除模型文件；正在监听的车道需要先停止。' },
  firered: { title: '卸载 FireRed VAD？', body: '删除模型文件；正在监听的车道需要先停止。' },
  sensevoice: { title: '卸载 SenseVoice？', body: '删除模型；没有 Paraformer 时连同共用的识别环境一起删除。' },
  paraformer: { title: '卸载 Paraformer？', body: '删除流式模型；没有 SenseVoice 时连同共用的识别环境一起删除。' },
};

const depsPanel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext) {
    const { ui } = ctx;
    const style = ui.h('style');
    style.textContent = DEP_STYLE;
    ctx.root.append(style);

    /** 一行：名字 + 信息 + 一个平铺按钮（已获取时按钮隐藏）；装过就多一个「卸载」。 */
    const row = (name: string, label: string, method: string, dep?: string): DepRow => {
      const el = ui.h('div', 'dep-row');
      el.append(ui.h('span', 'dep-name', name));
      const right = ui.h('span', 'dep-right');
      const value = ui.h('span', 'dep-value', '');
      const acts = ui.h('span', 'dep-acts');
      const button = ui.button(label, { size: 'sm', variant: 'plain', onClick: () => void run(method) });
      const uninstall = ui.button('卸载', { size: 'sm', variant: 'plain', onClick: () => void askUninstall(dep ?? '') });
      // 检测结果回来之前只显示「识别中」，按钮先藏起来，避免误点。
      value.textContent = CHECKING;
      button.hidden = true;
      uninstall.hidden = true;
      acts.append(button, uninstall);
      right.append(value, acts);
      el.append(right);
      const err = ui.h('div', 'dep-err');
      const inner = ui.h('span', 'dep-err-inner');
      const errText = ui.h('span', 'dep-err-text');
      // 完整原文只放进剪贴板：长错误直接铺在页面上会被行宽截断，也读不懂。
      const full = { text: '' };
      const copy = ui.copyButton(() => full.text, { label: '复制错误信息', size: 'sm', variant: 'plain' });
      inner.append(errText, copy);
      err.append(inner);
      el.append(err);
      ctx.root.append(el);
      return { value, err, errText, copy, full, acts, button, uninstall };
    };

    const errorLine = ui.msgline('');
    errorLine.hidden = true;

    const gpuRow = ui.h('div', 'dep-row');
    gpuRow.append(ui.h('span', 'dep-name', '显卡'));
    const gpuRight = ui.h('span', 'dep-right');
    const gpuValue = ui.h('span', 'dep-value', CHECKING);
    gpuRight.append(gpuValue);
    gpuRow.append(gpuRight);
    ctx.root.append(gpuRow);

    const uv = row('uv', '获取', 'installUv', 'uv');
    const ff = row('ffmpeg', '获取', 'installFfmpeg', 'ffmpeg');
    const gpt = row('GPT-SoVITS', '获取', 'prepareGpt', 'gpt');
    const rvc = row('RVC', '获取', 'prepareRvc', 'rvc');
    const singer = row('DiffSinger', '获取', 'prepareSinger', 'singer');
    const demucs = row('Demucs 分离', '获取', 'prepareSeparator', 'demucs');
    const silero = row('Silero VAD', '获取', 'prepareSilero', 'silero');
    const firered = row('FireRed VAD', '获取', 'prepareFirered', 'firered');
    const sense = row('SenseVoice', '获取', 'prepareSensevoice', 'sensevoice');
    const paraformer = row('Paraformer 流式', '获取', 'prepareParaformer', 'paraformer');

    const cancelActions = ui.actions();
    const cancelBtn = ui.button('取消进行中的任务', { size: 'sm', variant: 'plain', onClick: () => void run('cancel') });
    cancelBtn.hidden = true;
    cancelActions.append(cancelBtn);
    ctx.root.append(cancelActions);
    ctx.root.append(errorLine);

    async function run(method: string, args?: unknown[]): Promise<void> {
      try {
        const state = await ctx.invoke<DepsState>(method, args);
        if (state) render(state);
      } catch (err) {
        errorLine.hidden = false;
        errorLine.textContent = err instanceof Error ? err.message : String(err);
        errorLine.classList.add('bad');
      }
    }

    /** 卸载会删目录，先问一句；确认框里说清删什么、留什么。 */
    async function askUninstall(id: string): Promise<void> {
      const ask = UNINSTALL[id];
      if (!ask) return;
      if (!(await ctx.ui.confirm({ title: ask.title, body: ask.body, danger: true }))) return;
      await run('uninstall', [id]);
    }

    /** 一步的短描述：装好给版本/「已装」，在跑给百分比（没有总量就给阶段和已下载量）。 */
    const step = (job: JobStateLike, ready: string): string => {
      if (job.phase === 'ready') return ready;
      if (job.phase === 'working') {
        if (job.total) return `${Math.min(100, Math.round((job.done / job.total) * 100))}%`;
        const mb = job.done ? ` ${(job.done / 1024 ** 2).toFixed(1)} MB` : '';
        return `${job.detail ?? '进行中'}${mb}`;
      }
      return '';
    };

    /** 第一个失败步骤的原文，前面带上是哪一步（源码 / 环境 / 权重）。 */
    const firstError = (jobs: Array<[string, JobStateLike | null]>): string => {
      for (const [label, job] of jobs) {
        if (job && job.phase === 'error' && job.detail) return `${label}：${job.detail}`;
      }
      return '';
    };

    const anyWorking = (jobs: JobStateLike[]): boolean => jobs.some((job) => job.phase === 'working');
    const allReady = (jobs: JobStateLike[]): boolean => jobs.every((job) => job.phase === 'ready');

    function fill(entry: DepRow, value: string, err: string, opts: { done: boolean; working: boolean; extra?: boolean; installed?: boolean }): void {
      entry.value.textContent = value;
      // 值区为空时整个藏掉，flex 的 12px 间距也跟着消失；再把按钮盒子左移它自己的 12px 内边距，
      // 「获取」的字形就和上面「已装」「0.13.6」落在同一条左边缘上。
      entry.value.hidden = !value;
      entry.acts.style.marginLeft = value ? '' : '-12px';
      entry.full.text = err;
      entry.errText.textContent = err ? summarizeError(err) : '';
      entry.copy.hidden = !errorOverflow(err);
      entry.err.hidden = !err;
      entry.button.hidden = opts.done;
      entry.button.disabled = opts.done || opts.working || opts.extra === true;
      // 装过（哪怕装坏了只留下半个目录）才给卸载；任务在跑时先禁用，避免删到正在写的文件。
      entry.uninstall.hidden = !opts.installed;
      entry.uninstall.disabled = opts.working;
    }

    function render(state: DepsState): void {
      const gpus = state.gpu.gpus;
      gpuValue.textContent = state.gpu.state === 'ok' && gpus.length
        ? `${gpus.map((gpu) => `${gpu.name.replace(/^NVIDIA\s+/i, '')} ${(gpu.vramMB / 1024).toFixed(0)}GB`).join(' · ')} · ${gpus[0].driver}`
        : '无';

      fill(uv, state.uv.version ?? (state.uvJob.phase === 'working' ? '获取中…' : ''),
        state.uvJob.phase === 'error' ? state.uvJob.detail ?? '' : '',
        { done: !!state.uv.version, working: state.uvJob.phase === 'working', installed: state.installed.uv });

      fill(ff, state.ffmpeg.version ?? (state.ffmpegJob.phase === 'working' ? '获取中…' : ''),
        state.ffmpegJob.phase === 'error' ? state.ffmpegJob.detail ?? '' : '',
        { done: !!state.ffmpeg.version, working: state.ffmpegJob.phase === 'working', installed: state.installed.ffmpeg });


      const gptJobs = [state.project, state.env.gpt, state.weights];
      fill(gpt,
        [state.project.phase === 'ready' ? '源码 已装' : '', state.env.gpt.phase === 'ready' ? '环境 已装' : '', state.weights.phase === 'ready' ? '权重 已装' : '', state.project.phase === 'working' ? step(state.project, '') : '', state.env.gpt.phase === 'working' ? step(state.env.gpt, '') : '', state.weights.phase === 'working' ? step(state.weights, '') : ''].filter(Boolean).join(' · '),
        firstError([['源码', state.project], ['环境', state.env.gpt], ['权重', state.weights]]),
        { done: allReady(gptJobs), working: anyWorking(gptJobs), installed: state.installed.gpt });

      const rvcJobs = [state.rvc.project, state.env.rvc, state.rvc.assets];
      fill(rvc,
        [state.rvc.project.phase === 'ready' ? '源码 已装' : '', state.env.rvc.phase === 'ready' ? '环境 已装' : '', state.rvc.assets.phase === 'ready' ? '资产 已装' : '', state.rvc.project.phase === 'working' ? step(state.rvc.project, '') : '', state.env.rvc.phase === 'working' ? step(state.env.rvc, '') : '', state.rvc.assets.phase === 'working' ? step(state.rvc.assets, '') : ''].filter(Boolean).join(' · '),
        firstError([['源码', state.rvc.project], ['环境', state.env.rvc], ['资产', state.rvc.assets]]),
        { done: allReady(rvcJobs), working: anyWorking(rvcJobs), installed: state.installed.rvc });

      const singJobs = [state.singer.models, state.env.sing];
      fill(singer,
        [state.singer.models.phase === 'ready' ? '声库 已装' : step(state.singer.models, ''), state.env.sing.phase === 'ready' ? '环境 已装' : step(state.env.sing, '')].filter(Boolean).join(' · '),
        firstError([['声库', state.singer.models], ['环境', state.env.sing]]),
        { done: allReady(singJobs), working: anyWorking(singJobs), installed: state.installed.singer });

      const demucsStages: Array<[string, JobStateLike]> = [['源码', state.demucs.source], ['环境', state.demucs.environment], ['权重', state.demucs.weights]];
      const demucsJobs = demucsStages.map(([, job]) => job);
      fill(demucs, demucsStages.map(([label, job]) => job.phase === 'ready' ? `${label} 已装` : job.phase === 'working' ? `${label} ${step(job, '')}` : '').filter(Boolean).join(' · '),
        firstError(demucsStages), { done: allReady(demucsJobs), working: anyWorking(demucsJobs), installed: state.installed.demucs });

      fill(silero, step(state.vad.silero, '已装'), firstError([['模型', state.vad.silero]]),
        { done: state.vad.silero.phase === 'ready', working: state.vad.silero.phase === 'working', installed: state.installed.silero });

      const fireredRuntime = state.vad.runtime;
      const fireredValue = state.vad.firered.phase !== 'ready'
        ? step(state.vad.firered, '')
        : fireredRuntime && !fireredRuntime.ok ? '模型 已装 · 运行库缺失' : '已装';
      fill(firered, fireredValue, firstError([['模型', state.vad.firered]])
        || (fireredRuntime && !fireredRuntime.ok ? `运行库：${fireredRuntime.detail ?? 'onnxruntime-node 加载失败'}` : ''),
        { done: state.vad.firered.phase === 'ready', working: state.vad.firered.phase === 'working', installed: state.installed.firered });

      const svJobs = [state.stt.sensevoice, state.env.stt];
      fill(sense,
        [state.stt.sensevoice.phase === 'ready' ? '模型 已装' : step(state.stt.sensevoice, ''), state.env.stt.phase === 'ready' ? '环境 已装' : step(state.env.stt, '')].filter(Boolean).join(' · '),
        firstError([['模型', state.stt.sensevoice], ['环境', state.env.stt]]),
        { done: allReady(svJobs), working: anyWorking(svJobs), installed: state.installed.sensevoice });

      fill(paraformer, step(state.stt.paraformer, '已装'), firstError([['模型', state.stt.paraformer]]),
        { done: state.stt.paraformer.phase === 'ready', working: state.stt.paraformer.phase === 'working', installed: state.installed.paraformer });

      const all = [state.uvJob, state.ffmpegJob, state.project, state.env.gpt, state.weights,
        state.rvc.project, state.env.rvc, state.rvc.assets, state.singer.models, state.env.sing, state.vad.silero,
        state.vad.firered, state.stt.sensevoice, state.env.stt, state.stt.paraformer, ...demucsJobs];
      cancelBtn.hidden = !all.some((job) => job.phase === 'working');
    }

    async function refresh(): Promise<void> {
      try {
        render(await ctx.invoke<DepsState>('state'));
      } catch {
        // 轮询失败留给下一次；手动操作另有错误行。
      }
    }

    await refresh();
    ctx.interval(() => void refresh(), 1000);
  },
};

const bundle: WebUiClientBundle = {
  panels: {
    speak: speakPanel,
    music: musicPanel,
    queue: queuePanel,
    records: recordsPanel,
    listen: listenPanel,
    tools: toolsPanel,
    deps: depsPanel,
  },
};

export default bundle;
