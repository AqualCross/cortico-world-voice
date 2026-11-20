import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAbc } from './abc.js';
import { listBlocks, replaceBlock } from './blocks.js';
import { AudioRenderer } from './audio.js';
import { GROOVE_NAMES } from './band.js';
import { DEFAULTS, ID, LABEL, configGroup } from './config.js';
import { describeFacts } from './facts.js';
import { SoundfontLibrary } from './soundfonts.js';
import { LEGACY_INSTRUMENTS } from './instruments.js';
import { MusicStore } from './store.js';
import { openFolder } from './open-folder.js';
import { ToolTextStore } from './tool-text.js';

export const EVENT_TYPE = 'audio.abc_played';
const AUDITION_ABC = 'X:1\nM:2/4\nL:1/4\nQ:1/4=120\nK:C\nC2 |]';
const instrumentSchema = { type: 'string', description: 'Preset ID from audio_abc_music_control action=instruments. Selects the SoundFont and default MIDI patch. Explicit ABC %%MIDI program overrides individual voices within that SoundFont.' };
const backingSchema = { type: 'string', enum: ['off', 'abcjs', 'band'], description: 'off: quoted chord names are labels only. abcjs: a simple bass/chord backing from abcjs. band: the full groove band (comp, bass, drums, fills) arranged from the quoted chord names. The written ABC is unchanged; the backing only exists in the rendered MIDI/WAV.' };
const grooveSchema = { type: 'string', enum: GROOVE_NAMES, description: 'Groove for backing=band: pop, rock, ballad, bossa, samba, swing, waltz, funk, lofi, dance, ambient, or none. Meter-specific grooves must fit the tune.' };
const energySchema = { type: 'integer', minimum: 1, maximum: 5, description: 'Band energy for backing=band: 1 is the sparsest version of the groove, 5 the busiest.' };
const sectionsSchema = {
  type: 'array', maxItems: 32,
  description: 'Optional per-section overrides for backing=band. Bars are 1-based performance bars (a pickup counts as bar 1). A section without groove or energy inherits the top-level value.',
  items: {
    type: 'object', additionalProperties: false,
    properties: {
      fromBar: { type: 'integer', minimum: 1 },
      toBar: { type: 'integer', minimum: 1 },
      groove: { type: 'string', enum: GROOVE_NAMES },
      energy: { type: 'integer', minimum: 1, maximum: 5 },
      stopBars: {
        type: 'array', maxItems: 64,
        description: 'Absolute 1-based performance bars in this section where the band plays one hit on beat 1 and then rests; the written ABC continues.',
        items: { type: 'integer', minimum: 1 },
      },
    },
    required: ['fromBar', 'toBar'],
  },
};
const abcSchema = { type: 'string', maxLength: 48000, description: 'For check/save: one complete ABC tune with X/M/L/K headers; T/Q recommended. For action=revise: only the new body of the named block. Use V: for independent voices and [CEG] for chords. Define motifs with comment lines "% motif name: ..."; the motif body is ordinary ABC music (note lengths and z rests, not a compose slot grid). Write @name, @name+1 or @name-1 alone in a bar to reuse and transpose them by scale steps. Wrap sections between "% block: A" and "% end: A" to revise one section without resending the score. Quoted chord names are labels and drive accompaniment only when backing is abcjs or band; the receipt checks long and downbeat notes against them.' };
const schema = properties => ({ type: 'object', additionalProperties: false, properties });
export const TOOLS = [
  {
    name: 'audio_abc_music_score', tags: ['act'],
    description: 'Validate, save, revise or read ABC scores and drafts. Saved scores appear as sheet music in the Scores panel. Before editing, get the current score and save with expectedRevision. A rejected score is kept as a draft; list drafts with action=drafts and fetch one with action=draft. Use action=revise with a block marker (% block: A ... % end: A) to replace only one section; block names are listed when a block is missing. backing selects whether quoted chords only label the score (off), drive abcjs backing (abcjs), or drive the full groove band (band). groove, energy and sections are the band settings. Audio rendering is separate. Validation and saving work without installed SoundFonts.',
    parameters: {
      ...schema({
        action: { type: 'string', enum: ['check', 'save', 'revise', 'get', 'list', 'drafts', 'draft'] },
        abc: abcSchema, id: { type: 'string' }, block: { type: 'string', description: 'For action=revise: the name between "% block: name" and "% end: name".' }, expectedRevision: { type: 'string' }, title: { type: 'string', maxLength: 160 },
        instrument: instrumentSchema, backing: backingSchema, groove: grooveSchema, energy: energySchema, sections: sectionsSchema,
      }),
      required: ['action'],
    },
    summary: { zh: '检查、保存与读取 ABC 曲谱、版本和草稿。', en: 'Validate, save and read ABC scores and drafts.' },
  },
  {
    name: 'audio_abc_music_play', tags: ['act'],
    description: 'Render a WAV in the background using an installed SoundFont. Supply exactly one of score or abc. Direct ABC is saved after rendering succeeds. The receipt carries measured facts: length, voices, ranges, notes outside an instrument range, repeated bars, rhythm variety, steps and leaps, chromatic notes outside a quoted chord, and the rendered level and peak. backing=band arranges the full comp, bass and drum band from the quoted chords with the selected groove and energy; backing=abcjs asks abcjs for a simple bass/chord backing; off keeps quoted chords as labels. Works retain the ABC snapshot and MIDI. return attaches audio to the tool receipt; event emits audio.abc_played. Playback and sending use other tools. Ask the user to obtain or import a SoundFont in Instruments when none is installed.',
    parameters: schema({
      score: { type: 'string', description: 'Saved score ID.' }, abc: abcSchema, title: { type: 'string', maxLength: 160 },
      instrument: instrumentSchema, backing: backingSchema, groove: grooveSchema, energy: energySchema, sections: sectionsSchema,
      delivery: { type: 'string', enum: ['return', 'event'] },
    }),
    summary: { zh: '把 ABC 曲谱渲染为采样音源 WAV，回执带测量结果，并保存作品。', en: 'Render ABC to sampled audio, retain a score snapshot and report measured facts.' },
  },
  {
    name: 'audio_abc_music_control', tags: ['act'],
    description: 'Read ABC Music status, list installed SoundFont presets, or set the default instrument, backing mode, band groove, band energy and audio delivery. Use instruments before choosing a preset ID. SoundFonts are obtained or imported by the user in the Instruments panel.',
    parameters: { ...schema({ action: { type: 'string', enum: ['status', 'instruments', 'set'] }, instrument: instrumentSchema, backing: backingSchema, groove: grooveSchema, energy: energySchema, delivery: { type: 'string', enum: ['return', 'event'] }, eventDelivery: { type: 'string', enum: ['archive', 'model'] } }), required: ['action'] },
    summary: { zh: '列出音源预设、查看状态或设置乐器、伴奏与交付方式。', en: 'List SoundFont presets, read status or configure instruments, backing and delivery.' },
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
    return { instrument: preset.id, instrumentLabel: preset.name || preset.label || preset.id, delivery: this.value('delivery'), eventDelivery: this.value('eventDelivery'), backing: this.value('backing'), groove: this.value('groove'), energy: this.value('energy'), soundfont: font, soundfontError: error, migrationError: this.migrationError, download: this.library.download, dataDir: this.library.dir, busy: this.busy, scores: this.store.listScores().length, works: this.store.listWorks().length, drafts: this.store.listDrafts().length };
  }
  changed() {
    for (const socket of this.streams) {
      try { if (socket.open) socket.send(JSON.stringify({ t: 'changed' })); } catch { this.streams.delete(socket); }
    }
  }
  set(values) {
    const patch = {};
    if (values.instrument !== undefined) patch.instrument = this.library.resolve(values.instrument).id;
    if (values.backing !== undefined) {
      if (!['off', 'abcjs', 'band'].includes(values.backing)) throw new Error('backing 只能是 off / abcjs / band。');
      patch.backing = values.backing;
    }
    if (values.groove !== undefined) {
      const groove = String(values.groove).toLowerCase();
      if (!GROOVE_NAMES.includes(groove)) throw new Error(`groove 只能是 ${GROOVE_NAMES.join(' / ')}。`);
      patch.groove = groove;
    }
    if (values.energy !== undefined) {
      const energy = Math.round(Number(values.energy));
      if (!(energy >= 1 && energy <= 5)) throw new Error('energy 只能是 1–5 的整数。');
      patch.energy = energy;
    }
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
    const backing = args.backing || stored?.backing || this.value('backing') || 'off';
    if (!['off', 'abcjs', 'band'].includes(backing)) throw new Error('backing 只能是 off / abcjs / band。');
    const groove = args.groove || stored?.groove || this.value('groove') || 'pop';
    const energy = args.energy ?? stored?.energy ?? this.value('energy') ?? 3;
    const sections = Array.isArray(args.sections) ? args.sections : (Array.isArray(stored?.sections) ? stored.sections : []);
    return compileAbc(args.abc ?? stored?.abc, { instrument: selected, backing, groove, energy, sections });
  }
  async render(args, { preview = false } = {}) {
    if (this.busy) throw new Error('正在生成音频，请稍后再试。');
    if (Boolean(args.score) === Boolean(args.abc)) throw new Error('score 与 abc 必须且只能提供一个。');
    let score = args.score ? this.store.score(args.score) : (args.id ? this.store.score(args.id) : null);
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
      this.store.removeDraftsForAbc(compiled.abc);
      const item = this.store.addWork(compiled, rendered, { score, title: args.title, soundfont: basename(font) });
      return { item, bytes: rendered.wav, facts: compiled.facts, rendered };
    } finally { this.busy = false; this.changed(); }
  }
  draftFor(args, error) {
    const abc = typeof args.abc === 'string' ? args.abc : (args.score ? this.store.score(args.score)?.abc : '');
    if (!abc || !String(abc).trim()) return null;
    try {
      return this.store.saveDraft(abc, { title: args.title, instrument: args.instrument, problems: error.problems });
    } catch {
      return null;
    }
  }
  async scoreTool(args) {
    if (args.action === 'list') return { text: JSON.stringify(this.store.listScores()) };
    if (args.action === 'drafts') return { text: JSON.stringify(this.store.listDrafts()) };
    if (args.action === 'get') {
      const score = this.store.score(args.id);
      if (score) return { text: JSON.stringify(score) };
      const draft = this.store.draft(args.id);
      if (draft) return { text: JSON.stringify({ ...draft, draft: true }) };
      throw new Error('找不到曲谱或草稿。');
    }
    if (args.action === 'draft') {
      const draft = this.store.draft(args.id);
      if (!draft) throw new Error('找不到草稿。');
      return { text: JSON.stringify({ ...draft, draft: true }) };
    }
    if (args.action === 'revise') {
      const score = this.store.score(args.id);
      if (!score) throw new Error('找不到要修改的曲谱。');
      if (args.expectedRevision && args.expectedRevision !== score.revision) throw new Error(`曲谱已更新，请重新读取后保存；当前 revision=${score.revision}。`);
      if (!String(args.block || '').trim()) return { failed: true, text: '[未修改] 请提供 block 名字。' };
      if (!String(args.abc || '').trim()) return { failed: true, text: '[未修改] 请提供 block 的新内容。' };
      let revised;
      try {
        revised = replaceBlock(score.abc, args.block, args.abc);
      } catch (error) {
        return { failed: true, text: `[未修改] ${error.message}` };
      }
      const request = { ...args, abc: revised };
      try {
        const compiled = await this.compile(request, score);
        const facts = describeFacts(compiled.facts);
        const saved = this.store.saveScore(compiled, { id: score.id, expectedRevision: args.expectedRevision || score.revision, title: args.title || score.title });
        this.store.removeDraftsForAbc(compiled.abc); this.changed();
        return { text: `块 "${args.block}" 已替换并保存。曲谱版本：${saved.revision}\n${facts.join('\n')}` };
      } catch (error) {
        if (Array.isArray(error?.problems)) {
          const draft = this.draftFor(request, error); this.changed();
          const kept = draft ? `\n草稿已保留：${draft.id}（action=draft, id=${draft.id}；或 action=get, id=${draft.id}）` : '';
          return { failed: true, text: `[未保存] 替换后的谱子有 ${error.problems.length} 个问题：\n- ${error.problems.join('\n- ')}${kept}` };
        }
        throw error;
      }
    }
    if (!['check', 'save'].includes(args.action)) throw new Error('未知曲谱操作。');
    try {
      const stored = args.id ? this.store.score(args.id) : null;
      const compiled = await this.compile(args, stored);
      const facts = describeFacts(compiled.facts);
      if (args.action === 'check') {
        this.store.removeDraftsForAbc(compiled.abc);
        return { text: `ABC 检查通过：${JSON.stringify(compiled.summary)}\n${facts.join('\n')}` };
      }
      const score = this.store.saveScore(compiled, args); this.store.removeDraftsForAbc(compiled.abc); this.changed();
      return { text: `曲谱已保存，可在乐谱面板查看：${JSON.stringify({ ...score, abc: undefined })}\n${facts.join('\n')}` };
    } catch (error) {
      if (Array.isArray(error?.problems)) {
        const draft = this.draftFor(args, error); this.changed();
        const kept = draft ? `\n草稿已保留：${draft.id}（action=draft, id=${draft.id}；或 action=get, id=${draft.id}）` : '';
        return { failed: true, text: `[未保存] 谱子有 ${error.problems.length} 个问题：\n- ${error.problems.join('\n- ')}${kept}` };
      }
      throw error;
    }
  }
  async playTool(args) {
    const delivery = args.delivery || this.value('delivery');
    if (!['return', 'event'].includes(delivery)) throw new Error('delivery 只能是 return / event。');
    let result;
    try {
      result = await this.render(args);
    } catch (error) {
      if (Array.isArray(error?.problems)) {
        const draft = this.draftFor(args, error); this.changed();
        const kept = draft ? `\n草稿已保留：${draft.id}（action=draft, id=${draft.id}；或 action=get, id=${draft.id}）` : '';
        return { failed: true, text: `[未渲染] 谱子有 ${error.problems.length} 个问题：\n- ${error.problems.join('\n- ')}${kept}` };
      }
      throw error;
    }
    const { item, bytes, facts, rendered } = result;
    const backingNote = item.backing === 'band' && item.backingNotes > 0
      ? `，伴奏 band（${item.groove || 'pop'}，能量 ${item.energy ?? 3}）${item.backingNotes} 音`
      : item.backing === 'abcjs' && item.backingNotes > 0 ? `，伴奏 abcjs ${item.backingNotes} 音` : '';
    const receipt = [
      `已生成：${item.title}（${item.notes} 音，${item.voices} 声部${backingNote}，乐曲 ${facts.seconds.toFixed(1)} 秒；音频 ${item.seconds.toFixed(1)} 秒含 3 秒收尾）`,
      `作品：${item.id}`,
      `文件：${item.path}`,
      `曲谱版本：${item.revision}`,
      ...(item.sections?.length > 0
        ? [`分段伴奏：${item.sections.slice(0, 8).map(section => `${section.fromBar}-${section.toBar} ${section.groove || item.groove || 'pop'} E${section.energy ?? item.energy ?? 3}${section.stopBars?.length ? ` stop ${section.stopBars.join(',')}` : ''}`).join('；')}${item.sections.length > 8 ? '；…' : ''}`]
        : []),
      ...describeFacts(facts, rendered),
    ].join('\n');
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
    const mime = 'audio/wav';
    return { $file: { path, mime, bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } };
  }
  async invoke(panel, method, args = []) {
    const input = args[0] ?? {};
    if (panel === 'arrange') panel = 'scores';
    if (panel === 'tools') {
      if (method === 'list') return this.toolText.read();
      if (method === 'save') return this.toolText.save(input);
      if (method === 'reset') return this.toolText.reset(input);
    }
    if (panel === 'scores') {
      if (method === 'list') { await this.library.refresh(); return { items: this.store.listScores(), drafts: this.store.listDrafts(), state: this.status(), fonts: this.library.fonts, instruments: this.library.items(), aliases: this.aliases() }; }
      if (method === 'get') { const score = this.store.score(input); if (score) return score; const draft = this.store.draft(input); if (draft) return { ...draft, draft: true }; throw new Error('找不到曲谱或草稿。'); }
      if (method === 'midi') {
        const stored = input.score ? this.store.score(input.score) : (input.id ? this.store.score(input.id) : null);
        if (input.score && !stored) throw new Error('找不到曲谱。');
        const compiled = await this.compile({ ...input, abc: input.abc ?? stored?.abc }, stored);
        return this.binary(compiled.midi, 'audio/midi');
      }
      if (method === 'check') { const stored = input.id ? this.store.score(input.id) : null; const compiled = await this.compile(input, stored); this.store.removeDraftsForAbc(compiled.abc); return { ...compiled.summary, facts: describeFacts(compiled.facts) }; }
      if (method === 'save') { const stored = input.id ? this.store.score(input.id) : null; const compiled = await this.compile(input, stored); const score = this.store.saveScore(compiled, input); this.store.removeDraftsForAbc(compiled.abc); this.changed(); return { ...score, facts: describeFacts(compiled.facts) }; }
      if (method === 'remove') { const result = this.store.remove('scores', input); this.changed(); return result; }
      if (method === 'preview') return this.binary((await this.render(input, { preview: true })).wav, 'audio/wav');
      if (method === 'render') { const result = await this.render(input); return { ...result.item, facts: describeFacts(result.facts, result.rendered) }; }
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
      badges: [{ label: en ? 'Scores' : '乐谱', value: state.scores, tone: 'on' }, { label: en ? 'Works' : '作品', value: state.works, tone: 'on' }, { label: en ? 'Drafts' : '草稿', value: state.drafts, tone: 'plain' }, { label: en ? 'Instrument' : '乐器', value: state.instrumentLabel || (en ? 'None' : '未选择'), tone: 'plain' }],
      panels: [{ id: 'scores', title: en ? 'Scores' : '乐谱', getMethods: ['list', 'get'] }, { id: 'works', title: en ? 'Works' : '作品', getMethods: ['list', 'get'] }, { id: 'instruments', title: en ? 'Instruments' : '乐器', getMethods: ['list'] }, { id: 'tools', title: en ? 'Tools' : '工具', getMethods: ['list'] }],
      config: [configGroup(language)],
      promptDocs: [{ key: `worlds.${ID}.env`, title: en ? 'Prompt' : '提示词', path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)), role: 'envPrompt' }],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      stream: (panel, socket) => this.stream(panel, socket),
    };
  }
  stream(panel, socket) {
    if (panel === 'arrange') panel = 'scores';
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
