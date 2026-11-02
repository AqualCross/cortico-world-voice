export const ID = 'music-abc';
export const LABEL = 'ABC 音乐';
export const DEFAULTS = Object.freeze({ enabled: false, instrument: '', delivery: 'event', eventDelivery: 'archive' });
export function configGroup(language = 'zh') {
  const en = language === 'en';
  const field = (title, type, extra = {}) => ({ type, title, 'x-hot': true, ...extra });
  return {
    id: `world:${ID}`, owner: `world:${ID}`,
    schema: { type: 'object', title: en ? 'ABC Music' : LABEL, properties: {
      [`worlds.${ID}.instrument`]: field(en ? 'Default instrument ID' : '默认乐器 ID', 'string', { description: en ? 'Selected in Instruments. Empty selects the first available preset.' : '在乐器页选择。留空使用第一个可用预设。' }),
      [`worlds.${ID}.delivery`]: field(en ? 'Audio delivery' : '音频交付方式', 'string', { enum: ['return', 'event'], description: en ? 'return: tool attachment; event: audio.abc_played event.' : 'return：工具附件；event：audio.abc_played 事件。' }),
      [`worlds.${ID}.eventDelivery`]: field(en ? 'Event destination' : '事件去向', 'string', { enum: ['archive', 'model'], description: en ? 'archive: retain only; model: deliver to the conversation.' : 'archive：只存档；model：投递到对话。' }),
    } },
  };
}
