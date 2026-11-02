import abcjs from 'abcjs';
import { blocksCompile } from '../../music-abc/warnings.js';
import { STYLE } from './style.js';
import { followScore } from './score-follow.js';
import { scoreTitle } from './score-title.js';
import { mountTools } from './tool-text-panel.js';

const words = {
  works: ['作品', 'Works'],
  scoreSelect: ['选择乐谱', 'Select score'], unsaved: ['未保存的乐谱', 'Unsaved score'], instrument: ['演奏乐器', 'Instrument'],
  new: ['新建', 'New'], save: ['保存乐谱', 'Save score'], preview: ['试听', 'Listen'], render: ['生成作品', 'Render audio'],
  source: ['ABC谱', 'ABC score'],
  check: ['检查乐谱', 'Validate'], refresh: ['刷新', 'Refresh'], remove: ['删除', 'Delete'], current: ['当前默认', 'Default'], select: ['设为默认', 'Set default'],
  generating: ['正在生成采样音频…', 'Rendering sampled audio…'], saved: ['乐谱已保存。', 'Score saved.'], rendered: ['作品已生成，可在作品面板查看。', 'Audio saved to Works.'],
  sourceHelp: ['V: 分声部 · [CEG] 写和弦 · !p! / !f! 写力度 · 引号和弦仅作标注', 'V: voices · [CEG] chords · !p! / !f! dynamics · quoted chord names are labels'],
  unengraved: ['部分时值短于六十四分音符，谱面无法精确记写；演奏与保存不受影响。', 'Some durations are shorter than a 64th note and cannot be notated exactly; playback and saving are unaffected.'],
  dirty: ['有未保存的修改', 'Unsaved changes'], ready: ['乐谱预览', 'Score preview'], snapshot: ['演奏时的乐谱快照', 'Score at the time of rendering'],
  viewScore: ['查看乐谱', 'View score'], copy: ['复制路径', 'Copy path'], openFolder: ['打开文件夹', 'Open folder'], empty: ['还没有作品。在乐谱面板生成第一段演奏。', 'No works yet. Render your first performance in Scores.'],
  deleteTitle: ['删除这条记录？', 'Delete this record?'], deleteBody: ['删除后无法撤销。已生成作品中的乐谱快照会独立保留。', 'This cannot be undone. Other works retain their own score snapshots.'],
  switchTitle: ['切换乐谱？', 'Switch score?'], switchBody: ['当前修改尚未保存。继续会替换编辑器中的内容。', 'Your changes are not saved. Continuing replaces the editor contents.'],
  removeScore: ['删除乐谱', 'Delete score'],
  selected: ['默认乐器已更新。', 'Default instrument updated.'], copied: ['路径已复制。', 'Path copied.'],
  openFolderBad: ['无法打开文件夹。', 'Could not open the folder.'],
  getFont: ['获取GeneralUser GS', 'Get GeneralUser GS'], importFont: ['导入音源', 'Import SoundFont'],
  noFont: ['还没有音源', 'No SoundFonts yet'], noFontHelp: ['获取 GeneralUser GS，或导入本机 SF2 / SF3 文件。', 'Get GeneralUser GS or import a local SF2 / SF3 file.'],
  fontRights: ['GeneralUser GS 允许商业音乐创作。作者无法完全确认所有采样的原始来源，本扩展未逐一独立核验。', 'GeneralUser GS permits commercial music creation. Its author cannot establish every sample’s original provenance; this extension has not independently audited every sample.'],
  fontSource: ['来源与许可', 'Source and license'], fontSearch: ['搜索乐器或音源文件', 'Search instruments or SoundFonts'],
  fontMissing: ['音源未安装，请在乐器页获取或导入。', 'Install a SoundFont in Instruments.'],
  noMatches: ['没有匹配的乐器', 'No matching instruments'], presets: ['个预设', 'presets'],
  downloadFont: ['正在获取 GeneralUser GS', 'Downloading GeneralUser GS'], importDone: ['音源已导入。', 'SoundFont imported.'],
  missingPreset: ['预设未安装', 'Preset unavailable'],
  chooseInstrument: ['选择乐器', 'Choose instrument'],
};
const tr = ctx => key => words[key]?.[ctx.language === 'en' ? 1 : 0] ?? key;
const msg = error => error?.message || String(error);
const duration = value => `${Number(value).toFixed(1)} s`;
function el(tag, className = '', text = '') { const node = document.createElement(tag); node.className = className; if (text) node.textContent = text; return node; }
function listen(ctx, node, type, handler) { node.addEventListener(type, handler, { signal: ctx.signal }); }
function button(ctx, label, action, className = '') {
  const node = el('button', className, label); node.type = 'button';
  listen(ctx, node, 'click', () => { Promise.resolve().then(action).catch(error => ctx.ui.toast(msg(error), 'bad')); });
  return node;
}
function field(label, control, wide = false) { const node = el('label', `am-field${wide ? ' wide' : ''}`); node.append(el('span', '', label), control); return node; }
function option(value, label) { const node = el('option', '', label); node.value = value; return node; }
function frame(ctx) {
  const root = el('section', 'abc-music');
  const style = el('style'); style.textContent = STYLE; root.append(style);
  ctx.root.append(root);
  return root;
}
function player(ctx, root) {
  const box = el('div', 'am-player'); box.hidden = true;
  const label = el('div', 'muted'), audio = el('audio'); audio.controls = true; audio.preload = 'metadata'; box.append(label, audio); root.append(box);
  let url = '', request = 0;
  const stop = () => { request++; audio.pause(); audio.removeAttribute('src'); if (url) URL.revokeObjectURL(url); url = ''; box.hidden = true; };
  ctx.own({ dispose: stop });
  return { audio, stop,
    async play(load, title) {
      stop(); const ticket = ++request;
      const blob = await load(); if (ctx.signal.aborted || ticket !== request) return;
      url = URL.createObjectURL(blob); audio.src = url; label.textContent = title; box.hidden = false;
      await audio.play();
    },
  };
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = el('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function subscribe(ctx, action) {
  ctx.own(ctx.stream({ message(raw) { try { const data = JSON.parse(raw); if (data.t === 'changed') void action().catch(() => {}); } catch {} } }));
}
const blankScore = instrument => ({ abc: 'X:1\nT:新乐谱\nM:4/4\nL:1/8\nQ:1/4=100\nK:C\nz8 |]', instrument });

function scoresPanel(ctx) {
  const t = tr(ctx), root = frame(ctx);
  const toolbar = el('div', 'am-toolbar'), scoreSelect = el('select'), instrument = el('select');
  scoreSelect.setAttribute('aria-label', t('scoreSelect')); instrument.setAttribute('aria-label', t('instrument'));
  toolbar.append(field(t('scoreSelect'), scoreSelect, true), field(t('instrument'), instrument));
  const newButton = button(ctx, t('new'), newScore), saveButton = button(ctx, t('save'), save), previewButton = button(ctx, t('preview'), preview), renderButton = button(ctx, t('render'), render);
  const source = el('section', 'am-source'), sourceLabel = el('div', 'am-row am-sourcelabel'), editor = el('textarea'), sourceActions = el('div', 'am-row am-sourceactions'), dirtyLabel = el('span', 'muted');
  source.setAttribute('aria-label', t('source'));
  editor.spellcheck = false; editor.setAttribute('aria-label', t('source'));
  const deleteButton = button(ctx, t('removeScore'), async () => {
    if (!state.id || !await ctx.ui.confirm({ title: t('deleteTitle'), body: t('deleteBody'), danger: true })) return;
    await ctx.invoke('remove', [state.id]);
    state.id = ''; state.revision = ''; state.savedAbc = ''; state.savedInstrument = '';
    await reload(); stash();
  }, 'danger');
  sourceLabel.append(el('span', 'grow', t('source')), dirtyLabel);
  const status = el('div', 'am-status'); status.setAttribute('role', 'status');
  sourceActions.append(newButton, saveButton, previewButton, renderButton, button(ctx, t('check'), check), deleteButton);
  source.append(sourceLabel, toolbar, editor, el('p', 'am-help', t('sourceHelp')), sourceActions, status);
  const playback = player(ctx, source);
  root.append(source);
  const documentBox = el('div', 'am-document'), paper = el('div', 'am-paper'), paperbar = el('div', 'am-paperbar'), paperMeta = el('span');
  paper.setAttribute('aria-label', ctx.language === 'en' ? 'Sheet music' : '五线谱');
  paperbar.append(paperMeta); documentBox.append(paper, paperbar); root.append(documentBox);
  let state = { id: '', revision: '', abc: '', instrument: '', savedAbc: '', savedInstrument: '' };
  let items = [], busy = false, timer = 0, follower = null, animation = 0, hasLoaded = false, localSequence = 0;
  let available = new Set(), fonts = [], aliases = {}, defaultInstrument = '';
  const controls = () => {
    previewButton.disabled = busy || !available.has(instrument.value); renderButton.disabled = previewButton.disabled;
    previewButton.title = renderButton.title = available.has(instrument.value) ? '' : t('fontMissing');
  };
  function fillInstruments(value) {
    value = aliases[value] || value || defaultInstrument;
    const placeholder = option('', t(available.size ? 'chooseInstrument' : 'noFont')); placeholder.disabled = Boolean(available.size);
    instrument.replaceChildren(placeholder);
    for (const font of fonts) {
      if (!font.presets.length) continue;
      const group = el('optgroup'); group.label = font.file;
      group.append(...font.presets.map(one => option(one.id, `${one.name} · ${one.bankMSB}:${one.bankLSB}:${one.program}${one.isDrum ? ' · drums' : ''}`)));
      instrument.append(group);
    }
    if (value && !available.has(value)) instrument.append(option(value, `${t('missingPreset')} · ${value}`));
    instrument.value = value || ''; controls();
  }
  const dirty = () => editor.value.trim() !== state.savedAbc || instrument.value !== state.savedInstrument;
  const say = (text, bad = false) => { status.textContent = text; status.classList.toggle('bad', bad); };
  const stash = () => {
    ctx.memo.set('draft', { ...state, abc: editor.value, instrument: instrument.value });
    dirtyLabel.textContent = dirty() ? t('dirty') : (state.id ? t('saved') : t('ready'));
    deleteButton.disabled = !state.id || busy;
  };
  const refreshHeader = () => { void ctx.refresh().catch(() => {}); };
  function draw() {
    clearTimeout(timer); timer = 0; playback.stop(); follower?.update(false); follower = null;
    try {
      const width = Math.max(280, paper.clientWidth - 48);
      const rendered = abcjs.renderAbc(paper, editor.value, { responsive: 'resize', add_classes: true, paddingtop: 15, paddingbottom: 15, staffwidth: width, wrap: { minSpacing: 1.7, maxSpacing: 2.7, preferredMeasuresPerLine: width > 650 ? 4 : 2 } });
      const tune = rendered[0] || null;
      const warnings = tune?.warnings ?? [], blocking = warnings.filter(blocksCompile);
      if (blocking.length) say(blocking.map(one => String(one).replace(/<[^>]*>/g, '')).join('\n'), true);
      else say(warnings.length ? t('unengraved') : '');
      if (tune) {
        follower = followScore(paper, tune, playback.audio, { highlightNotes: true });
        const meter = tune.getMeterFraction();
        paperMeta.textContent = `${meter.num}/${meter.den} · ♩ ${tune.getBpm(tune.metaText.tempo)}`;
      } else paperMeta.textContent = '';
    } catch (error) { say(msg(error), true); }
    stash();
  }
  const syncPlayback = () => follower?.update(Boolean(playback.audio.getAttribute('src')));
  const tick = () => { syncPlayback(); animation = playback.audio.paused ? 0 : requestAnimationFrame(tick); };
  listen(ctx, playback.audio, 'play', () => { cancelAnimationFrame(animation); tick(); });
  for (const event of ['timeupdate', 'seeked', 'pause', 'ended', 'emptied']) listen(ctx, playback.audio, event, syncPlayback);
  ctx.own({ dispose() { clearTimeout(timer); cancelAnimationFrame(animation); } });
  function setEditor(next) {
    localSequence++;
    next = { ...next, instrument: aliases[next.instrument] || next.instrument || defaultInstrument };
    if (next.savedInstrument) next.savedInstrument = aliases[next.savedInstrument] || next.savedInstrument;
    state = { id: next.id || '', revision: next.revision || '', savedAbc: next.id ? next.abc : '', savedInstrument: next.id ? next.instrument : '', ...next };
    editor.value = state.abc; fillInstruments(state.instrument); scoreSelect.value = state.id; draw();
  }
  async function canReplace() { return !dirty() || await ctx.ui.confirm({ title: t('switchTitle'), body: t('switchBody') }); }
  async function newScore() {
    if (!await canReplace()) return;
    setEditor(blankScore(instrument.value)); editor.focus();
  }
  const input = () => ({ abc: editor.value, instrument: instrument.value });
  async function run(action, message = '') {
    if (busy) return;
    if (timer) draw();
    busy = true;
    for (const node of [saveButton, previewButton, renderButton, scoreSelect, instrument, newButton, deleteButton]) node.disabled = true;
    if (message) say(message);
    try { return await action(); }
    catch (error) { say(msg(error), true); throw error; }
    finally { busy = false; for (const node of [saveButton, scoreSelect, instrument, newButton]) node.disabled = false; controls(); deleteButton.disabled = !state.id; refreshHeader(); }
  }
  async function save() {
    return run(async () => {
      const before = input(), sequence = localSequence;
      const saved = await ctx.invoke('save', [{ ...before, id: state.id, expectedRevision: state.revision }]);
      if (ctx.signal.aborted || sequence !== localSequence) return;
      state.id = saved.id; state.revision = saved.revision; state.savedAbc = saved.abc; state.savedInstrument = saved.instrument;
      if (editor.value === before.abc) editor.value = saved.abc;
      await reload(); scoreSelect.value = saved.id; stash(); say(t('saved'));
    });
  }
  async function check() { return run(async () => { const result = await ctx.invoke('check', [input()]); say(`${result.notes} 音 · ${result.voices} 声部 · ${duration(result.seconds)} · ABC ✓`); }); }
  async function preview() { return run(async () => { await playback.play(() => ctx.invokeBinary('preview', [input()]), scoreTitle(editor.value)); say(''); }, t('generating')); }
  async function render() {
    return run(async () => {
      if (dirty() || !state.id) {
        const before = input();
        const saved = await ctx.invoke('save', [{ ...before, id: state.id, expectedRevision: state.revision }]);
        state.id = saved.id; state.revision = saved.revision; state.savedAbc = saved.abc; state.savedInstrument = saved.instrument;
        if (editor.value === before.abc) editor.value = saved.abc;
        stash();
      }
      const item = await ctx.invoke('render', [{ score: state.id }]);
      say(`${t('rendered')} ${duration(item.seconds)}`); await reload();
    }, t('generating'));
  }
  async function reload() {
    const data = await ctx.invoke('list'); if (ctx.signal.aborted) return;
    items = data.items;
    fonts = data.fonts; available = new Set(data.instruments.map(one => one.id)); aliases = data.aliases; defaultInstrument = data.state.instrument;
    const selectedInstrument = instrument.value;
    scoreSelect.replaceChildren(option('', t('unsaved')), ...items.map(one => option(one.id, one.title)));
    scoreSelect.value = state.id;
    if (!hasLoaded) {
      const draft = ctx.memo.get('draft', null);
      if (draft) {
        const draftDirty = draft.abc.trim() !== draft.savedAbc || draft.instrument !== draft.savedInstrument;
        if (draft.id && items.some(one => one.id === draft.id)) setEditor(draftDirty ? draft : await ctx.invoke('get', [draft.id]));
        else setEditor({ ...draft, id: '', revision: '', savedAbc: '', savedInstrument: '' });
      }
      else if (items.length) setEditor(await ctx.invoke('get', [items[0].id]));
      else setEditor(blankScore(data.state.instrument));
      hasLoaded = true;
    } else fillInstruments(selectedInstrument);
    refreshHeader();
  }
  function scheduleDraw(event) {
    stash(); clearTimeout(timer);
    if (!event.isComposing) timer = setTimeout(draw, 500);
  }
  listen(ctx, editor, 'input', scheduleDraw);
  listen(ctx, editor, 'compositionend', scheduleDraw);
  listen(ctx, instrument, 'change', () => { playback.stop(); follower?.update(false); controls(); stash(); });
  listen(ctx, scoreSelect, 'change', async () => {
    const id = scoreSelect.value;
    try { if (!id || !await canReplace()) { scoreSelect.value = state.id; return; } setEditor(await ctx.invoke('get', [id])); }
    catch (error) { say(msg(error), true); }
  });
  subscribe(ctx, reload); void reload().catch(error => say(msg(error), true));
}

function worksPanel(ctx) {
  const t = tr(ctx), root = frame(ctx);
  const toolbar = el('div', 'am-row'), count = el('span', 'muted grow');
  toolbar.style.marginBottom = '16px'; toolbar.append(count, button(ctx, t('openFolder'), async () => {
    const result = await ctx.invoke('openFolder', []);
    if (!result?.ok) throw new Error(result?.detail || t('openFolderBad'));
  }), button(ctx, t('refresh'), reload)); root.append(toolbar);
  const playback = player(ctx, root), list = el('div', 'am-list'); root.append(list);
  const open = new Set(), followers = new Map(); let sequence = 0, activeId = '', animation = 0;
  const sync = () => { for (const [id, follower] of followers) follower.update(id === activeId); };
  const tick = () => { sync(); animation = playback.audio.paused ? 0 : requestAnimationFrame(tick); };
  listen(ctx, playback.audio, 'play', () => { cancelAnimationFrame(animation); tick(); });
  for (const event of ['timeupdate', 'seeked', 'pause', 'ended', 'emptied']) listen(ctx, playback.audio, event, sync);
  ctx.own({ dispose() { cancelAnimationFrame(animation); } });
  async function reload() {
    const ticket = ++sequence, data = await ctx.invoke('list'); if (ctx.signal.aborted || ticket !== sequence) return;
    count.textContent = `${data.items.length} ${t('works')} · ${(data.items.reduce((sum, one) => sum + one.bytes, 0) / 1048576).toFixed(1)} MB`;
    followers.clear(); list.replaceChildren(); if (!data.items.length) list.append(el('div', 'am-empty', t('empty')));
    for (const item of data.items) {
      const card = el('article', 'am-card'), row = el('div', 'am-row'), detail = el('details');
      card.append(el('h3', '', item.title), el('p', 'muted', `${duration(item.seconds)} · ${item.voices} ${ctx.language === 'en' ? 'voices' : '声部'} · ${item.instrumentLabel || item.instrument} · ${item.soundfont || ''} · ${new Date(item.createdAt).toLocaleString()}`));
      const fetchFile = format => ctx.invokeBinary('file', [{ id: item.id, format }]);
      row.append(button(ctx, t('preview'), () => {
        activeId = ''; sync();
        return playback.play(() => { activeId = item.id; return fetchFile('wav'); }, item.title);
      }), button(ctx, 'WAV ↓', async () => downloadBlob(await fetchFile('wav'), `${item.id}.wav`)), button(ctx, 'MIDI ↓', async () => downloadBlob(await fetchFile('mid'), `${item.id}.mid`)), button(ctx, 'ABC ↓', async () => downloadBlob(await fetchFile('abc'), `${item.id}.abc`)), button(ctx, t('copy'), async () => { await navigator.clipboard.writeText(item.path); ctx.ui.toast(t('copied'), 'ok'); }), button(ctx, t('remove'), async () => {
        if (!await ctx.ui.confirm({ title: t('deleteTitle'), body: item.title, danger: true })) return;
        activeId = ''; sync(); playback.stop(); await ctx.invoke('remove', [item.id]); await reload(); void ctx.refresh();
      }, 'danger'));
      if (ctx.scope?.audioMusic) row.append(button(ctx, ctx.language === 'en' ? 'Add to mix' : '加入混音', () => {
        ctx.root.dispatchEvent(new CustomEvent('audio:add-to-mix', { bubbles: true, detail: [item.path] }));
      }));
      card.append(row);
      detail.append(el('summary', '', `${t('viewScore')} · ${t('snapshot')}`));
      let drawn = false, drawing = false;
      async function show() {
        if (!detail.open || drawn || drawing) return;
        drawing = true;
        try {
          const snapshot = await ctx.invoke('get', [item.id]); if (ctx.signal.aborted || ticket !== sequence) return;
          const sheet = el('div', 'am-paper'); detail.append(el('p', 'muted', t('snapshot')), sheet);
          const [tune] = abcjs.renderAbc(sheet, snapshot.abc, { responsive: 'resize', staffwidth: Math.max(280, sheet.clientWidth - 48), wrap: { minSpacing: 1.7, maxSpacing: 2.7, preferredMeasuresPerLine: 2 } });
          if (tune) followers.set(item.id, followScore(sheet, tune, playback.audio));
          sync(); drawn = true;
        } finally { drawing = false; }
      }
      listen(ctx, detail, 'toggle', () => { if (detail.open) open.add(item.id); else open.delete(item.id); void show().catch(error => ctx.ui.toast(msg(error), 'bad')); });
      card.append(detail); list.append(card); if (open.has(item.id)) { detail.open = true; void show(); }
    }
  }
  subscribe(ctx, reload); void reload().catch(error => ctx.ui.toast(msg(error), 'bad'));
}

function instrumentsPanel(ctx) {
  const t = tr(ctx), root = frame(ctx);
  const toolbar = el('div', 'am-row am-librarytools'), search = el('input'), info = el('p', 'muted am-librarypath');
  search.type = 'search'; search.placeholder = t('fontSearch'); search.setAttribute('aria-label', t('fontSearch')); search.className = 'grow';
  const importButton = button(ctx, t('importFont'), async () => {
    const path = await ctx.pickPath({ kind: 'file', title: t('importFont'), recommendedDir: data.state.dataDir, extensions: ['.sf2', '.sf3'] });
    if (!path) return;
    importButton.disabled = true;
    try { await ctx.invoke('import', [path]); await reload(); ctx.ui.toast(t('importDone'), 'ok'); } finally { importButton.disabled = false; }
  });
  toolbar.append(search, importButton, button(ctx, t('openFolder'), async () => {
    const result = await ctx.invoke('openFolder'); if (!result?.ok) throw new Error(result?.detail || t('openFolderBad'));
  }), button(ctx, t('refresh'), reload)); root.append(toolbar, info);
  const empty = el('div', 'am-empty'), getButton = button(ctx, t('getFont'), async () => {
    getButton.disabled = true;
    try { await ctx.invoke('download'); await reload(); } finally { getButton.disabled = false; }
  }, 'primary'), progress = el('p', 'am-status'), rights = el('p', 'am-help'), source = el('a', '', t('fontSource'));
  source.href = 'https://github.com/mrbumpy409/GeneralUser-GS'; source.target = '_blank'; source.rel = 'noreferrer';
  rights.append(document.createTextNode(`${t('fontRights')} `), source);
  empty.append(el('h3', '', t('noFont')), el('p', '', t('noFontHelp')), getButton, progress, rights); root.append(empty);
  const playback = player(ctx, root), list = el('div', 'am-list'); root.append(list);
  let sequence = 0, auditioning = false, data = { fonts: [], items: [], state: {} }, signature = '';
  const expanded = new Set(ctx.memo.get('expandedFonts', []));
  function draw() {
    const query = search.value.trim().toLocaleLowerCase(); list.replaceChildren(); let matches = 0;
    for (const font of data.fonts) {
      const presets = font.presets.filter(item => `${font.file} ${item.name} ${item.bankMSB}:${item.bankLSB}:${item.program}`.toLocaleLowerCase().includes(query));
      if (!presets.length && !font.error) continue;
      const group = el('details', 'am-soundfont'), header = el('summary', 'am-fonthead'), rows = el('div', 'am-presets');
      group.open = Boolean(query) || expanded.has(font.file);
      let previousOpen = group.open;
      listen(ctx, group, 'toggle', () => {
        if (group.open === previousOpen) return;
        previousOpen = group.open;
        if (group.open) expanded.add(font.file); else expanded.delete(font.file);
        ctx.memo.set('expandedFonts', [...expanded]);
      });
      header.append(el('h3', '', font.file), el('span', 'muted', `${presets.length} / ${font.presets.length} ${t('presets')}${font.bytes ? ` · ${(font.bytes / 1048576).toFixed(1)} MB` : ''}`)); group.append(header);
      if (font.error) group.append(el('p', 'am-status bad', font.error));
      for (const item of presets) {
        matches++;
        const current = item.id === data.state.instrument, row = el('div', `am-preset${current ? ' active' : ''}`), name = el('div', 'grow am-presetname'), actions = el('div', 'am-row');
        name.append(el('div', '', item.name), el('div', 'muted', `${item.bankMSB}:${item.bankLSB}:${item.program}${item.isDrum ? ' · drums' : ''}`));
        const choose = button(ctx, current ? t('current') : t('select'), async () => { await ctx.invoke('select', [item.id]); await reload(); }); choose.disabled = current;
        const preview = button(ctx, t('preview'), async () => {
          if (auditioning) return; auditioning = true;
          preview.disabled = true; preview.textContent = t('generating');
          try { await playback.play(() => ctx.invokeBinary('preview', [item.id]), `${font.file} · ${item.name}`); }
          finally { auditioning = false; preview.disabled = false; preview.textContent = t('preview'); }
        });
        actions.append(preview, choose); row.append(name, actions); rows.append(row);
      }
      group.append(rows); list.append(group);
    }
    if (query && !matches) list.append(el('div', 'am-empty', t('noMatches')));
  }
  async function reload() {
    const ticket = ++sequence, next = await ctx.invoke('list'); if (ctx.signal.aborted || ticket !== sequence) return;
    data = next; info.textContent = [data.state.dataDir, data.state.migrationError].filter(Boolean).join('\n');
    empty.hidden = Boolean(data.items.length);
    const download = data.state.download;
    getButton.disabled = Boolean(download && !download.error);
    progress.textContent = download?.error || (download ? `${t('downloadFont')} · ${download.percent}%` : ''); progress.classList.toggle('bad', Boolean(download?.error));
    const nextSignature = JSON.stringify([data.fonts, data.state.instrument]);
    if (nextSignature !== signature) { signature = nextSignature; draw(); }
    void ctx.refresh().catch(() => {});
  }
  listen(ctx, search, 'input', draw);
  subscribe(ctx, reload); void reload().catch(error => ctx.ui.toast(msg(error), 'bad'));
}

export default { panels: { scores: { mount: scoresPanel }, works: { mount: worksPanel }, instruments: { mount: instrumentsPanel }, tools: { mount: mountTools } } };
