import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const revisionOf = abc => createHash('sha256').update(abc).digest('hex').slice(0, 16);
const newId = () => randomUUID().replaceAll('-', '').slice(0, 16);
export class MusicStore {
  constructor(dir) { this.dir = dir; this.loaded = false; this.data = { version: 1, scores: [], works: [] }; }
  load() {
    if (this.loaded) return;
    const path = join(this.dir, 'index.json');
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.scores) || !Array.isArray(parsed.works)) throw new Error('ABC 音乐索引格式不正确，请检查 index.json。');
      this.data = parsed;
    }
    this.loaded = true;
  }
  commit(next) {
    mkdirSync(this.dir, { recursive: true });
    const temp = join(this.dir, 'index.json.tmp');
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n');
    renameSync(temp, join(this.dir, 'index.json'));
    this.data = next;
  }
  listScores() { this.load(); return this.data.scores.map(({ abc, ...one }) => structuredClone(one)); }
  listWorks() { this.load(); return this.data.works.map(({ abc, ...one }) => ({ ...structuredClone(one), path: this.filePath(one.id, 'wav') })); }
  score(id) { this.load(); return structuredClone(this.data.scores.find(one => one.id === id) ?? null); }
  work(id) { this.load(); return structuredClone(this.data.works.find(one => one.id === id) ?? null); }
  saveScore(compiled, { id = '', expectedRevision = '', title = '' } = {}) {
    this.load();
    const previous = id ? this.score(id) : null;
    if (id && !previous) throw new Error('找不到要修改的曲谱。');
    if (previous && expectedRevision !== previous.revision) throw new Error(`曲谱已更新，请重新读取后保存；当前 revision=${previous.revision}。`);
    if (!previous && this.data.scores.length >= 100) throw new Error('已保存 100 份曲谱，请先整理乐谱。');
    const now = new Date().toISOString();
    const titleText = String(title || compiled.summary.title).slice(0, 160);
    const entry = {
      id: previous?.id || newId(), revision: revisionOf(JSON.stringify({ abc: compiled.abc, title: titleText, instrument: compiled.summary.instrument })),
      title: titleText, abc: compiled.abc,
      ...compiled.summary, createdAt: previous?.createdAt || now, updatedAt: now,
    };
    entry.title = titleText;
    this.commit({ ...this.data, scores: [entry, ...this.data.scores.filter(one => one.id !== entry.id)] });
    return structuredClone(entry);
  }
  filePath(id, format) {
    if (!/^[0-9a-f]{16}$/.test(String(id)) || !['wav', 'mid', 'abc'].includes(format)) throw new Error('无效作品或文件格式。');
    return join(this.dir, 'works', `${id}.${format}`);
  }
  addWork(compiled, rendered, { score = null, title = '', soundfont = '' } = {}) {
    this.load();
    if (this.data.works.length >= 200) throw new Error('已保存 200 段作品，请先整理作品。');
    const id = newId();
    const entry = {
      id, title: String(title || score?.title || compiled.summary.title).slice(0, 160),
      abc: compiled.abc, revision: score?.revision || revisionOf(compiled.abc), scoreId: score?.id || '',
      instrument: compiled.summary.instrument, instrumentLabel: compiled.summary.instrumentLabel, soundfont, seconds: rendered.seconds,
      notes: compiled.summary.notes, voices: compiled.summary.voices,
      bytes: rendered.wav.length, createdAt: new Date().toISOString(),
    };
    mkdirSync(join(this.dir, 'works'), { recursive: true });
    try {
      writeFileSync(this.filePath(id, 'wav'), rendered.wav);
      writeFileSync(this.filePath(id, 'mid'), compiled.midi);
      writeFileSync(this.filePath(id, 'abc'), compiled.abc);
      this.commit({ ...this.data, works: [entry, ...this.data.works] });
    } catch (error) {
      for (const format of ['wav', 'mid', 'abc']) rmSync(this.filePath(id, format), { force: true });
      throw error;
    }
    return { ...entry, path: this.filePath(id, 'wav') };
  }
  remove(kind, id) {
    this.load();
    if (!['scores', 'works'].includes(kind)) throw new Error('无效记录类型。');
    if (!this.data[kind].some(one => one.id === id)) throw new Error('找不到记录。');
    this.commit({ ...this.data, [kind]: this.data[kind].filter(one => one.id !== id) });
    if (kind === 'works') for (const format of ['wav', 'mid', 'abc']) rmSync(this.filePath(id, format), { force: true });
    return { ok: true };
  }
}
