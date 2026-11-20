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

/**
 * Usual written range of a General MIDI program, in MIDI note numbers. These are
 * report-only bounds: a note outside them still renders. Programs without an entry
 * (including drums) are not checked.
 */
const RANGES = new Map([
  [0, [28, 103]], [4, [36, 96]], [6, [36, 89]], [8, [60, 108]], [9, [72, 108]],
  [10, [60, 96]], [11, [53, 89]], [12, [45, 96]], [16, [36, 96]], [21, [53, 89]],
  [22, [60, 96]], [24, [40, 84]], [25, [40, 84]], [26, [40, 84]], [27, [40, 86]],
  [29, [40, 86]], [32, [28, 55]], [33, [28, 60]], [35, [28, 60]], [38, [28, 60]],
  [40, [55, 100]], [41, [48, 88]], [42, [36, 76]], [45, [36, 96]], [46, [31, 100]],
  [48, [36, 96]], [52, [48, 81]], [56, [55, 84]], [57, [40, 72]], [59, [55, 84]],
  [60, [41, 77]], [61, [40, 84]], [64, [56, 87]], [65, [49, 80]], [66, [44, 75]],
  [68, [58, 91]], [71, [50, 91]], [72, [74, 108]], [73, [60, 96]], [74, [60, 96]],
  [75, [60, 96]], [77, [55, 91]], [78, [60, 96]], [79, [60, 91]], [80, [48, 96]],
  [81, [48, 96]], [89, [36, 96]], [107, [43, 91]], [108, [48, 96]], [114, [52, 89]],
]);

export function rangeOfProgram(program) {
  return RANGES.get(Number(program)) ?? null;
}
