/**
 * 「工具」页：与 `cortico-world-listen`（听觉）的工具页同一套 DOM/CSS 与交互。
 * 每个工具的模型可见性与可改文字（描述、参数说明），保存为部署覆盖。
 */
import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface Field {
  path: string;
  location: string;
  keyword: string;
  defaultText: string;
  inheritedText: string;
  inheritedSource: 'default' | 'package';
  text: string;
  source: 'default' | 'package' | 'deployment';
}

interface ToolView {
  name: string;
  enabled?: boolean;
  tags?: string[];
  summary?: string | { zh: string; en: string };
  fields: Field[];
}

interface View {
  revision: string;
  overrides: Record<string, Record<string, string>>;
  disabledTools?: string[];
  defaultDisabledTools?: string[];
  warnings: Array<{ layer: string; tool?: string; path?: string; error?: string }>;
  tools: ToolView[];
}

const STYLE = `
.li-tools { width: 100%; max-width: 900px; }
.li-tools .li-tools-toolbar { display: flex; gap: 10px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
.li-tools .li-tools-toolbar input { flex: 1 1 240px; min-width: 200px; height: 38px; box-sizing: border-box; }
.li-tools .li-tool-card { border: 1px solid rgba(128,128,128,.3); border-radius: 10px; margin-top: 10px; }
.li-tools .li-tool-summary { display: flex; gap: 8px; align-items: center; padding: 10px 12px; cursor: pointer; flex-wrap: wrap; }
.li-tools .li-tool-heading { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.li-tools .li-tool-name { font-family: inherit; font-weight: 600; }
.li-tools .li-tool-tag { border: 1px solid rgba(128,128,128,.4); border-radius: 6px; padding: 1px 6px; font-size: 11px; opacity: .8; }
.li-tools .li-tool-source { margin-left: auto; font-size: 11px; opacity: .65; }
.li-tools .li-tool-switch { position: relative; width: 34px; height: 20px; padding: 0; border: 1px solid rgba(128,128,128,.45); border-radius: 12px; background: rgba(128,128,128,.25); cursor: pointer; flex-shrink: 0; }
.li-tools .li-tool-switch::after { content: ''; position: absolute; width: 14px; height: 14px; top: 2px; left: 2px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px #0003; }
.li-tools .li-tool-switch[aria-checked="true"] { background: var(--accent, #6864d9); border-color: transparent; }
.li-tools .li-tool-switch[aria-checked="true"]::after { left: 16px; }
.li-tools .li-tool-switch:focus-visible { outline: 2px solid var(--accent, #6864d9); outline-offset: 3px; }
.li-tools .li-tool-switch:disabled { opacity: .5; cursor: wait; }
.li-tools .li-tool-card[data-enabled="false"] .li-tool-name { opacity: .55; }
.li-tools .li-tool-body { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 12px; }
.li-tools .li-tool-field { display: flex; flex-direction: column; gap: 6px; }
.li-tools .li-tool-field > label { font-size: 12px; opacity: .8; }
.li-tools .li-tool-field textarea { width: 100%; box-sizing: border-box; resize: vertical; font: inherit; padding: 8px; border-radius: 8px; border: 1px solid rgba(128,128,128,.35); background: transparent; color: inherit; }
.li-tools .li-tool-field-footer { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.li-tools .li-tool-default { font-size: 12px; opacity: .75; }
.li-tools .li-tool-default pre { white-space: pre-wrap; margin: 4px 0 0; font-size: 11px; }
.li-tools .li-tools-warnings { color: #c85; font-size: 12px; }
.li-sub { opacity: .65; font-size: 11px; word-break: break-all; }
.li-empty { padding: 22px 8px; text-align: center; opacity: .8; }
`;

const TEXT = {
  zh: {
    toolsSave: '保存修改',
    toolsReset: '恢复默认',
    toolsSearch: '筛选工具名或说明',
    toolsDirty: '有未保存的工具设置',
    toolsSaved: '工具设置已保存；重载系统前缀后生效。',
    toolsRestored: '工具设置已恢复默认；重载系统前缀后生效。',
    toolsResetTitle: '恢复全部工具设置？',
    toolsResetBody: '恢复工具开关的默认状态，移除本部署的工具说明覆盖，并放弃未保存的修改。',
    toolsHelp: '关闭的工具不提供给模型。保存后请点「前缀待重载」更新当前会话。此处只控制工具调用，声音采集与通知仍由「听」页控制。',
    toolsToggle: '向模型开放工具',
    toolsDefaultText: '默认文字',
    toolsNoDescription: '尚未声明说明',
    toolsToolDescription: '工具描述',
    toolsParametersDescription: '参数整体说明',
    toolsEmpty: '没有匹配的工具',
    toolsSourceDefault: '扩展默认',
    toolsSourcePackage: 'bot 包覆盖',
    toolsSourceDeployment: '部署覆盖',
    toolsInvalidFile: '覆盖文件无法读取；部署设置损坏时全部工具暂时关闭，请恢复默认或修复文件。',
    toolsStale: '以下覆盖字段已不存在，未应用：',
    toolsTitle: '标题',
    toolsDescription: '说明',
    tagRead: '读取',
    tagAct: '行动',
    tagWrite: '写入',
    tagSpeak: '发言',
    tagFlow: '流程',
    tagSnapshot: '快照',
  },
  en: {
    toolsSave: 'Save changes',
    toolsReset: 'Restore defaults',
    toolsSearch: 'Filter tool names or descriptions',
    toolsDirty: 'Unsaved tool settings',
    toolsSaved: 'Tool settings saved; reload the system prefix to apply.',
    toolsRestored: 'Tool defaults restored; reload the system prefix to apply.',
    toolsResetTitle: 'Restore all tool settings?',
    toolsResetBody: 'Restore the default tool switches, remove this deployment\u2019s tool text overrides and discard unsaved changes.',
    toolsHelp: 'Disabled tools are hidden from the model. After saving, click “Prefix drifted” to update this session. These switches control tool calls; sound capture and notifications are controlled on the Hearing tab.',
    toolsToggle: 'Expose tool to the model',
    toolsDefaultText: 'Default text',
    toolsNoDescription: 'No description declared',
    toolsToolDescription: 'Tool description',
    toolsParametersDescription: 'Description of all parameters',
    toolsEmpty: 'No matching tools',
    toolsSourceDefault: 'Extension default',
    toolsSourcePackage: 'Bot package override',
    toolsSourceDeployment: 'Deployment override',
    toolsInvalidFile: 'An override file cannot be read. If deployment settings are invalid, all tools are hidden until you restore defaults or repair the file.',
    toolsStale: 'These override fields no longer exist and are not applied:',
    toolsTitle: 'Title',
    toolsDescription: 'Description',
    tagRead: 'Read',
    tagAct: 'Act',
    tagWrite: 'Write',
    tagSpeak: 'Speak',
    tagFlow: 'Flow',
    tagSnapshot: 'Snapshot',
  },
} as const;

function injectStyle(ctx: WebUiPanelContext): void {
  const el = ctx.ui.h('style');
  el.textContent = STYLE;
  ctx.root.appendChild(el);
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const toolsPanel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext) {
    const tx = TEXT[(ctx.language ?? 'zh').startsWith('zh') ? 'zh' : 'en'];
    injectStyle(ctx);

    const root = ctx.ui.h('section', 'li-tools');
    ctx.root.appendChild(root);

    const toolbar = ctx.ui.h('div', 'li-tools-toolbar');
    const search = ctx.ui.h('input');
    search.type = 'search';
    search.placeholder = tx.toolsSearch;
    search.setAttribute('aria-label', tx.toolsSearch);
    const saveBtn = ctx.ui.button(tx.toolsSave, { size: 'sm', variant: 'primary', onClick: () => { void save(); } });
    const resetBtn = ctx.ui.button(tx.toolsReset, { size: 'sm', onClick: () => { void reset(); } });
    toolbar.append(search, saveBtn, resetBtn);
    const status = ctx.ui.h('div', 'li-sub', '');
    const warnings = ctx.ui.h('div', 'li-tools-warnings', '');
    const list = ctx.ui.h('div');
    const empty = ctx.ui.h('div', 'li-empty', tx.toolsEmpty);
    empty.hidden = true;
    root.append(toolbar, ctx.ui.h('p', 'li-sub', tx.toolsHelp), status, warnings, list, empty);

    const TAG_TEXT: Record<string, string> = {
      read: tx.tagRead,
      act: tx.tagAct,
      write: tx.tagWrite,
      speak: tx.tagSpeak,
      flow: tx.tagFlow,
      snapshot: tx.tagSnapshot,
    };
    let state: View | null = null;
    let busy = false;
    let entries: Array<{ input: HTMLTextAreaElement; field: Field; tool: string; resetBtn: HTMLButtonElement }> = [];
    let toggles: Array<{ button: HTMLButtonElement; tool: ToolView; enabled: boolean }> = [];
    let cards: Array<{ card: HTMLElement; text: () => string }> = [];

    const say = (line: string, bad = false): void => {
      status.textContent = line || '';
      status.classList.toggle('bad', bad);
    };
    const dirty = (): boolean => entries.some(({ input, field }) => input.value !== field.text)
      || toggles.some(({ tool, enabled }) => enabled !== (tool.enabled !== false));
    const update = (): void => {
      if (!state) {
        saveBtn.disabled = true;
        resetBtn.disabled = true;
        return;
      }
      saveBtn.disabled = busy || !dirty();
      const disabled = state.disabledTools ?? [];
      const defaults = state.defaultDisabledTools ?? [];
      const customSwitches = disabled.length !== defaults.length || disabled.some((name) => !defaults.includes(name));
      resetBtn.disabled = busy || (!Object.keys(state.overrides).length
        && !customSwitches && !dirty()
        && !(state.warnings ?? []).some((warning) => warning.layer === 'deployment' && warning.error));
      for (const entry of entries) entry.resetBtn.disabled = busy || entry.input.value === entry.field.inheritedText;
      for (const entry of entries) entry.input.disabled = busy;
      for (const toggle of toggles) toggle.button.disabled = busy;
    };
    const filter = (): void => {
      const query = search.value.trim().toLocaleLowerCase();
      let shown = 0;
      for (const { card, text } of cards) {
        const match = !query || text().toLocaleLowerCase().includes(query);
        card.hidden = !match;
        if (match) shown += 1;
      }
      empty.hidden = shown > 0 || !state;
    };
    const run = async (fn: () => Promise<void>): Promise<void> => {
      if (busy) return;
      busy = true;
      update();
      try {
        await fn();
      } catch (err) {
        if (!ctx.signal.aborted) say(message(err), true);
      } finally {
        busy = false;
        if (!ctx.signal.aborted) update();
      }
    };
    const fieldLabel = (field: Field): string => {
      if (field.path === '/description') return tx.toolsToolDescription;
      if (field.path === '/parameters/description') return tx.toolsParametersDescription;
      return `${field.location} · ${field.keyword === 'title' ? tx.toolsTitle : tx.toolsDescription}`;
    };

    const render = (): void => {
      if (!state) return;
      entries = [];
      toggles = [];
      cards = [];
      list.replaceChildren();
      warnings.replaceChildren();
      for (const warning of state.warnings ?? []) {
        warnings.appendChild(ctx.ui.h('p', '', `${warning.error ? tx.toolsInvalidFile : tx.toolsStale} ${warning.layer}: ${warning.error || `${warning.tool}${warning.path}`}`));
      }
      for (const tool of state.tools) {
        const card = ctx.ui.h('details', 'li-tool-card');
        const summary = ctx.ui.h('summary', 'li-tool-summary');
        const heading = ctx.ui.h('span', 'li-tool-heading');
        heading.appendChild(ctx.ui.h('code', 'li-tool-name', tool.name));
        for (const tag of tool.tags ?? []) heading.appendChild(ctx.ui.h('span', 'li-tool-tag', TAG_TEXT[tag] ?? tag));
        summary.appendChild(heading);
        summary.appendChild(ctx.ui.h('span', 'li-sub', typeof tool.summary === 'string'
          ? tool.summary
          : (tool.summary?.[(ctx.language ?? 'zh') === 'en' ? 'en' : 'zh'] ?? '')));
        const source = ctx.ui.h('span', 'li-tool-source');
        summary.appendChild(source);
        const toggleButton = ctx.ui.h('button', 'li-tool-switch');
        toggleButton.type = 'button';
        toggleButton.setAttribute('role', 'switch');
        toggleButton.setAttribute('aria-label', `${tx.toolsToggle}: ${tool.name}`);
        const toggle = { button: toggleButton, tool, enabled: tool.enabled !== false };
        toggles.push(toggle);
        const updateToggle = (): void => {
          toggleButton.setAttribute('aria-checked', String(toggle.enabled));
          card.dataset.enabled = String(toggle.enabled);
        };
        toggleButton.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggle.enabled = !toggle.enabled;
          updateToggle();
          update();
          say(dirty() ? tx.toolsDirty : '');
        });
        updateToggle();
        summary.appendChild(toggleButton);
        card.appendChild(summary);

        const body = ctx.ui.h('div', 'li-tool-body');
        const fields = ctx.ui.h('div');
        const own: typeof entries = [];
        const cardInputs: HTMLTextAreaElement[] = [];
        const updateSource = (): void => {
          source.textContent = own.some((entry) => entry.input.value !== entry.field.inheritedText)
            ? tx.toolsSourceDeployment
            : tool.fields.some((field) => field.inheritedSource === 'package') ? tx.toolsSourcePackage : tx.toolsSourceDefault;
        };
        for (const field of tool.fields) {
          const wrap = ctx.ui.h('div', 'li-tool-field');
          const id = `${tool.name}-${entries.length}`;
          const label = ctx.ui.h('label', '', fieldLabel(field));
          label.htmlFor = id;
          const input = ctx.ui.h('textarea');
          input.id = id;
          input.rows = field.path === '/description' ? 4 : 2;
          input.spellcheck = false;
          input.value = field.text;
          input.placeholder = tx.toolsNoDescription;
          cardInputs.push(input);
          const footer = ctx.ui.h('div', 'li-tool-field-footer');
          const defaults = ctx.ui.h('details', 'li-tool-default');
          defaults.appendChild(ctx.ui.h('summary', '', tx.toolsDefaultText));
          defaults.appendChild(ctx.ui.h('pre', '', field.inheritedText || tx.toolsNoDescription));
          const resetField = ctx.ui.button(tx.toolsReset, {
            size: 'sm',
            onClick: () => {
              input.value = field.inheritedText;
              updateSource();
              update();
              say(dirty() ? tx.toolsDirty : '');
              filter();
            },
          });
          footer.append(defaults, resetField);
          wrap.append(label, input, footer);
          fields.appendChild(wrap);
          const entry = { input, field, tool: tool.name, resetBtn: resetField };
          entries.push(entry);
          own.push(entry);
          input.addEventListener('input', () => {
            updateSource();
            update();
            say(dirty() ? tx.toolsDirty : '');
            filter();
          });
        }
        updateSource();
        body.appendChild(fields);
        card.appendChild(body);
        list.appendChild(card);
        cards.push({
          card,
          text: () => `${tool.name} ${(tool.tags ?? []).join(' ')} ${summary.textContent} ${cardInputs.map((input) => input.value).join(' ')}`,
        });
      }
      filter();
      update();
    };

    const save = (): Promise<void> => run(async () => {
      if (!state) return;
      const overrides = structuredClone(state.overrides ?? {});
      for (const { input, field, tool } of entries) {
        overrides[tool] ??= {};
        if (input.value === field.inheritedText) delete overrides[tool][field.path];
        else overrides[tool][field.path] = input.value;
        if (!Object.keys(overrides[tool]).length) delete overrides[tool];
      }
      const disabled = new Set(state.disabledTools);
      for (const { tool, enabled } of toggles) {
        if (enabled) disabled.delete(tool.name);
        else disabled.add(tool.name);
      }
      state = await ctx.invoke<View>('save', [{ expectedRevision: state.revision, overrides, disabledTools: [...disabled] }]);
      say(tx.toolsSaved);
      render();
      await ctx.refresh();
    });

    const reset = (): Promise<void> => run(async () => {
      if (!state) return;
      const ok = await ctx.ui.confirm({ title: tx.toolsResetTitle, body: tx.toolsResetBody, danger: true });
      if (!ok) return;
      state = await ctx.invoke<View>('reset', [{ expectedRevision: state.revision }]);
      say(tx.toolsRestored);
      render();
      await ctx.refresh();
    });

    search.addEventListener('input', () => { filter(); });
    void run(async () => {
      state = await ctx.invoke<View>('list', []);
      render();
    });
  },
};
