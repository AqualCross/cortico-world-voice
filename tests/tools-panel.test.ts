// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createWebUi } from 'cortico/web/client/ui/index.ts';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { toolsPanel } from '../src/webui/tools.ts';

const makeView = (defaultListen = false) => ({
  revision: 'initial', overrides: {} as Record<string, Record<string, string>>,
  disabledTools: defaultListen ? ['audio_listen'] : [], defaultDisabledTools: defaultListen ? ['audio_listen'] : [], warnings: [],
  tools: ['audio_listen', 'audio_queue'].map((name) => ({
    name, enabled: name !== 'audio_listen' || !defaultListen, tags: ['act'], summary: name,
    fields: [{ path: '/description', location: name, keyword: 'description', defaultText: 'Default', inheritedText: 'Default', inheritedSource: 'default', text: 'Default', source: 'default' }],
  })),
});

async function mount(language = 'zh', defaultListen = false) {
  let state = makeView(defaultListen);
  const root = document.createElement('div');
  const signal = new AbortController().signal;
  const ui = createWebUi({ memo: { get: (_key, fallback) => fallback, set: () => {} }, overlayHost: document.body, signal });
  ui.confirm = vi.fn(async () => true);
  const refresh = vi.fn(async () => {});
  const invoke = vi.fn(async (method: string, args: unknown[] = []) => {
    if (method === 'save') {
      const payload = args[0] as { overrides: typeof state.overrides; disabledTools: string[] };
      state = { ...state, ...payload, revision: 'saved', tools: state.tools.map((tool) => ({
        ...tool, enabled: !payload.disabledTools.includes(tool.name),
        fields: tool.fields.map((field) => ({ ...field, text: payload.overrides[tool.name]?.[field.path] ?? field.inheritedText })),
      })) };
    }
    if (method === 'reset') state = makeView(defaultListen);
    return structuredClone(state);
  });
  await toolsPanel.mount({ root, ui, language, signal, invoke, refresh } as unknown as WebUiPanelContext);
  await vi.waitFor(() => expect(root.querySelectorAll('[role="switch"]')).toHaveLength(2));
  return { root, ui, invoke, refresh };
}

describe('工具页开关', () => {
  it('开关不展开卡片，和说明一起保存，并刷新框架的前缀重载提示；恢复默认重新开放', async () => {
    const { root, ui, invoke, refresh } = await mount();
    const toggle = root.querySelector<HTMLButtonElement>('[role="switch"]')!;
    const save = root.querySelector<HTMLButtonElement>('.li-tools-toolbar button')!;
    expect(save.disabled).toBe(true);
    toggle.click();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(root.querySelector('details')!.open).toBe(false);
    expect(save.disabled).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    const input = root.querySelector('textarea')!;
    input.value = 'Changed description';
    input.dispatchEvent(new Event('input'));
    save.click();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('save', [{
      expectedRevision: 'initial', disabledTools: ['audio_listen'], overrides: { audio_listen: { '/description': 'Changed description' } },
    }]);
    expect(root.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    expect(root.textContent).toContain('重载系统前缀后生效');
    const reset = root.querySelectorAll<HTMLButtonElement>('.li-tools-toolbar button')[1];
    await vi.waitFor(() => expect(reset.disabled).toBe(false));
    reset.click();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('恢复工具开关的默认状态') }));
    expect(root.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
  });

  it('保存失败时保留开关草稿；英文也有可访问的开关标签', async () => {
    const { root, invoke, refresh } = await mount('en');
    const toggle = root.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-label')).toBe('Expose tool to the model: audio_listen');
    toggle.click();
    invoke.mockRejectedValueOnce(new Error('Save failed'));
    const save = root.querySelector<HTMLButtonElement>('.li-tools-toolbar button')!;
    save.click();
    await vi.waitFor(() => expect(root.textContent).toContain('Save failed'));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(save.disabled).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('默认关闭不算部署覆盖；用户开启后可以恢复到关闭的默认状态', async () => {
    const { root, refresh } = await mount('zh', true);
    const buttons = root.querySelectorAll<HTMLButtonElement>('.li-tools-toolbar button');
    const [save, reset] = buttons;
    expect(root.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    expect(save.disabled).toBe(true);
    expect(reset.disabled).toBe(true);
    root.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    save.click();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(reset.disabled).toBe(false));
    reset.click();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(root.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    await vi.waitFor(() => expect(reset.disabled).toBe(true));
  });
});
