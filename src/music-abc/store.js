import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const revisionOf = abc => createHash('sha256').update(abc).digest('hex').slice(0, 16);
const newId = () => randomUUID().replaceAll('-', '').slice(0, 16);
export class MusicStore {
  constructor(dir) { this.dir = dir; this.loaded = false; this.data = { version: 1, scores: [], works: [], drafts: [] }; }
  load() {
    if (this.loaded) return;
    const path = join(this.dir, 'index.json');
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.scores) || !Array.isArray(parsed.works)) throw new Error('ABC 音乐索引格式不正确，请检查 index.json。');
      this.data = { ...parsed, drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [] };
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
  listDrafts() { this.load(); return this.data.drafts.map(({ abc, ...one }) => structuredClone(one)); }
  score(id) { this.load(); return structuredClone(this.data.scores.find(one => one.id === id) ?? null); }
  work(id) { this.load(); return structuredClone(this.data.works.find(one => one.id === id) ?? null); }
  draft(id) { this.load(); return structuredClone(this.data.drafts.find(one => one.id === id) ?? null); }
  saveDraft(abc, { id = '', title = '', instrument = '', problems = [] } = {}) {
    this.load();
    const text = String(abc ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new Error('草稿为空。');
    const revision = revisionOf(text);
    const previous = id ? this.draft(id) : this.data.drafts.find(one => one.revision === revision);
    const now = new Date().toISOString();
    const titleText = String(title || previous?.title || '未命名草稿').slice(0, 160);
    const entry = {
      id: previous?.id || newId(),
      revision,
      title: titleText,
      instrument: String(instrument || previous?.instrument || ''),
      abc: text,
      problems: problems.slice(0, 100).map(problem => String(problem).slice(0, 500)),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    if (!previous && this.data.drafts.length >= 100) throw new Error('已保存 100 份草稿，请先整理。');
    this.commit({ ...this.data, drafts: [entry, ...this.data.drafts.filter(one => one.id !== entry.id)] });
    return structuredClone(entry);
  }
  removeDraft(id) {
    this.load();
    if (!this.data.drafts.some(one => one.id === id)) throw new Error('找不到草稿。');
    this.commit({ ...this.data, drafts: this.data.drafts.filter(one => one.id !== id) });
    return { ok: true };
  }
  /** A successful save makes the matching failed draft redundant. */
  removeDraftsForAbc(abc) {
    this.load();
    const revision = revisionOf(String(abc ?? '').replace(/\r\n?/g, '\n').trim());
    const drafts = this.data.drafts.filter(one => one.revision !== revision);
    if (drafts.length !== this.data.drafts.length) this.commit({ ...this.data, drafts });
  }
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
    if (!/^[0-9a-f]{16}$/.test(String(id)) || format !== 'wav') throw new Error('无效作品或文件格式。');
    return join(this.dir, 'works', `${id}.${format}`);
  }
  addWork(compiled, rendered, { score = null, title = '', soundfont = '' } = {}) {
    this.load();
    if (this.data.works.length >= 200) throw new Error('已保存 200 段作品，请先整理作品。');
    const id = newId();
    const facts = compiled.facts;
    const entry = {
      id, title: String(title || score?.title || compiled.summary.title).slice(0, 160),
      revision: score?.revision || revisionOf(compiled.abc), scoreId: score?.id || '',
      instrument: compiled.summary.instrument, instrumentLabel: compiled.summary.instrumentLabel, soundfont, seconds: rendered.seconds,
      notes: compiled.summary.notes, voices: compiled.summary.voices,
      backing: compiled.summary.backing || 'off', backingNotes: compiled.summary.backingNotes || 0,
      groove: compiled.summary.groove || '', energy: compiled.summary.energy,
      sections: compiled.summary.sections || [],
      analysis: facts ? {
        bars: facts.bars,
        beatsPerBar: facts.beatsPerBar,
        outOfRange: facts.voices.reduce((sum, voice) => sum + voice.outOfRange, 0),
        outside: facts.outside.length,
        repeatedBars: facts.main?.identicalBars.reduce((sum, group) => sum + group.length, 0) ?? 0,
        distinctRhythms: facts.main?.distinct ?? 0,
        backing: compiled.summary.backing || 'off',
        backingNotes: compiled.summary.backingNotes || 0,
        groove: compiled.summary.groove || '',
        energy: compiled.summary.energy,
        rmsDb: rendered.rmsDb,
        peakDb: rendered.peakDb,
      } : undefined,
      bytes: rendered.wav.length, createdAt: new Date().toISOString(),
    };
    mkdirSync(join(this.dir, 'works'), { recursive: true });
    try {
      writeFileSync(this.filePath(id, 'wav'), rendered.wav);
      this.commit({ ...this.data, works: [entry, ...this.data.works] });
    } catch (error) {
      rmSync(this.filePath(id, 'wav'), { force: true });
      throw error;
    }
    return { ...entry, path: this.filePath(id, 'wav') };
  }
  remove(kind, id) {
    this.load();
    if (!['scores', 'works'].includes(kind)) throw new Error('无效记录类型。');
    if (!this.data[kind].some(one => one.id === id)) throw new Error('找不到记录。');
    this.commit({ ...this.data, [kind]: this.data[kind].filter(one => one.id !== id) });
    if (kind === 'works') for (const extension of ['wav', 'mid', 'abc']) rmSync(join(this.dir, 'works', `${id}.${extension}`), { force: true });
    return { ok: true };
  }
}
