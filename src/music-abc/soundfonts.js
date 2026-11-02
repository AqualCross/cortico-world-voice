import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { instrumentOf, presetId } from './instruments.js';

export const GENERAL_USER = Object.freeze(JSON.parse(readFileSync(new URL('../../assets/music-abc/manifest.json', import.meta.url), 'utf8')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const supported = file => ['.sf2', '.sf3'].includes(extname(file).toLowerCase());

export function inspectSoundfont(path) {
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(new URL('./soundfont-info.js', import.meta.url), { workerData: { path }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(error); else resolveResult(data);
    };
    const timer = setTimeout(() => finish(new Error('读取音源超过 30 秒。')), 30000);
    worker.once('message', data => finish(data.error ? new Error(data.error) : null, data));
    worker.once('error', error => finish(error));
    worker.once('exit', code => finish(new Error(`读取音源已停止（${code}）。`)));
  });
}

/** The filename and MIDI patch identify a preset across refreshes and restarts. */
export class SoundfontLibrary {
  constructor(dir, changed = () => {}, { downloadSpec = GENERAL_USER, fetcher = fetch } = {}) {
    this.dir = dir; this.changed = changed; this.fonts = []; this.cache = new Map(); this.scanning = null;
    this.download = null; this.downloading = null; this.abort = null;
    this.downloadSpec = downloadSpec; this.fetcher = fetcher;
  }
  items() { return this.fonts.flatMap(font => font.presets); }
  async refresh() {
    if (this.scanning) return this.scanning;
    this.scanning = this.scan();
    try { return await this.scanning; } finally { this.scanning = null; }
  }
  async scan() {
    let entries;
    try { entries = await readdir(this.dir, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
    const fonts = [];
    for (const entry of entries.filter(entry => entry.isFile() && supported(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = entry.name, path = join(this.dir, file);
      try {
        const info = await stat(path), key = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        let cached = this.cache.get(file);
        if (cached?.key !== key) {
          try {
            const data = await inspectSoundfont(path);
            cached = { key, font: { file, name: data.name || file, bytes: info.size, presets: data.presets.map(preset => ({ ...preset, id: presetId(file, preset), file, label: preset.name, en: preset.name })) } };
          } catch (error) { cached = { key, font: { file, name: file, bytes: info.size, error: error.message, presets: [] } }; }
          this.cache.set(file, cached);
        }
        fonts.push(cached.font);
      } catch (error) { fonts.push({ file, name: file, error: error.message, presets: [] }); }
    }
    this.fonts = fonts;
    for (const file of this.cache.keys()) if (!fonts.some(font => font.file === file)) this.cache.delete(file);
    return fonts;
  }
  resolve(id = '', { allowMissing = false, legacyFile = GENERAL_USER.file } = {}) {
    if (!id) return this.items()[0] || instrumentOf('');
    const parsed = instrumentOf(id), exact = this.items().find(item => item.id === id);
    if (exact) return exact;
    if (!parsed.file) {
      const legacy = this.items().find(item => item.file === legacyFile && item.bankMSB === 0 && item.bankLSB === 0 && !item.isGMGSDrum && item.program === parsed.program);
      if (legacy) return legacy;
    }
    if (allowMissing) return parsed;
    throw new Error(`找不到乐器 ${id}。请在乐器页导入对应音源，或重新选择乐器。`);
  }
  path(preset) {
    if (!preset.file || !this.items().some(item => item.id === preset.id)) throw new Error('请先在乐器页获取 GeneralUser GS 或导入 SF2 / SF3 音源。');
    return join(this.dir, preset.file);
  }
  async importFile(source) {
    if (!isAbsolute(String(source)) || !supported(source)) throw new Error('请选择 SF2 / SF3 文件的绝对路径。');
    const destination = join(this.dir, basename(source));
    await inspectSoundfont(source);
    if (resolve(source) === resolve(destination)) { await this.refresh(); return this.fonts.find(font => font.file === basename(source)); }
    await mkdir(this.dir, { recursive: true });
    try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (hash(await readFile(source)) !== hash(await readFile(destination))) throw new Error('已有同名音源文件，请重命名后再导入。');
    }
    await this.scanning; await this.refresh(); this.changed();
    return this.fonts.find(font => font.file === basename(source));
  }
  async getGeneralUser() {
    if (this.downloading) return this.downloading;
    this.downloading = this.fetchGeneralUser();
    try { return await this.downloading; } finally { this.downloading = null; }
  }
  async fetchGeneralUser() {
    const meta = this.downloadSpec, destination = join(this.dir, meta.file), temp = join(this.dir, `${meta.file}.download`);
    this.download = { percent: 0 }; this.changed();
    this.abort = new AbortController();
    const timer = setTimeout(() => this.abort?.abort(), 300000);
    let handle;
    try {
      await mkdir(this.dir, { recursive: true });
      let existing;
      try { existing = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) {
        if (hash(existing) !== meta.sha256) throw new Error('已有同名音源与下载版本不同，请先重命名该文件。');
      } else {
        const url = `https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/${meta.commit}/${meta.file}`;
        let response;
        try { response = await this.fetcher(url, { signal: this.abort.signal }); }
        catch (error) {
          if (this.abort.signal.aborted) throw error;
          const api = `https://api.github.com/repos/mrbumpy409/GeneralUser-GS/contents/${meta.file}?ref=${meta.commit}`;
          response = await this.fetcher(api, { signal: this.abort.signal, headers: { Accept: 'application/vnd.github.raw+json' } });
        }
        if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）。`);
        handle = await open(temp, 'w');
        let size = 0; const digest = createHash('sha256');
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > meta.bytes) throw new Error('下载文件大小与记录不符。');
          digest.update(chunk); await handle.writeFile(chunk);
          const percent = Math.floor(size / meta.bytes * 100);
          if (percent !== this.download.percent) { this.download = { percent }; this.changed(); }
        }
        await handle.close(); handle = null;
        if (size !== meta.bytes || digest.digest('hex') !== meta.sha256) throw new Error('音源校验失败，请重新获取。');
        await inspectSoundfont(temp);
        await copyFile(temp, destination, constants.COPYFILE_EXCL);
      }
      await copyFile(new URL('../../assets/music-abc/GeneralUser-GS-LICENSE.txt', import.meta.url), join(this.dir, meta.license));
      await this.scanning; await this.refresh(); this.download = null;
      return this.fonts.find(font => font.file === meta.file);
    } catch (error) {
      const failure = new Error(`获取音源失败：${error.message}${error.cause?.code ? `（${error.cause.code}）` : ''}。可重试，或下载 SF2 后使用“导入音源”。`);
      this.download = { error: failure.message }; throw failure;
    }
    finally { clearTimeout(timer); this.abort = null; await handle?.close(); await rm(temp, { force: true }); this.changed(); }
  }
  stop() { this.abort?.abort(); }
}
