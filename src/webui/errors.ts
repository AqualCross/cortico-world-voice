/** 界面上的错误只占一行：压平、截断；被截掉的原文交给「复制错误信息」。 */
const LINE_MAX = 90;

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function summarizeError(text: string): string {
  const flat = flatten(text);
  return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX)}…` : flat;
}

export function errorOverflow(text: string): boolean {
  return flatten(text).length > LINE_MAX;
}
