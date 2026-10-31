/** 「播放」页：默认音量、桌面字幕与队列。也可以作为「说话」的二级页签挂载（见 speak.ts）。 */
import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

// ---------------------------------------------------------------------------
// 播放
// ---------------------------------------------------------------------------

interface QueueItemView {
  id: string;
  shown: string;
  ref: string;
  volume: number;
  origin: string;
  position: number;
  elapsedSec: number;
}

interface QueueSnapshot {
  current: QueueItemView | null;
  pending: QueueItemView[];
  counts: { current: number; pending: number };
  volume: number;
  lastError: string | null;
}

type QueueResp = QueueSnapshot | { text: string; state: QueueSnapshot };

const ORIGIN: Readonly<Record<string, string>> = {
  tool: '工具',
  ui: '页面',
  event: '事件',
};

const QUEUE_STYLE = `
.sp-row { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 10px; align-items: center; margin: 6px 0; max-width: 900px; }
.sp-label { font-size: 12px; opacity: .75; }
.sp-slider { display: flex; gap: 10px; align-items: center; }
.sp-slider input[type=range] { flex: 1 1 auto; }
.sp-value { width: 72px; text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; }
.aq-color { width: 64px; height: 28px; padding: 0; border: 1px solid rgba(128,128,128,.35); border-radius: 6px; background: transparent; }
.aq-inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.aud-switch { position: relative; flex: 0 0 auto; width: 36px; height: 20px; border: 0; padding: 0; border-radius: 10px; background: rgba(128,128,128,.38); cursor: pointer; transition: background .15s; }
.aud-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
.aud-switch.on { background: var(--accent, #5b7cfa); }
.aud-switch.on::after { transform: translateX(16px); }
.aud-switch:focus-visible { outline: 2px solid var(--accent, #5b7cfa); outline-offset: 2px; }
`;

export const queuePanel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext) {
    const { ui } = ctx;

    const style = ui.h('style', null);
    style.textContent = QUEUE_STYLE;
    ctx.root.append(style);

    const slider = ui.h('input', null);
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '5';
    slider.value = '80';
    slider.className = 'aq-volume';
    const readout = ui.input({ type: 'number', value: '80' });
    readout.className = 'sp-value';
    readout.min = '0';
    readout.max = '100';
    readout.step = '5';
    const volumeRow = ui.h('div', 'sp-row');
    const volumeSlider = ui.h('div', 'sp-slider');
    volumeSlider.append(slider, readout);
    volumeRow.append(ui.h('span', 'sp-label', '默认音量'), volumeSlider);
    ctx.root.append(volumeRow);

    const saveVolume = (): void => {
      ctx.timeout(() => {
        void ctx.invoke('setConfigValue', ['worlds.audio.volume', Number(slider.value)]).catch((err: unknown) => {
          ui.toast(`音量没保存：${err instanceof Error ? err.message : String(err)}`, 'bad');
        });
      }, 350);
    };
    slider.addEventListener('input', () => {
      readout.value = slider.value;
      saveVolume();
    });
    readout.addEventListener('change', () => {
      const next = Number(readout.value);
      if (!Number.isFinite(next)) {
        readout.value = slider.value;
        return;
      }
      const clamped = Math.min(100, Math.max(0, next));
      slider.value = String(clamped);
      readout.value = String(clamped);
      saveVolume();
    });

    const errorLine = ui.msgline('');
    errorLine.hidden = true;

    // 桌面字幕：画面在屏幕上层，这里只管开关与样式，预览让它在不播东西时也能看到。
    interface SubtitleView {
      enabled: boolean;
      size: number;
      color: string;
      vertical: string;
      align: string;
    }
    const subtitleStyle = await ctx
      .invoke<SubtitleView>('subtitle')
      .catch(() => ({ enabled: true, size: 34, color: '#FFFFFF', vertical: 'bottom', align: 'center' }));

    const saveSubtitle = (key: string, value: unknown): void => {
      void ctx.invoke('setConfigValue', [`worlds.audio.subtitle.${key}`, value]).catch((err: unknown) => {
        ui.toast(`字幕没保存：${err instanceof Error ? err.message : String(err)}`, 'bad');
      });
    };
    const subtitleRow = (label: string, control: HTMLElement): void => {
      const row = ui.h('div', 'sp-row');
      row.append(ui.h('span', 'sp-label', label), control);
      ctx.root.append(row);
    };

    // 开/关用真开关（role=switch），不用勾选框。
    const subOn = ui.h('button', subtitleStyle.enabled ? 'aud-switch on' : 'aud-switch');
    subOn.type = 'button';
    subOn.setAttribute('role', 'switch');
    subOn.setAttribute('aria-checked', String(subtitleStyle.enabled));
    subOn.setAttribute('aria-label', '桌面字幕');
    subOn.addEventListener('click', () => {
      const next = !subOn.classList.contains('on');
      subOn.classList.toggle('on', next);
      subOn.setAttribute('aria-checked', String(next));
      saveSubtitle('enabled', next);
    }, { signal: ctx.signal });
    subtitleRow('桌面字幕', subOn);

    const subSize = ui.h('input', null);
    subSize.type = 'range';
    subSize.min = '12';
    subSize.max = '96';
    subSize.step = '1';
    subSize.value = String(subtitleStyle.size);
    const subSizeValue = ui.input({ type: 'number', value: String(subtitleStyle.size) });
    subSizeValue.className = 'sp-value';
    subSizeValue.min = '12';
    subSizeValue.max = '96';
    subSizeValue.step = '1';
    const sizeWrap = ui.h('div', 'sp-slider');
    sizeWrap.append(subSize, subSizeValue);
    subtitleRow('字号', sizeWrap);
    const saveSize = (): void => {
      ctx.timeout(() => saveSubtitle('size', Number(subSize.value)), 350);
    };
    subSize.addEventListener('input', () => {
      subSizeValue.value = subSize.value;
      saveSize();
    });
    subSizeValue.addEventListener('change', () => {
      const next = Number(subSizeValue.value);
      if (!Number.isFinite(next)) {
        subSizeValue.value = subSize.value;
        return;
      }
      const clamped = Math.min(96, Math.max(12, next));
      subSize.value = String(clamped);
      subSizeValue.value = String(clamped);
      saveSize();
    });

    const subColor = ui.h('input', 'aq-color');
    subColor.type = 'color';
    subColor.value = /^#[0-9a-fA-F]{6}$/.test(subtitleStyle.color) ? subtitleStyle.color : '#FFFFFF';
    subColor.addEventListener('input', () => {
      ctx.timeout(() => saveSubtitle('color', subColor.value.toUpperCase()), 350);
    });
    subtitleRow('颜色', subColor);

    const subPlace = ui.h('div', 'aq-inline');
    const subVertical = ui.select({
      options: [
        { value: 'top', label: '顶部' },
        { value: 'middle', label: '中间' },
        { value: 'bottom', label: '底部' },
      ],
      value: subtitleStyle.vertical,
      onChange: (v) => saveSubtitle('vertical', v),
    });
    const subAlign = ui.select({
      options: [
        { value: 'left', label: '左' },
        { value: 'center', label: '居中' },
        { value: 'right', label: '右' },
      ],
      value: subtitleStyle.align,
      onChange: (v) => saveSubtitle('align', v),
    });
    subPlace.append(subVertical, subAlign);
    subtitleRow('位置', subPlace);
    ctx.root.append(errorLine);

    // 按钮放在列表上方：队列再长，「清空队列」也不用翻到底。
    const actions = ui.actions();
    actions.append(
      ui.button('预览字幕', { size: 'sm', onClick: () => void previewSubtitle() }),
      ui.button('清空队列', {
        size: 'sm',
        onClick: async () => {
          if (!(await ui.confirm({ title: '清空播放队列？', body: '当前这条会停止，排队中的条目都会被丢掉。', danger: true }))) return;
          await act('clear');
        },
      }),
    );
    ctx.root.append(actions);

    const list = ui.h('div', null);
    ctx.root.append(list);

    async function previewSubtitle(): Promise<void> {
      try {
        await ctx.invoke('previewSubtitle');
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    }

    async function act(method: string, args: unknown[] = []): Promise<void> {
      try {
        const resp = await ctx.invoke<QueueResp>(method, args);
        if (resp && 'state' in resp) {
          if (resp.text) ui.toast(resp.text);
          render(resp.state);
        } else if (resp) {
          render(resp);
        }
      } catch (err) {
        errorLine.hidden = false;
        errorLine.classList.add('bad');
        errorLine.textContent = err instanceof Error ? err.message : String(err);
      }
    }

    function itemCard(item: QueueItemView, isCurrent: boolean): HTMLElement {
      const sheet = ui.sheet({ title: item.shown, desc: `${item.id} · ${ORIGIN[item.origin] ?? item.origin} · 音量 ${item.volume}` });
      if (isCurrent) sheet.el.classList.add('aq-current');
      const row = ui.rowbar();
      row.append(ui.pill(isCurrent ? `已 ${item.elapsedSec} 秒` : `第 ${item.position} 条`, 'plain'));
      if (isCurrent) row.append(ui.button('跳过', { size: 'sm', onClick: () => void act('skip') }));
      else row.append(ui.button('移除', { size: 'sm', onClick: () => void act('remove', [item.id]) }));
      sheet.body.append(row);
      return sheet.el;
    }

    function render(snap: QueueSnapshot): void {
      if (document.activeElement !== slider) slider.value = String(snap.volume);
      if (document.activeElement !== readout) readout.value = slider.value;
      errorLine.hidden = !snap.lastError;
      if (snap.lastError) {
        errorLine.classList.add('bad');
        errorLine.textContent = `最近一次失败：${snap.lastError}`;
      }
      list.replaceChildren();
      if (!snap.current && !snap.pending.length) {
        list.append(ui.placeholder('队列是空的。'));
        return;
      }
      if (snap.current) list.append(itemCard(snap.current, true));
      for (const item of snap.pending) list.append(itemCard(item, false));
    }

    async function refresh(): Promise<void> {
      try {
        render(await ctx.invoke<QueueSnapshot>('list'));
      } catch {
        // 轮询失败留给下一次。
      }
    }

    await refresh();
    ctx.interval(() => void refresh(), 1000);
  },
};
