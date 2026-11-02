import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BasicMIDI } from 'spessasynth_core';
import def from '../../src/music-abc/index.js';
import { compileAbc } from '../../src/music-abc/abc.js';
import { SoundfontLibrary, GENERAL_USER } from '../../src/music-abc/soundfonts.js';
import { testBank } from './fixture.mjs';

const abc = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nC4 |]';
function scratch(t) { const dir = mkdtempSync(join(tmpdir(), 'abc-fonts-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const digest = data => createHash('sha256').update(data).digest('hex');
function downloadLibrary(t, fetcher) {
  const dir = scratch(t), bytes = testBank(join(dir, 'source.sf2'));
  const downloadSpec = { ...GENERAL_USER, file: 'Downloaded.sf2', bytes: bytes.length, sha256: digest(bytes) };
  return { library: new SoundfontLibrary(join(dir, 'library'), () => {}, { downloadSpec, fetcher: (...args) => fetcher(bytes, ...args) }), bytes };
}

test('empty library can save scores and rejects audio with an actionable message', async t => {
  const world = def.create({ dataDir: scratch(t) }); await world.start();
  assert.deepEqual((await world.invoke('instruments', 'list')).fonts, []);
  const score = await world.invoke('scores', 'save', [{ abc }]); assert.equal(score.instrument, '');
  await assert.rejects(world.invoke('scores', 'preview', [{ score: score.id }]), /乐器页/);
  assert.equal(world.busy, false); assert.equal(world.store.listWorks().length, 0); await world.stop();
});
test('multiple files expose all presets and distinct IDs even when names match', async t => {
  const dir = scratch(t); testBank(join(dir, 'First.sf2')); testBank(join(dir, '第二个.sf3'));
  writeFileSync(join(dir, 'Broken.sf2'), 'invalid'); writeFileSync(join(dir, 'ignored.txt'), 'text');
  const library = new SoundfontLibrary(dir); await library.refresh();
  assert.equal(library.fonts.length, 3); assert.equal(library.items().length, 10);
  assert.equal(new Set(library.items().map(one => one.id)).size, 10);
  assert.ok(library.items().some(one => one.bankMSB === 8)); assert.ok(library.items().some(one => one.isGMGSDrum));
  assert.ok(library.fonts.find(font => font.file === 'Broken.sf2').error);
  const id = library.items().find(one => one.file === '第二个.sf3').id;
  const restarted = new SoundfontLibrary(dir); await restarted.refresh(); assert.equal(restarted.resolve(id).id, id);
  rmSync(join(dir, 'First.sf2')); await restarted.refresh(); assert.equal(restarted.items().length, 5);
});
test('import copies to the data directory and rejects different content with the same filename', async t => {
  const source = join(scratch(t), 'Bank.sf2'), library = new SoundfontLibrary(join(scratch(t), 'library'));
  const original = testBank(source); await library.importFile(source); await library.importFile(source);
  assert.deepEqual(readFileSync(join(library.dir, 'Bank.sf2')), original); assert.ok(existsSync(source));
  testBank(source, { harmonic: 4 }); await assert.rejects(library.importFile(source), /同名/);
  assert.deepEqual(readFileSync(join(library.dir, 'Bank.sf2')), original);
  writeFileSync(source, 'bad'); await assert.rejects(library.importFile(source));
  await assert.rejects(library.importFile('../outside.sf2'), /绝对路径/);
});
test('download validates bytes and hash, saves the license, and coalesces concurrent requests', async t => {
  let requests = 0;
  const { library, bytes } = downloadLibrary(t, async data => { requests++; return new Response(data); });
  const [one, two] = await Promise.all([library.getGeneralUser(), library.getGeneralUser()]);
  assert.equal(one.file, two.file); assert.equal(requests, 1);
  assert.deepEqual(readFileSync(join(library.dir, one.file)), bytes);
  assert.ok(existsSync(join(library.dir, GENERAL_USER.license))); assert.equal(library.download, null);
  await library.getGeneralUser(); assert.equal(requests, 1);
  assert.ok(!readdirSync(library.dir).some(file => file.endsWith('.download')));
});
test('failed and corrupted downloads leave no installed or partial file and can be retried', async t => {
  let attempt = 0;
  const { library } = downloadLibrary(t, async data => {
    attempt++; if (attempt === 1) return new Response('unavailable', { status: 503 });
    if (attempt === 2) { const bad = Buffer.from(data); bad[bad.length - 1] ^= 1; return new Response(bad); }
    return new Response(data);
  });
  await assert.rejects(library.getGeneralUser(), /503/); await assert.rejects(library.getGeneralUser(), /校验/);
  assert.deepEqual(readdirSync(library.dir), []); assert.ok(library.download.error);
  assert.equal((await library.getGeneralUser()).presets.length, 5);
});
test('network failure uses the official alternate endpoint and interrupted bodies are removed', async t => {
  const urls = [];
  const { library } = downloadLibrary(t, async (data, url) => { urls.push(url); if (urls.length === 1) throw new Error('connection reset'); return new Response(data); });
  assert.equal((await library.getGeneralUser()).presets.length, 5);
  assert.equal(new URL(urls[0]).host, 'raw.githubusercontent.com'); assert.equal(new URL(urls[1]).host, 'api.github.com');
  const broken = downloadLibrary(t, async data => new Response(new ReadableStream({ start(controller) { controller.enqueue(data.subarray(0, 100)); controller.error(new Error('interrupted')); } })));
  await assert.rejects(broken.library.getGeneralUser(), /interrupted/); assert.deepEqual(readdirSync(broken.library.dir), []);
});
test('legacy custom paths are copied and legacy instrument IDs resolve without rewriting score revisions', async t => {
  const source = join(scratch(t), 'Old Bank.sf2'); testBank(source);
  const cfg = { ...def.defaults(), soundfont: source, instrument: 'nylon-guitar' }, dataDir = scratch(t), patches = [];
  const world = def.create({ cfg, dataDir, persist: patch => patches.push(patch) });
  const old = world.store.saveScore(compileAbc(abc)); await world.start();
  const list = await world.invoke('instruments', 'list'); assert.equal(list.state.instrument, list.items.find(one => one.program === 24).id);
  assert.equal(world.store.score(old.id).revision, old.revision);
  const played = await world.invoke('scores', 'render', [{ score: old.id }]); assert.equal(played.soundfont, 'Old Bank.sf2');
  const chosen = list.items.find(one => one.bankMSB === 8); await world.invoke('instruments', 'select', [chosen.id]);
  assert.equal(patches.at(-1).instrument, chosen.id); await world.stop();
  rmSync(source); const restarted = def.create({ cfg, dataDir }); await restarted.start();
  assert.equal(restarted.status().instrument, chosen.id); assert.equal(restarted.status().migrationError, ''); await restarted.stop();
});
test('selected file, bank variant and drums affect actual audio and exported MIDI preserves explicit voice programs', async t => {
  const world = def.create({ dataDir: scratch(t) });
  const one = join(scratch(t), 'One.sf2'), two = join(scratch(t), 'Two.sf2'); testBank(one); testBank(two, { harmonic: 4 });
  await world.invoke('instruments', 'import', [one]); await world.invoke('instruments', 'import', [two]);
  const { items } = await world.invoke('instruments', 'list');
  const selected = [items.find(i => i.file === 'One.sf2' && i.program === 0 && !i.bankMSB && !i.isGMGSDrum), items.find(i => i.file === 'Two.sf2'), items.find(i => i.bankMSB === 8), items.find(i => i.isGMGSDrum)];
  const hashes = [];
  for (const preset of selected) { const audio = await world.invoke('scores', 'preview', [{ abc, instrument: preset.id }]); hashes.push(digest(Buffer.from(audio.$binary.base64, 'base64'))); }
  assert.equal(new Set(hashes).size, 4);
  const poly = abc.replace('C4 |]', 'V:a\nV:b\n[V:a] C4 |]\n[V:b]\n%%MIDI program 40\ne4 |]');
  const compiled = compileAbc(poly, { instrument: selected[2] }), song = BasicMIDI.fromArrayBuffer(compiled.midi.buffer.slice(compiled.midi.byteOffset, compiled.midi.byteOffset + compiled.midi.byteLength));
  const programs = [], banks = [];
  song.iterate(event => { if ((event.statusByte & 0xf0) === 0xc0) programs.push([event.statusByte & 15, event.data[0]]); if ((event.statusByte & 0xf0) === 0xb0 && event.data[0] === 0) banks.push([event.statusByte & 15, event.data[1]]); });
  assert.ok(programs.some(([channel, program]) => channel === 1 && program === 40));
  assert.ok(banks.some(([channel, bank]) => channel === 0 && bank === 8));
  assert.ok(!banks.some(([channel, bank]) => channel === 1 && bank === 8)); await world.stop();
});
test('overlapping world renders fail while the first request is scanning', async t => {
  const world = def.create({ dataDir: scratch(t) }), source = join(scratch(t), 'Bank.sf2'); testBank(source);
  await world.invoke('instruments', 'import', [source]);
  const first = world.invoke('scores', 'preview', [{ abc }]);
  await assert.rejects(world.invoke('scores', 'preview', [{ abc }]), /正在生成/); await first; assert.equal(world.busy, false); await world.stop();
});
