import { GROOVE_NAMES } from './band.js';

export const ID = 'music-abc';
export const LABEL = 'ABC 音乐';
export const DEFAULTS = Object.freeze({ enabled: false, instrument: '', backing: 'off', groove: 'pop', energy: 3, delivery: 'event', eventDelivery: 'archive' });
export function configGroup(language = 'zh') {
  const en = language === 'en';
  const field = (title, type, extra = {}) => ({ type, title, 'x-hot': true, ...extra });
  return {
    id: `world:${ID}`, owner: `world:${ID}`,
    schema: { type: 'object', title: en ? 'ABC Music' : LABEL, properties: {
      [`worlds.${ID}.instrument`]: field(en ? 'Default instrument ID' : '默认乐器 ID', 'string', { description: en ? 'Selected in Instruments. Empty selects the first available preset.' : '在乐器页选择。留空使用第一个可用预设。' }),
      [`worlds.${ID}.backing`]: field(en ? 'Backing' : '自动伴奏', 'string', { enum: ['off', 'abcjs', 'band'], description: en ? 'off: quoted chord names are labels only. abcjs: a simple bass/chord backing. band: the full groove band (comp, bass, drums) from the quoted chords.' : 'off：引号和弦只作标签。abcjs：简单的低音/和弦伴奏。band：按引号和弦生成完整的和弦、贝斯、鼓伴奏。' }),
      [`worlds.${ID}.groove`]: field(en ? 'Band groove' : '伴奏律动', 'string', { enum: GROOVE_NAMES, description: en ? 'Used when backing=band. The groove decides the comp, bass and drum patterns.' : 'backing=band 时使用；决定和弦、贝斯和鼓的型。' }),
      [`worlds.${ID}.energy`]: field(en ? 'Band energy' : '伴奏能量', 'number', { minimum: 1, maximum: 5, description: en ? 'Used when backing=band: 1 is sparse, 5 is the busiest.' : 'backing=band 时使用：1 最稀疏，5 最满。' }),
      [`worlds.${ID}.delivery`]: field(en ? 'Audio delivery' : '音频交付方式', 'string', { enum: ['return', 'event'], description: en ? 'return: tool attachment; event: audio.abc_played event.' : 'return：工具附件；event：audio.abc_played 事件。' }),
      [`worlds.${ID}.eventDelivery`]: field(en ? 'Event destination' : '事件去向', 'string', { enum: ['archive', 'model'], description: en ? 'archive: retain only; model: deliver to the conversation.' : 'archive：只存档；model：投递到对话。' }),
    } },
  };
}
