/**
 * Named section blocks for partial ABC revisions.
 *
 *   % block: A
 *   |: ... :|
 *   % end: A
 *
 * The markers are comments, so abcjs engraves and plays the music unchanged.
 * `revise` replaces only the lines between one pair of markers.
 */

const NAME = String.raw`[\p{L}\p{N}_.-]+`;
const START = new RegExp(String.raw`^\s*%\s*block\s*:?\s*(${NAME})\s*$`, 'iu');
const END = new RegExp(String.raw`^\s*%\s*end\s*:?\s*(${NAME})\s*$`, 'iu');

export function listBlocks(abc) {
  const names = [];
  for (const line of String(abc).split('\n')) {
    const match = START.exec(line);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** Replaces the body between `% block: name` and `% end: name`. */
export function replaceBlock(abc, name, body) {
  const wanted = String(name || '').trim();
  if (!wanted) throw new Error('请提供要替换的 block 名字。');
  const lines = String(abc).replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex(line => {
    const match = START.exec(line);
    return match && match[1] === wanted;
  });
  if (start < 0) throw new Error(`找不到块 "${wanted}"；现有块：${listBlocks(abc).join('、') || '无'}。`);
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const match = END.exec(line);
    return match && match[1] === wanted;
  });
  if (end < 0) throw new Error(`块 "${wanted}" 缺少 "% end: ${wanted}"。`);
  const replacement = String(body ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '').split('\n');
  return [...lines.slice(0, start + 1), ...replacement, ...lines.slice(end)].join('\n');
}
