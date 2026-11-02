// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebUi } from 'cortico/web/client/ui/index.ts';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import client from '../src/webui/client.ts';

afterEach(() => vi.restoreAllMocks());

async function mount() {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const root = document.createElement('div'), controller = new AbortController();
  const memo = new Map<string, unknown>(), resources: Array<{ dispose(): void }> = [];
  let streamsClosed = 0;
  const state = { ffmpeg: true, separator: { phase: 'absent', done: 0, total: 0, detail: null }, tasks: [{
    id: 'a'.repeat(32), kind: 'separate', title: 'song.wav', phase: 'done', detail: '', origin: 'ui', createdAt: '2026-11-02T00:00:00Z',
    outputs: [{ name: '人声', path: 'D:/vocals.wav' }, { name: '伴奏', path: 'D:/accompaniment.wav' }],
  }] };
  const ctx = {
    root, signal: controller.signal, language: 'zh', scope: {}, pageId: 'world:audio', panelId: 'music',
    memo: { get: (key: string, fallback: unknown) => memo.has(key) ? memo.get(key) : fallback, set: (key: string, value: unknown) => memo.set(key, value) },
    ui: createWebUi({ memo: { get: (_key, fallback) => fallback, set: () => {} }, signal: controller.signal, overlayHost: document.body }),
    invoke: async (method: string, args: unknown[] = []) => {
      if (method === 'state') return state;
      if (method === 'abc' && args[0] === 'scores') return { items: [], state: { instrument: '' }, fonts: [], instruments: [], aliases: {} };
      if (method === 'abc' && args[0] === 'works') return { items: [] };
      if (method === 'abc' && args[0] === 'instruments') return { fonts: [], items: [], state: {} };
      return state;
    },
    invokeBinary: async () => new Blob(),
    own: <T extends { dispose(): void }>(resource: T) => { resources.push(resource); return resource; },
    interval: () => ({ dispose() {} }), timeout: () => ({ dispose() {} }), frame: () => ({ dispose() {} }),
    stream: () => ({ open: true, send() {}, dispose() { streamsClosed++; } }),
    refresh: async () => {}, guardLeave: () => ({ dispose() {} }), pickPath: async () => null,
  } as unknown as WebUiPanelContext;
  await client.panels.music.mount(ctx);
  const click = async (text: string): Promise<void> => {
    const button = [...root.querySelectorAll('button')].find((button) => button.textContent === text);
    expect(button, text).toBeTruthy(); button!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { root, click, get streamsClosed() { return streamsClosed; }, dispose() { controller.abort(); for (const resource of resources) resource.dispose(); } };
}

describe('音乐页', () => {
  it('二级页为分离、混音、ABC、记录；完成结果只留在记录页', async () => {
    const page = await mount();
    try {
      expect(page.root.firstElementChild?.tagName).toBe('STYLE');
      expect(page.root.querySelector('.audio-music > .aud-tabs')).toBeTruthy();
      expect([...page.root.querySelectorAll('.aud-tabs [role=tab]')].map((node) => node.textContent)).toEqual(['分离', '混音', 'ABC', '记录']);
      expect(page.root.textContent).toContain('已完成，可在「记录」查看。');
      expect(page.root.textContent).not.toContain('D:/vocals.wav');
      await page.click('记录');
      await page.click('两轨加入混音');
      expect(page.root.querySelector('[aria-selected=true]')?.textContent).toBe('混音');
      const paths = [...page.root.querySelectorAll<HTMLInputElement>('.music-track label:first-child input')].map((input) => input.value);
      expect(paths).toEqual(['D:/vocals.wav', 'D:/accompaniment.wav']);
    } finally { page.dispose(); }
  });

  it('记录页汇总分离与混音的作品，可把单条结果送去混音', async () => {
    const page = await mount();
    try {
      await page.click('记录');
      expect(page.root.textContent).toContain('共 1 项作品');
      expect(page.root.textContent).toContain('人声');
      expect(page.root.textContent).toContain('伴奏');
      expect(page.root.textContent).toContain('D:/vocals.wav');
      await page.click('加入混音');
      expect(page.root.querySelector('[aria-selected=true]')?.textContent).toBe('混音');
      const paths = [...page.root.querySelectorAll<HTMLInputElement>('.music-track label:first-child input')].map((input) => input.value);
      expect(paths).toEqual(['D:/vocals.wav']);
    } finally { page.dispose(); }
  });

  it('ABC 保留原来的乐谱编辑、作品和乐器页，切换后保留草稿并关闭旧订阅', async () => {
    const page = await mount();
    try {
      await page.click('ABC');
      expect(page.root.textContent).toContain('乐谱'); expect(page.root.textContent).toContain('作品'); expect(page.root.textContent).toContain('乐器');
      const editor = page.root.querySelector('textarea')!;
      editor.value = 'X:1\nT:草稿\nK:C\nCDEF|'; editor.dispatchEvent(new Event('input', { bubbles: true }));
      await page.click('混音'); expect(page.streamsClosed).toBeGreaterThan(0);
      await page.click('ABC'); expect(page.root.querySelector('textarea')?.value).toContain('T:草稿');
      await page.click('乐器'); expect(page.root.textContent).toContain('获取GeneralUser GS');
    } finally { page.dispose(); }
  });
});
