const titleLine = /^T:[^\r\n]*/m;

export function scoreTitle(abc) {
  return (abc.match(titleLine)?.[0].slice(2).trim() ?? '').slice(0, 160);
}
