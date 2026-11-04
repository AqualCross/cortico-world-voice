import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { JobState } from '../jobs.ts';
import type { MixTrack, MusicTask } from '../music-process.ts';
import abcBundle from './abc/panels.js';

type Tab = 'separate' | 'mix' | 'abc' | 'records';
type AbcTab = 'scores' | 'works' | 'instruments';
interface MusicState { separator: JobState; ffmpeg: boolean; tasks: MusicTask[] }

const STYLE = `
.audio-music [hidden] { display:none!important; }
.audio-music .aud-tabs { display:flex; flex-wrap:wrap; gap:4px; border-bottom:1px solid rgba(128,128,128,.25); }
.audio-music > .aud-tabs { position:sticky; top:0; z-index:5; background:var(--background,var(--paper,#fbfbfb)); margin:0 0 12px; padding-top:4px; }
.audio-music .music-pane .aud-tabs { margin:4px 0 12px; }
.audio-music .aud-tab { font:inherit; font-size:13px; background:none; border:0; color:inherit; opacity:.62; padding:6px 10px 8px; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; }
.audio-music .aud-tab:hover { opacity:.85; }
.audio-music .aud-tab.on { opacity:1; font-weight:600; border-bottom-color:var(--accent,#5b7cfa); }
.audio-music .music-pane { min-width:0; }
.audio-music .music-row { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin:12px 0; }
.audio-music .music-path { flex:1; min-width:180px; }
.audio-music .music-track { display:grid; grid-template-columns:minmax(150px,1fr) 105px 105px auto; align-items:end; gap:10px; padding:10px 0; border-bottom:1px solid #8883; }
.audio-music .music-track label { display:grid; gap:5px; font-size:12px; }
.audio-music .music-track input { width:100%; box-sizing:border-box; }
.audio-music .music-history { margin-top:24px; }
.audio-music .music-result { padding:14px 0; border-top:1px solid #8883; }
.audio-music .music-title { font-size:13px; overflow-wrap:anywhere; }
.audio-music .music-hint { font-size:12px; opacity:.7; overflow-wrap:anywhere; }
.audio-music .music-progress { font-size:12px; margin:10px 0; overflow-wrap:anywhere; }
.audio-music audio { display:block; width:100%; margin:12px 0; }
@media(max-width:620px) { .audio-music .music-track { grid-template-columns:1fr 1fr auto; } .audio-music .music-track label:first-child { grid-column:1/-1; } }
`;

/** 每个内嵌面板有独立生命周期；切换二级页时停止试听、订阅和定时器。 */
function childContext(parent: WebUiPanelContext, root: HTMLElement, panel: AbcTab): { ctx: WebUiPanelContext; dispose(): void } {
  const controller = new AbortController(), resources = new Set<{ dispose(): void }>();
  const dispose = (): void => {
    controller.abort();
    parent.signal.removeEventListener('abort', dispose);
    for (const resource of resources) resource.dispose();
    resources.clear();
  };
  parent.signal.addEventListener('abort', dispose, { once: true });
  const own = <T extends { dispose(): void }>(resource: T): T => {
    if (controller.signal.aborted) resource.dispose(); else resources.add(resource);
    return resource;
  };
  const ctx: WebUiPanelContext = {
    ...parent, root, signal: controller.signal, panelId: panel,
    scope: { ...parent.scope, audioMusic: 'true' },
    own,
    invoke: (method, args = []) => parent.invoke('abc', [panel, method, args]),
    invokeBinary: (method, args = []) => parent.invokeBinary('abc', [panel, method, args]),
    memo: { get: (key, fallback) => parent.memo.get(`abc:${panel}:${key}`, fallback), set: (key, value) => parent.memo.set(`abc:${panel}:${key}`, value) },
    interval: (fn, ms) => own(parent.interval(() => { if (!controller.signal.aborted) fn(); }, ms)),
    timeout: (fn, ms) => own(parent.timeout(() => { if (!controller.signal.aborted) fn(); }, ms)),
    frame: (fn) => own(parent.frame((dt) => controller.signal.aborted ? false : fn(dt))),
    stream: (handlers) => own(parent.stream(handlers)),
    guardLeave: (fn) => own(parent.guardLeave(fn)),
  };
  return { ctx, dispose };
}

export const musicPanel: WebUiPanel = {
  async mount(ctx) {
    const zh = ctx.language.startsWith('zh'), doc = ctx.root.ownerDocument;
    const say = (cn: string, en: string): string => zh ? cn : en;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag); node.className = cls; node.textContent = text; return node;
    };
    const style = el('style'); style.textContent = STYLE;
    ctx.root.append(style);
    const root = el('section', 'audio-music'), tabs = el('div', 'aud-tabs'), pane = el('section', 'music-pane');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', say('音乐', 'Music'));
    root.append(tabs, pane); ctx.root.append(root);
    let state = await ctx.invoke<MusicState>('state');
    let tab = ctx.memo.get<Tab>('musicTab', 'separate');
    let nested: { dispose(): void } | null = null;
    let refreshPane: (() => void) | null = null;
    let tracks = ctx.memo.get<MixTrack[]>('mixTracks', []);
    let abcTab = ctx.memo.get<AbcTab>('abcTab', 'scores');
    const persistTracks = (): void => ctx.memo.set('mixTracks', tracks);
    const run = async (method: string, args: unknown[] = []): Promise<void> => {
      try { state = await ctx.invoke<MusicState>(method, args); if (!ctx.signal.aborted) refreshPane?.(); }
      catch (error) { ctx.ui.toast(error instanceof Error ? error.message : String(error), 'bad'); }
    };
    const button = (text: string, action: () => void | Promise<void>): HTMLButtonElement => ctx.ui.button(text, { size: 'sm', onClick: () => { void Promise.resolve().then(action).catch((error: unknown) => ctx.ui.toast(error instanceof Error ? error.message : String(error), 'bad')); } });
    const addToMix = (paths: string[]): void => {
      if (tracks.length + paths.length > 16) { ctx.ui.toast(say('最多混合 16 条音轨，请先移除部分音轨。', 'A mix supports up to 16 tracks. Remove some tracks first.'), 'bad'); return; }
      tracks = [...tracks, ...paths.map((path) => ({ path, volume: 100, delaySec: 0 }))];
      persistTracks(); void show('mix');
    };
    root.addEventListener('audio:add-to-mix', (event) => {
      const paths = (event as CustomEvent<string[]>).detail;
      if (Array.isArray(paths) && paths.every((path) => typeof path === 'string')) addToMix(paths);
    }, { signal: ctx.signal });

    const tabButtons = new Map<Tab, HTMLButtonElement>();
    for (const [id, cn, en] of [['separate', '分离', 'Separate'], ['mix', '混音', 'Mix'], ['abc', 'ABC', 'ABC'], ['records', '记录', 'Records']] as const) {
      const node = button(say(cn, en), () => show(id));
      node.className = 'aud-tab'; node.setAttribute('role', 'tab');
      node.id = `audio-music-${id}`;
      tabButtons.set(id, node); tabs.append(node);
    }
    ctx.own({ dispose: () => nested?.dispose() });

    async function show(next: Tab): Promise<void> {
      nested?.dispose(); nested = null;
      refreshPane = null; pane.replaceChildren();
      tab = next; ctx.memo.set('musicTab', tab);
      for (const [id, node] of tabButtons) {
        node.className = id === tab ? 'aud-tab on' : 'aud-tab';
        node.setAttribute('aria-selected', String(id === tab));
        node.tabIndex = id === tab ? 0 : -1;
      }
      pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', `audio-music-${tab}`);
      if (tab === 'abc') {
        const navigation = el('div', 'aud-tabs'), content = el('div');
        navigation.setAttribute('role', 'tablist'); navigation.setAttribute('aria-label', 'ABC');
        const buttons = new Map<AbcTab, HTMLButtonElement>();
        const mount = async (id: AbcTab): Promise<void> => {
          nested?.dispose(); content.replaceChildren();
          abcTab = id; ctx.memo.set('abcTab', id);
          for (const [key, node] of buttons) {
            node.className = key === id ? 'aud-tab on' : 'aud-tab';
            node.setAttribute('aria-selected', String(key === id));
            node.tabIndex = key === id ? 0 : -1;
          }
          const child = childContext(ctx, content, id);
          nested = child;
          await abcBundle.panels[id].mount(child.ctx);
        };
        for (const [id, cn, en] of [['scores', '乐谱', 'Scores'], ['works', '作品', 'Works'], ['instruments', '乐器', 'Instruments']] as const) {
          const node = button(say(cn, en), () => mount(id));
          node.className = 'aud-tab'; node.setAttribute('role', 'tab'); buttons.set(id, node); navigation.append(node);
        }
        pane.append(navigation, content);
        await mount(buttons.has(abcTab) ? abcTab : 'scores');
        return;
      }
      if (tab === 'records') {
        const controller = new AbortController(), owned: Array<{ dispose(): void }> = [];
        nested = { dispose() { controller.abort(); for (const resource of owned) resource.dispose(); } };
        const own = (dispose: () => void): void => { owned.push({ dispose }); };
        const count = el('div', 'music-hint');
        const history = el('div', 'music-history');
        const audio = el('audio'); audio.controls = true; audio.hidden = true;
        let audioUrl = '';
        own(() => { audio.pause(); audio.removeAttribute('src'); if (audioUrl) URL.revokeObjectURL(audioUrl); });
        const preview = async (task: MusicTask, index: number): Promise<void> => {
          const blob = await ctx.invokeBinary('file', [task.id, index]);
          if (controller.signal.aborted) return;
          audio.pause(); if (audioUrl) URL.revokeObjectURL(audioUrl);
          audioUrl = URL.createObjectURL(blob); audio.src = audioUrl; audio.hidden = false; await audio.play();
        };
        const kindOf = (kind: MusicTask['kind']): string => kind === 'mix' ? say('混音', 'Mix') : say('分离', 'Separate');
        let signature = '';
        const draw = (): void => {
          const tasks = state.tasks.filter((task) => task.phase === 'done');
          const next = JSON.stringify(tasks);
          if (signature === next) return;
          signature = next;
          count.textContent = tasks.length ? say(`共 ${tasks.length} 项作品`, `${tasks.length} works`) : '';
          history.replaceChildren();
          if (!tasks.length) { history.append(ctx.ui.placeholder(say('还没有分离或混音的作品。', 'No separation or mix works yet.'))); return; }
          for (const task of tasks) {
            const card = el('article', 'music-result');
            card.append(
              el('div', 'music-title', task.title),
              el('div', 'music-hint', `${kindOf(task.kind)} · ${new Date(task.createdAt).toLocaleString()}`),
            );
            for (const [index, output] of task.outputs.entries()) {
              const row = el('div', 'music-row');
              row.append(
                el('span', '', output.name),
                button(say('试听', 'Listen'), () => preview(task, index)),
                button(say('复制路径', 'Copy path'), () => navigator.clipboard.writeText(output.path)),
                button(say('加入混音', 'Add to mix'), () => addToMix([output.path])),
              );
              card.append(row, el('div', 'music-hint', output.path));
            }
            if (task.kind === 'separate') card.append(button(say('两轨加入混音', 'Mix both tracks'), () => addToMix(task.outputs.map((output) => output.path))));
            card.append(button(say('移除记录', 'Remove record'), async () => {
              if (await ctx.ui.confirm({ title: say('移除这条作品记录？', 'Remove this work record?'), body: say('已生成的音频文件仍会保留。', 'Generated audio files are kept.') })) await run('remove', [task.id]);
            }));
            history.append(card);
          }
        };
        pane.append(count, audio, history);
        refreshPane = draw;
        draw();
        return;
      }
      const progress = el('div', 'music-progress'); progress.setAttribute('role', 'status');
      const status = el('div');
      let signature = '';
      /** 本页只显示这一栏最新的任务；完成的作品统一去「记录」页看。 */
      const drawTask = (): void => {
        const task = state.tasks.find((item) => item.kind === tab);
        const next = task ? JSON.stringify(task) : '';
        if (signature === next) return;
        signature = next; status.replaceChildren();
        if (!task) return;
        if (task.phase === 'working') {
          const card = el('div', 'music-result');
          card.append(
            el('div', 'music-title', task.title),
            el('div', 'music-progress', task.detail || say('处理中', 'Working')),
            button(say('取消', 'Cancel'), () => run('cancel', [task.id])),
          );
          status.append(card);
        } else if (task.phase === 'done') {
          status.append(el('p', 'music-hint', say('已完成，可在「记录」查看。', 'Done. See Records.')));
        } else {
          const card = el('div', 'music-result');
          card.append(
            el('div', 'music-title', task.title),
            el('div', 'music-progress bad', task.detail),
            button(say('移除记录', 'Remove record'), async () => {
              if (await ctx.ui.confirm({ title: say('移除这条任务记录？', 'Remove this task record?'), body: say('已生成的音频文件仍会保留。', 'Generated audio files are kept.') })) await run('remove', [task.id]);
            }),
          );
          status.append(card);
        }
      };
      if (tab === 'separate') {
        let path = ctx.memo.get('separatePath', '');
        const row = el('div', 'music-row'), input = ctx.ui.input({ value: path, placeholder: say('歌曲文件路径', 'Song file path'), onInput: (value) => { path = value; ctx.memo.set('separatePath', value); } });
        input.classList.add('music-path'); input.setAttribute('aria-label', say('歌曲文件', 'Song file'));
        row.append(input, button(say('选择文件', 'Pick file'), async () => {
          const selected = await ctx.pickPath({ kind: 'file', extensions: ['.wav', '.mp3', '.flac', '.ogg', '.m4a'] });
          if (selected) { path = selected; input.value = path; ctx.memo.set('separatePath', path); }
        }));
        const setup = button(say('获取分离模型', 'Get separation model'), () => run('prepareSeparator'));
        const cancelSetup = button(say('取消获取', 'Cancel setup'), () => run('cancelSetup'));
        const start = button(say('分离人声与伴奏', 'Separate vocals and accompaniment'), () => run('separate', [path]));
        const actions = el('div', 'music-row'); actions.append(start, setup, cancelSetup);
        pane.append(row, actions, progress, el('p', 'music-hint', say('分离后分别保留人声和伴奏 WAV，可试听或加入混音。', 'Keeps vocals and accompaniment as separate WAV files for preview and mixing.')), status);
        refreshPane = () => {
          const ready = state.separator.phase === 'ready', working = state.separator.phase === 'working';
          setup.hidden = ready || working; cancelSetup.hidden = !working;
          start.disabled = !ready || !state.ffmpeg || state.tasks.some((task) => task.kind === 'separate' && task.phase === 'working');
          progress.textContent = !state.ffmpeg ? say('先在依赖页获取 ffmpeg。', 'Get ffmpeg in Dependencies first.') : ready ? '' : state.separator.detail || say('首次使用需获取分离模型。', 'Get the separation model before the first use.');
          drawTask();
        };
      } else {
        const list = el('div'), actions = el('div', 'music-row');
        const drawTracks = (): void => {
          list.replaceChildren();
          tracks.forEach((track, index) => {
            const row = el('div', 'music-track');
            const field = (label: string, input: HTMLInputElement): HTMLLabelElement => { const wrap = el('label', '', label); wrap.append(input); return wrap; };
            const path = ctx.ui.input({ value: track.path, onInput: (value) => { track.path = value; persistTracks(); } });
            const volume = ctx.ui.input({ type: 'number', value: String(track.volume), onInput: (value) => { track.volume = Number(value); persistTracks(); } }); volume.min = '0'; volume.max = '200';
            const delay = ctx.ui.input({ type: 'number', value: String(track.delaySec), onInput: (value) => { track.delaySec = Number(value); persistTracks(); } }); delay.min = '0'; delay.max = '3600'; delay.step = '0.01';
            row.append(field(say(`音轨 ${index + 1}`, `Track ${index + 1}`), path), field(say('音量 %', 'Volume %'), volume), field(say('延迟 秒', 'Delay sec'), delay), button(say('移除', 'Remove'), () => { tracks.splice(index, 1); persistTracks(); drawTracks(); refreshPane?.(); }));
            list.append(row);
          });
        };
        const add = button(say('添加音轨', 'Add track'), async () => {
          const path = await ctx.pickPath({ kind: 'file', extensions: ['.wav', '.mp3', '.flac', '.ogg', '.m4a'] });
          if (path) { tracks.push({ path, volume: 100, delaySec: 0 }); persistTracks(); drawTracks(); refreshPane?.(); }
        });
        const start = button(say('生成混音', 'Render mix'), () => run('mix', [tracks]));
        const clear = button(say('清空音轨', 'Clear tracks'), () => { tracks = []; persistTracks(); drawTracks(); refreshPane?.(); });
        actions.append(add, start, clear);
        pane.append(list, actions, progress, el('p', 'music-hint', say('每条音轨可独立调节音量和开始时间，输出为立体声 WAV。', 'Set each track’s level and start offset; the output is a stereo WAV.')), status);
        refreshPane = () => {
          add.disabled = tracks.length >= 16;
          start.disabled = !state.ffmpeg || !tracks.length || state.tasks.some((task) => task.kind === 'mix' && task.phase === 'working');
          progress.textContent = state.ffmpeg ? '' : say('先在依赖页获取 ffmpeg。', 'Get ffmpeg in Dependencies first.');
          drawTask();
        };
        drawTracks();
      }
      refreshPane();
    }

    await show(tabButtons.has(tab) ? tab : 'separate');
    ctx.interval(() => {
      if (ctx.signal.aborted || tab === 'abc') return;
      void ctx.invoke<MusicState>('state').then((next) => { state = next; if (!ctx.signal.aborted) refreshPane?.(); }).catch(() => {});
    }, 1000);
  },
};
