/**
 * 「记录」页：转写 / 语音 / 听觉三栏，各自照原扩展的卡片布局。
 * 只读本 World 的仓库；删除与清空按栏分开，试听走播放队列。
 */
import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface TranscriptItem {
  id: string;
  text: string;
  note: string;
  source: { kind: string; ref: string };
  model: string;
  language: string;
  seconds: number | null;
  audioBytes: number;
  createdAt: string;
}

interface ClipItem {
  id: string;
  file: string;
  path: string;
  bytes: number;
  seconds: number | null;
  text: string;
  note: string;
  voice: string;
  model: string;
  createdAt: string;
}

interface Section<T> {
  count: number;
  items: T[];
}

interface RecordsState {
  transcripts: Section<TranscriptItem>;
  clips: Section<ClipItem>;
}

type Kind = 'transcripts' | 'clips';

const STYLE = `
.rec-tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid rgba(128,128,128,.25); margin: 4px 0 12px; }
.rec-tab { font: inherit; font-size: 13px; background: none; border: 0; color: inherit; opacity: .62; padding: 6px 10px 8px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.rec-tab:hover { opacity: .85; }
.rec-tab.on { opacity: 1; font-weight: 600; border-bottom-color: var(--accent, #5b7cfa); }
.rec-block { display: flex; flex-direction: column; }
.rec-bar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 10px; }
.rec-list { display: flex; flex-direction: column; gap: 8px; }
.rec-item { border: 1px solid rgba(128,128,128,.3); border-radius: 10px; }
.rec-head { display: flex; gap: 8px; align-items: baseline; padding: 10px 12px; cursor: pointer; flex-wrap: wrap; }
.rec-name { font-weight: 600; word-break: break-word; }
.rec-preview { flex: 1 1 160px; min-width: 0; font-size: 12px; opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rec-when { margin-left: auto; font-size: 11px; opacity: .65; white-space: nowrap; }
.rec-body { padding: 0 12px 10px; display: flex; flex-direction: column; gap: 6px; }
.rec-sub { opacity: .65; font-size: 11px; word-break: break-all; }
.rec-text { font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.rec-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 2px; }
`;

/** 展开着的记录：按 `kind:id` 记，轮询重画后恢复，不然每 5 秒读的东西会被收起。 */
const OPEN = new Set<string>();

/** 当前页签跨挂载保留，切走再回来还在原来那栏。 */
let activeKind: Kind = 'transcripts';

const TEXT = {
  zh: {
    transcriptsTitle: '转写',
    clipsTitle: '语音',
    refresh: '刷新',
    openFolder: '打开文件夹',
    clear: '清空',
    clearAsk: '清空这一栏的记录？',
    clearBody: '这一栏的记录都会删掉，不能撤销；别的栏和源文件不受影响。',
    cleared: '已清空',
    copyText: '复制文字',
    copySource: '复制来源',
    copyPath: '复制路径',
    play: '试听',
    queued: '已加入播放队列',
    remove: '删除',
    removeAsk: '删掉这条记录？',
    transcriptRemoveBody: '记录会被删掉；源音频不动。',
    fileRemoveBody: '记录和它自己那份音频都会删掉。',
    removed: '已删除',
    emptyTranscripts: '还没有转写记录。',
    emptyClips: '还没有合成语音。',
    noText: '没有文字',
    archived: '只归档',
    throttled: '已节流',
    deliveryFailed: '投递失败',
    forced: '被强切',
    loadBad: '读不到记录',
  },
  en: {
    transcriptsTitle: 'Transcripts',
    clipsTitle: 'Speech',
    refresh: 'Refresh',
    openFolder: 'Open folder',
    clear: 'Clear',
    clearAsk: 'Clear this list?',
    clearBody: 'Every record in this list is removed; other lists and source files are untouched.',
    cleared: 'Cleared',
    copyText: 'Copy text',
    copySource: 'Copy source',
    copyPath: 'Copy path',
    play: 'Listen',
    queued: 'Added to the playback queue',
    remove: 'Delete',
    removeAsk: 'Delete this record?',
    transcriptRemoveBody: 'The record is removed; the source audio is untouched.',
    fileRemoveBody: 'The record and its audio file are removed.',
    removed: 'Deleted',
    emptyTranscripts: 'No transcripts yet.',
    emptyClips: 'No synthesized speech yet.',
    noText: 'No text',
    archived: 'Archived',
    throttled: 'Throttled',
    deliveryFailed: 'Delivery failed',
    forced: 'split',
    loadBad: 'Could not read the records',
  },
} as const;

function preview(text: string, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function mountRecords(ctx: WebUiPanelContext, kinds: readonly Kind[]): Promise<void> {
    const { ui } = ctx;
    const en = !(ctx.language ?? 'zh').startsWith('zh');
    const t = TEXT[en ? 'en' : 'zh'];

    /**
     * 记录时间：新记录是本地墙钟串（`2026-10-31T20:04:54.694+08:00`），按位置切出来就是本地时间；
     * 旧记录存的是 UTC（`...Z`），先换算成本机时区，免得差 8 小时。
     */
    const clockOf = (ts: unknown): string => {
      if (typeof ts === 'string' && ts.endsWith('Z')) {
        const date = new Date(ts);
        if (!Number.isNaN(date.getTime())) {
          const pad = (n: number): string => String(n).padStart(2, '0');
          return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        }
      }
      return ui.fmt.clock(ts);
    };

    const style = ui.h('style');
    style.textContent = STYLE;
    ctx.root.append(style);

    const pageLine = ui.msgline('');
    pageLine.hidden = true;
    ctx.root.append(pageLine);

    interface Block {
      list: HTMLElement;
      el: HTMLElement;
    }

    /** 一栏就是一条工具行加记录卡片；栏名由上面的页签表达，不再单独铺标题和条数。 */
    const block = (kind: Kind, folder: boolean): Block => {
      const el = ui.h('div', 'rec-block');
      // 普通行，不用 actionbar：那边框是给卡片脚栏的，挂在这里会多出一条横线。
      const actions = ui.h('div', 'rec-bar');
      actions.append(
        ui.button(t.refresh, { size: 'sm', onClick: () => void reload(false) }),
        ...(folder ? [ui.button(t.openFolder, { size: 'sm', onClick: () => void openFolder(kind) })] : []),
        ui.button(t.clear, {
          size: 'sm',
          onClick: async () => {
            if (!(await ui.confirm({ title: t.clearAsk, body: t.clearBody, danger: true }))) return;
            await act('clear', [kind], t.cleared);
          },
        }),
      );
      const list = ui.h('div', 'rec-list');
      el.append(actions, list);
      ctx.root.append(el);
      return { list, el };
    };

    const card = (kind: Kind, id: string, title: string, previewText: string, when: string): { el: HTMLDetailsElement; head: HTMLElement; body: HTMLElement } => {
      const key = `${kind}:${id}`;
      const el = ui.h('details', 'rec-item');
      el.open = OPEN.has(key);
      const head = ui.h('summary', 'rec-head');
      head.append(ui.h('span', 'rec-name', title));
      if (previewText) head.append(ui.h('span', 'rec-preview', previewText));
      head.append(ui.h('span', 'rec-when', when));
      const body = ui.h('div', 'rec-body');
      el.append(head, body);
      el.addEventListener('toggle', () => {
        if (el.open) OPEN.add(key);
        else OPEN.delete(key);
      });
      return { el, head, body };
    };

    const metaLine = (parts: Array<string | false>): string => parts.filter(Boolean).join(' · ');

    const refOf = (item: TranscriptItem): string => (item.source?.ref ? String(item.source.ref) : '');

    function transcriptCard(item: TranscriptItem): HTMLElement {
      const source = refOf(item);
      const note = item.note || '';
      const { el, body } = card(
        'transcripts',
        item.id,
        note || preview(item.text, 40) || item.id,
        note ? preview(item.text, 120) : source,
        clockOf(item.createdAt),
      );
      const meta = ui.h('div', 'rec-sub');
      meta.textContent = metaLine([
        item.id,
        item.model || '—',
        item.language || '—',
        typeof item.seconds === 'number' ? ui.fmt.duration(item.seconds * 1000) : '—',
        item.audioBytes ? ui.fmt.bytes(item.audioBytes) : '—',
      ]);
      const text = ui.h('div', 'rec-text');
      text.textContent = item.text || t.noText;
      const row = ui.h('div', 'rec-row');
      if (item.text) row.append(ui.copyButton(item.text, { label: t.copyText }));
      if (source) row.append(ui.copyButton(source, { label: t.copySource }));
      row.append(ui.button(t.remove, {
        variant: 'danger',
        size: 'sm',
        onClick: () => void drop('transcripts', item.id, t.transcriptRemoveBody),
      }));
      body.append(meta, text, row);
      return el;
    }

    function clipCard(item: ClipItem): HTMLElement {
      const note = item.note || '';
      const { el, body } = card(
        'clips',
        item.id,
        note || preview(item.text, 40) || item.file,
        note && item.text ? preview(item.text, 120) : item.file,
        clockOf(item.createdAt),
      );
      const meta = ui.h('div', 'rec-sub');
      meta.textContent = metaLine([
        item.id,
        item.voice || '—',
        item.model || '—',
        typeof item.seconds === 'number' ? ui.fmt.duration(item.seconds * 1000) : '—',
        ui.fmt.bytes(item.bytes),
      ]);
      const text = ui.h('div', 'rec-text');
      if (item.text) text.textContent = item.text;
      const row = ui.h('div', 'rec-row');
      row.append(
        ui.button(t.play, { size: 'sm', onClick: () => void play('clips', item.id) }),
        ui.copyButton(item.path, { label: t.copyPath }),
        ui.button(t.remove, {
          variant: 'danger',
          size: 'sm',
          onClick: () => void drop('clips', item.id, `${t.fileRemoveBody}\n${item.file}`),
        }),
      );
      body.append(meta);
      if (item.text) body.append(text);
      body.append(row);
      return el;
    }

    const tabBar = ui.h('div', 'rec-tabs');
    tabBar.setAttribute('role', 'tablist');
    ctx.root.append(tabBar);
    const views: Array<{ kind: Kind; tab: HTMLButtonElement; el: HTMLElement }> = [];
    const blocks = {} as Partial<Record<Kind, Block>>;

    const remember = kinds.length > 1;
    const select = (kind: Kind): void => {
      if (remember) activeKind = kind;
      for (const view of views) {
        const on = view.kind === kind;
        view.el.hidden = !on;
        view.tab.classList.toggle('on', on);
        view.tab.setAttribute('aria-selected', String(on));
        view.tab.tabIndex = on ? 0 : -1;
      }
    };

    const all: ReadonlyArray<{ kind: Kind; title: string; folder: boolean }> = [
      { kind: 'transcripts', title: t.transcriptsTitle, folder: false },
      { kind: 'clips', title: t.clipsTitle, folder: true },
    ];
    for (const section of all.filter((entry) => kinds.includes(entry.kind))) {
      const tab = ui.h('button', 'rec-tab', section.title);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => select(section.kind));
      tabBar.append(tab);
      const made = block(section.kind, section.folder);
      blocks[section.kind] = made;
      views.push({ kind: section.kind, tab, el: made.el });
    }
    // 单栏挂载（二级页签）时不画这排小页签。
    tabBar.hidden = views.length < 2;
    select(remember && kinds.includes(activeKind) ? activeKind : (kinds[0] ?? 'transcripts'));

    function fill<T>(target: Block, section: Section<T>, render: (item: T) => HTMLElement, empty: string): void {
      target.list.replaceChildren();
      if (!section.items.length) {
        target.list.append(ui.placeholder(empty));
        return;
      }
      for (const item of section.items) target.list.append(render(item));
    }

    let snapshot = '';

    function render(state: RecordsState): void {
      snapshot = JSON.stringify(state);
      if (blocks.transcripts) fill(blocks.transcripts, state.transcripts, transcriptCard, t.emptyTranscripts);
      if (blocks.clips) fill(blocks.clips, state.clips, clipCard, t.emptyClips);
    }

    async function reload(poll: boolean): Promise<void> {
      try {
        const state = await ctx.invoke<RecordsState>('state');
        if (poll && JSON.stringify(state) === snapshot) return;
        render(state);
        pageLine.hidden = true;
      } catch (err) {
        if (poll) return;
        pageLine.hidden = false;
        pageLine.classList.add('bad');
        pageLine.textContent = `${t.loadBad}：${err instanceof Error ? err.message : String(err)}`;
      }
    }

    async function act(method: string, args: unknown[], okText?: string): Promise<void> {
      try {
        const state = await ctx.invoke<RecordsState>(method, args);
        render(state);
        if (okText) ui.toast(okText, 'ok');
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    }

    async function drop(kind: Kind, id: string, body: string): Promise<void> {
      if (!(await ui.confirm({ title: t.removeAsk, body, danger: true }))) return;
      await act('remove', [kind, id], t.removed);
    }

    async function play(kind: Kind, id: string): Promise<void> {
      try {
        const res = await ctx.invoke<{ text: string; state: RecordsState }>('play', [kind, id]);
        render(res.state);
        ui.toast(res.text || t.queued, 'ok');
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    }

    async function openFolder(kind: Kind): Promise<void> {
      try {
        const res = await ctx.invoke<{ ok: boolean; detail?: string }>('openFolder', [kind]);
        if (!res.ok) ui.toast(res.detail ?? t.loadBad, 'bad');
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    }

    await reload(false);
    ctx.interval(() => void reload(true), 5000);
}

/** 独立面板（两种记录都看）。 */
export const recordsPanel: WebUiPanel = { mount: (ctx) => mountRecords(ctx, ['transcripts', 'clips']) };

/** 只显示一栏；用作「说话 / 听」的二级页签时传给外层。 */
export const recordsSection = (kind: Kind): WebUiPanel => ({ mount: (ctx) => mountRecords(ctx, [kind]) });
