export const LEGACY_INSTRUMENTS = [
  { id: 'nylon-guitar', program: 24, label: '尼龙弦吉他', en: 'Nylon guitar' },
  { id: 'steel-guitar', program: 25, label: '钢弦吉他', en: 'Steel guitar' },
  { id: 'piano', program: 0, label: '钢琴', en: 'Grand piano' },
  { id: 'electric-piano', program: 4, label: '电钢琴', en: 'Electric piano' },
  { id: 'violin', program: 40, label: '小提琴', en: 'Violin' },
  { id: 'strings', program: 48, label: '弦乐合奏', en: 'Strings' },
  { id: 'flute', program: 73, label: '长笛', en: 'Flute' },
  { id: 'bass', program: 32, label: '原声贝斯', en: 'Acoustic bass' },
];
export function instrumentOf(id = 'nylon-guitar') {
  if (id && typeof id === 'object') return id;
  if (!id) return { id: '', program: 0, bankMSB: 0, bankLSB: 0, isGMGSDrum: false };
  const match = /^sf:([^:]+):(\d+):(\d+):(\d+):([01])$/.exec(id);
  if (match) {
    const file = decodeURIComponent(match[1]), [bankMSB, bankLSB, program] = match.slice(2, 5).map(Number);
    if (file && !/[\\/]/.test(file) && !['.', '..'].includes(file) && [bankMSB, bankLSB, program].every(value => value >= 0 && value <= 127)) return { id, file, bankMSB, bankLSB, program, isGMGSDrum: match[5] === '1' };
  }
  const found = LEGACY_INSTRUMENTS.find(one => one.id === id);
  if (!found) throw new Error(`未知乐器 ${id}；请先列出已安装的音源预设。`);
  return found;
}
export const presetId = (file, preset) => `sf:${encodeURIComponent(file)}:${preset.bankMSB}:${preset.bankLSB}:${preset.program}:${preset.isGMGSDrum ? 1 : 0}`;
