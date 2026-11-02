import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAbc } from './abc.js';
import { AudioRenderer } from './audio.js';
import { DEFAULTS, ID, LABEL, configGroup } from './config.js';
import { SoundfontLibrary } from './soundfonts.js';
import { LEGACY_INSTRUMENTS } from './instruments.js';
import { MusicStore } from './store.js';
import { openFolder } from './open-folder.js';
import { ToolTextStore } from './tool-text.js';

export const EVENT_TYPE = 'audio.abc_played';
const AUDITION_ABC = 'X:1\nM:2/4\nL:1/4\nQ:1/4=120\nK:C\nC2 |]';
const instrumentSchema = { type: 'string', description: 'Preset ID from audio_abc_music_control action=instruments. Selects the SoundFont and default MIDI patch. Explicit ABC %%MIDI program overrides individual voices within that SoundFont.' };
const abcSchema = { type: 'string', maxLength: 48000, description: 'One complete ABC tune with X/M/L/K headers; T/Q recommended. Use V: for independent voices and [CEG] for chords. Quoted chord names are labels and do not create accompaniment.' };
const schema = properties => ({ type: 'object', additionalProperties: false, properties });
export const TOOLS = [
  {
    name: 'audio_abc_music_score', tags: ['act'],
    description: 'Validate, save or read ABC scores. Saved scores appear as sheet music in the Scores panel. Before editing, get the current score and save with expectedRevision. Audio rendering is separate. Validation and saving work without installed SoundFonts.',
    parameters: { ...schema({ action: { type: 'string', enum: ['check', 'save', 'get', 'list'] }, abc: abcSchema, id: { type: 'string' }, expectedRevision: { type: 'string' }, title: { type: 'string', maxLength: 160 }, instrument: instrumentSchema }), required: ['action'] },
    summary: { zh: '检查、保存与读取 ABC 曲谱和版本。', en: 'Validate, save and read ABC scores.' },
  },
  {
    name: 'audio_abc_music_play', tags: ['act'],
    description: 'Render a WAV in the background using an installed SoundFont. Supply exactly one of score or abc. Direct ABC is saved after rendering succeeds. Works retain the ABC snapshot and MIDI. return attaches audio to the tool receipt; event emits audio.abc_played. Playback and sending use other tools. Ask the user to obtain or import a SoundFont in Instruments when none is installed.',
    parameters: schema({ score: { type: 'string', description: 'Saved score ID.' }, abc: abcSchema, title: { type: 'string', maxLength: 160 }, instrument: instrumentSchema, delivery: { type: 'string', enum: ['return', 'event'] } }),
    summary: { zh: '把 ABC 曲谱渲染为采样音源 WAV，并保存作品。', en: 'Render ABC to sampled audio and retain a score snapshot.' },
  },
  {
    name: 'audio_abc_music_control', tags: ['act'],
    description: 'Read ABC Music status, list installed SoundFont presets, or set the default instrument and audio delivery. Use instruments before choosing a preset ID. SoundFonts are obtained or imported by the user in the Instruments panel.',
    parameters: { ...schema({ action: { type: 'string', enum: ['status', 'instruments', 'set'] }, instrument: instrumentSchema, delivery: { type: 'string', enum: ['return', 'event'] }, eventDelivery: { type: 'string', enum: ['archive', 'model'] } }), required: ['action'] },
    summary: { zh: '列出音源预设、查看状态或设置乐器与交付方式。', en: 'List SoundFont presets, read status or configure instruments and delivery.' },
  },
];

export class AbcMusicWorld {
  constructor({ cfg, dataDir, persist, botDir, packageDir, storageDir, worldId = ID } = {}) {
    this.id = worldId; this.cfg = cfg ?? { ...DEFAULTS }; this.dataDir = dataDir ?? process.cwd();
    this.persist = persist; this.host = null; this.language = 'zh';
    this.toolText = new ToolTextStore(TOOLS, { botDir, packageDir, id: ID });
    this.store = new MusicStore(storageDir || join(this.dataDir, ID));
    this.library = new SoundfontLibrary(this.store.dir, () => this.changed());
    this.migrationError = '';
    this.renderer = new AudioRenderer(); this.streams = new Set(); this.busy = false;
  }
  value(key) { return this.cfg[key] ?? DEFAULTS[key]; }
  instrument() { return this.library.resolve(this.value('instrument'), { allowMissing: true, legacyFile: basename(this.cfg.soundfont || 'GeneralUser-GS.sf2') }); }
  aliases() { return Object.fromEntries(LEGACY_INSTRUMENTS.map(item => [item.id, this.library.resolve(item.id, { allowMissing: true, legacyFile: basename(this.cfg.soundfont || 'GeneralUser-GS.sf2') }).id])); }
  status() {
    const preset = this.instrument(); let font = '', error = '';
    try { font = this.library.path(preset); } catch (err) { error = err.message; }
    return { instrument: preset.id, instrumentLabel: preset.name || preset.label || preset.id, delivery: this.value('delivery'), eventDelivery: this.value('eventDelivery'), soundfont: font, soundfontError: error, migrationError: this.migrationError, download: this.library.download, dataDir: this.library.dir, busy: this.busy, scores: this.store.listScores().length, works: this.store.listWorks().length };
  }
  changed() {
    for (const socket of this.streams) {
      try { if (socket.open) socket.send(JSON.stringify({ t: 'changed' })); } catch { this.streams.delete(socket); }
    }
  }
  set(values) {
    const patch = {};
    if (values.instrument !== undefined) patch.instrument = this.library.resolve(values.instrument).id;
    for (const [key, allowed] of [['delivery', ['return', 'event']], ['eventDelivery', ['archive', 'model']]]) {
      if (values[key] !== undefined) {
        if (!allowed.includes(values[key])) throw new Error(`${key} 只能是 ${allowed.join(' / ')}。`);
        patch[key] = values[key];
      }
    }
    if (!Object.keys(patch).length) throw new Error('请提供要修改的设置。');
    this.persist?.(patch); Object.assign(this.cfg, patch); this.changed();
    return this.status();
  }
  async compile(args, stored = null) {
    await this.library.refresh();
    const selected = this.library.resolve(args.instrument || stored?.instrument || this.value('instrument'), { allowMissing: true, legacyFile: basename(this.cfg.soundfont || 'GeneralUser-GS.sf2') });
    return compileAbc(args.abc ?? stored?.abc, { instrument: selected });
  }
  async render(args, { preview = false } = {}) {
    if (this.busy) throw new Error('正在生成音频，请稍后再试。');
    if (Boolean(args.score) === Boolean(args.abc)) throw new Error('score 与 abc 必须且只能提供一个。');
    let score = args.score ? this.store.score(args.score) : null;
    if (args.score && !score) throw new Error('找不到曲谱，请先列出乐谱。');
    this.busy = true; this.changed();
    try {
      const compiled = await this.compile(args, score);
      const font = this.library.path(this.library.resolve(compiled.summary.instrument));
      if (!preview && this.store.listWorks().length >= 200) throw new Error('已保存 200 段作品，请先整理作品。');
      if (!preview && !score && this.store.listScores().length >= 100) throw new Error('已保存 100 份曲谱，请先整理乐谱。');
      const rendered = await this.renderer.render(compiled.midi, font);
      if (preview) return rendered;
      if (!score) score = this.store.saveScore(compiled, { title: args.title });
      const item = this.store.addWork(compiled, rendered, { score, title: args.title, soundfont: basename(font) });
      return { item, bytes: rendered.wav };
    } finally { this.busy = false; this.changed(); }
  }
  async scoreTool(args) {
    if (args.action === 'list') return { text: JSON.stringify(this.store.listScores()) };
    if (args.action === 'get') {
      const score = this.store.score(args.id);
      if (!score) throw new Error('找不到曲谱。');
      return { text: JSON.stringify(score) };
    }
    if (!['check', 'save'].includes(args.action)) throw new Error('未知曲谱操作。');
    const compiled = await this.compile(args);
    if (args.action === 'check') return { text: `ABC 检查通过：${JSON.stringify(compiled.summary)}` };
    const score = this.store.saveScore(compiled, args); this.changed();
    return { text: `曲谱已保存，可在乐谱面板查看：${JSON.stringify({ ...score, abc: undefined })}` };
  }
  async playTool(args) {
    const delivery = args.delivery || this.value('delivery');
    if (!['return', 'event'].includes(delivery)) throw new Error('delivery 只能是 return / event。');
    const { item, bytes } = await this.render(args);
    const receipt = `已生成：${item.title}（${item.notes} 音，${item.voices} 声部，${item.seconds.toFixed(1)} 秒）\n作品：${item.id}\n文件：${item.path}\n曲谱版本：${item.revision}`;
    const blob = { bytes, mime: 'audio/wav', name: `${item.id}.wav`, fallbackText: `[ABC 音乐：${item.title}，${item.seconds.toFixed(1)} 秒]` };
    if (delivery === 'return') return { text: receipt, blobs: [blob] };
    if (!this.host?.pushEvent) return { text: `${receipt}\n事件未交付：World 未启动；音频已保存在作品中。`, failed: true };
    try {
      await this.host.pushEvent({ type: EVENT_TYPE, source: this.id, origin: 'external', senderKey: `${this.id}:abc:${item.id}`, ts: new Date().toISOString(), text: receipt, meta: { workId: item.id, scoreId: item.scoreId, revision: item.revision, path: item.path, instrument: item.instrument, seconds: item.seconds }, blobs: [blob] }, { deliver: this.value('eventDelivery') === 'model', trigger: 'debounce' });
    } catch (err) { return { text: `${receipt}\n事件交付失败：${err.message}；可用文件路径取回音频。`, failed: true }; }
    return { text: `${receipt}\n已交付 ${EVENT_TYPE}（${this.value('eventDelivery')}）。` };
  }
  tools() {
    return this.toolText.resolve().map((tool, index) => ({ ...tool, handler: async (args = {}) => {
      try {
        if (index === 0) return await this.scoreTool(args);
        if (index === 1) return await this.playTool(args);
        await this.library.refresh();
        if (args.action === 'status') return { text: JSON.stringify(this.status()) };
        if (args.action === 'instruments') return { text: JSON.stringify(this.library.fonts) };
        if (args.action !== 'set') throw new Error('action 只能是 status / instruments / set。');
        return { text: JSON.stringify(this.set(args)) };
      } catch (error) { return { text: `[${tool.name} 未完成] ${error.message}`, failed: true }; }
    } }));
  }
  binary(bytes, mime) { return { $binary: { mime, base64: Buffer.from(bytes).toString('base64') } }; }
  file(id, format = 'wav') {
    if (!this.store.work(id)) throw new Error('找不到作品。');
    const path = this.store.filePath(id, format);
    const mime = { wav: 'audio/wav', mid: 'audio/midi', abc: 'text/vnd.abc;charset=utf-8' }[format];
    return { $file: { path, mime, bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } };
  }
  async invoke(panel, method, args = []) {
    const input = args[0] ?? {};
    if (panel === 'tools') {
      if (method === 'list') return this.toolText.read();
      if (method === 'save') return this.toolText.save(input);
      if (method === 'reset') return this.toolText.reset(input);
    }
    if (panel === 'scores') {
      if (method === 'list') { await this.library.refresh(); return { items: this.store.listScores(), state: this.status(), fonts: this.library.fonts, instruments: this.library.items(), aliases: this.aliases() }; }
      if (method === 'get') { const score = this.store.score(input); if (!score) throw new Error('找不到曲谱。'); return score; }
      if (method === 'check') return (await this.compile(input)).summary;
      if (method === 'save') { const score = this.store.saveScore(await this.compile(input), input); this.changed(); return score; }
      if (method === 'remove') { const result = this.store.remove('scores', input); this.changed(); return result; }
      if (method === 'preview') return this.binary((await this.render(input, { preview: true })).wav, 'audio/wav');
      if (method === 'render') return (await this.render(input)).item;
    }
    if (panel === 'works') {
      if (method === 'openFolder') return openFolder(join(this.store.dir, 'works'));
      if (method === 'list') return { items: this.store.listWorks() };
      if (method === 'get') { const item = this.store.work(input); if (!item) throw new Error('找不到作品。'); return item; }
      if (method === 'file') return this.file(input.id, input.format);
      if (method === 'remove') { const result = this.store.remove('works', input); this.changed(); return result; }
    }
    if (panel === 'instruments') {
      if (method === 'list') { await this.library.refresh(); return { items: this.library.items(), fonts: this.library.fonts, state: this.status() }; }
      if (method === 'import') return this.library.importFile(input);
      if (method === 'download') return this.library.getGeneralUser();
      if (method === 'openFolder') return openFolder(this.library.dir);
      if (method === 'select') return this.set({ instrument: input });
      if (method === 'preview') return this.binary((await this.render({ abc: AUDITION_ABC, instrument: input }, { preview: true })).wav, 'audio/wav');
    }
    throw new Error(`未知面板方法：${panel}.${method}`);
  }
  webUi(language = 'zh') {
    this.language = language;
    const state = this.status(), en = language === 'en';
    return {
      label: en ? 'ABC Music' : LABEL,
      lamps: [{ label: en ? 'SoundFont' : '采样音源', state: state.download && !state.download.error ? 'loading' : (state.soundfontError ? 'offline' : (state.busy ? 'loading' : 'online')), hint: state.soundfontError || basename(state.soundfont) }],
      badges: [{ label: en ? 'Scores' : '乐谱', value: state.scores, tone: 'on' }, { label: en ? 'Works' : '作品', value: state.works, tone: 'on' }, { label: en ? 'Instrument' : '乐器', value: state.instrumentLabel || (en ? 'None' : '未选择'), tone: 'plain' }],
      panels: [{ id: 'scores', title: en ? 'Scores' : '乐谱', getMethods: ['list', 'get'] }, { id: 'works', title: en ? 'Works' : '作品', getMethods: ['list', 'get'] }, { id: 'instruments', title: en ? 'Instruments' : '乐器', getMethods: ['list'] }, { id: 'tools', title: en ? 'Tools' : '工具', getMethods: ['list'] }],
      config: [configGroup(language)],
      promptDocs: [{ key: `worlds.${ID}.env`, title: en ? 'Prompt' : '提示词', path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)), role: 'envPrompt' }],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      stream: (panel, socket) => this.stream(panel, socket),
    };
  }
  stream(panel, socket) {
    if (!['scores', 'works', 'instruments'].includes(panel)) throw new Error('未知面板。');
    this.streams.add(socket); socket.send(JSON.stringify({ t: 'ready' }));
    socket.onClose(() => this.streams.delete(socket));
  }
  envPromptVars() { return {}; }
  async start(host) {
    this.host = host;
    if (this.cfg.soundfont) {
      await this.library.refresh();
      if (!this.library.fonts.some(font => font.file === basename(this.cfg.soundfont) && !font.error)) {
        try { await this.library.importFile(this.cfg.soundfont); } catch (error) { this.migrationError = error.message; }
      }
    }
    await this.library.refresh();
    host?.log?.info?.('ABC 音乐已就绪');
  }
  async stop() { this.library.stop(); await this.library.downloading?.catch(() => {}); this.renderer.stop(); this.host = null; for (const socket of this.streams) socket.close(); this.streams.clear(); }
}
