import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BasicMIDI } from 'spessasynth_core';
import def from '../../src/music-abc/index.js';
import { compileAbc } from '../../src/music-abc/abc.js';
import { AudioRenderer } from '../../src/music-abc/audio.js';
import { MusicStore } from '../../src/music-abc/store.js';
import { testBank } from './fixture.mjs';

const phrase = body => `X:1\nT:Test\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n${body}`;
const midiOf = compiled => BasicMIDI.fromArrayBuffer(compiled.midi.buffer.slice(compiled.midi.byteOffset, compiled.midi.byteOffset + compiled.midi.byteLength));
function notesOf(compiled) {
  const song = midiOf(compiled), notes = [], open = new Map();
  song.iterate((event, track) => {
    const kind = event.statusByte & 0xf0, key = `${track}:${event.statusByte & 15}:${event.data[0]}`;
    if (kind === 0x90 && event.data[1] > 0) {
      const note = { midi: event.data[0], start: event.ticks / song.timeDivision, velocity: event.data[1], track };
      notes.push(note); open.set(key, note);
    } else if (kind === 0x80 || (kind === 0x90 && event.data[1] === 0)) {
      const note = open.get(key); if (note) { note.dur = event.ticks / song.timeDivision - note.start; open.delete(key); }
    }
  });
  return notes;
}
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'abc-music-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function worldFor(t) {
  const dataDir = scratch(t), cfg = { ...def.defaults(), enabled: true }, patches = [];
  mkdirSync(join(dataDir, 'music-abc')); testBank(join(dataDir, 'music-abc', 'Test Bank.sf2'));
  return { world: def.create({ dataDir, cfg, persist: patch => patches.push(patch) }), dataDir, patches };
}
function wavSamples(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') {
      const values = [];
      for (let i = offset + 8; i < offset + 8 + size; i += 2) values.push(bytes.readInt16LE(i) / 32768);
      return values;
    }
    offset += 8 + size + size % 2;
  }
  throw new Error('No WAV data');
}

test('new libraries expose no bundled scores', async t => {
  const { world } = worldFor(t), data = await world.invoke('scores', 'list');
  assert.deepEqual(data.items, []);
  assert.ok(!Object.hasOwn(data, 'examples'));
});
test('polyphony retains independent note-offs at the same onset', () => {
  const compiled = compileAbc(phrase('V:low\nV:high\n[V:low] C4 |]\n[V:high] e f g a |]'));
  const notes = notesOf(compiled), low = notes.find(one => one.midi === 60), high = notes.find(one => one.midi === 76);
  assert.equal(low.start, high.start); assert.equal(low.dur, 4); assert.equal(high.dur, 1);
});
test('p and f dynamics reach exported MIDI velocities', () => {
  const notes = notesOf(compileAbc(phrase('!p!C2 !f!C2 |]')));
  assert.ok(notes[1].velocity > notes[0].velocity * 1.3);
});
test('ties, tuplets, rests and repeats retain musical timing', () => {
  const notes = notesOf(compileAbc(phrase('C-C z2 | (3DEF G2 z |: C4 :|')));
  assert.equal(notes[0].dur, 2);
  const tuplets = notes.filter(one => [62, 64, 65].includes(one.midi));
  assert.equal(tuplets.length, 3);
  assert.ok(Math.abs(tuplets[0].dur - 2 / 3) < 0.01);
  assert.ok(notes.length >= 6);
});
test('sub-50 ms onsets survive without stretching the music', () => {
  const compiled = compileAbc('X:1\nM:4/4\nL:1/64\nQ:1/4=120\nK:C\nCDEF |]');
  const notes = notesOf(compiled);
  assert.equal(notes[1].start, 1 / 16);
  assert.equal(midiOf(compiled).duration, 0.125);
});
test('pickup starts the next bar after the pickup, without padding', () => {
  const notes = notesOf(compileAbc(phrase('C | D4 |]')));
  assert.equal(notes[1].start, 1);
});
test('invalid, empty, multiple and oversized scores fail before rendering', () => {
  assert.throws(() => compileAbc(''), /为空/);
  assert.throws(() => compileAbc('CDEF'), /缺少/);
  assert.throws(() => compileAbc(phrase('z4 |]')), /没有/);
  assert.throws(() => compileAbc(phrase('C4 |]') + '\n\n' + phrase('D4 |]')), /一首/);
  assert.throws(() => compileAbc('a'.repeat(48001)), /48000/);
  assert.throws(() => compileAbc(phrase('C4 |]'), { instrument: 'fake' }), /未知乐器/);
  assert.throws(() => compileAbc(phrase('C @ D |]')), /需要修正/);
});
test('durations too short to engrave compile, play and are reported once per token', () => {
  const compiled = compileAbc('X:1\nM:4/4\nL:1/16\nQ:1/4=120\nK:C\nz/8 C4 z/8 D2 z/8 |]');
  assert.deepEqual(compiled.summary.warnings, ['Duration not representable: z/8 (x3)']);
  const notes = notesOf(compiled);
  assert.equal(notes[0].midi, 60); assert.equal(notes[0].dur, 1);
  assert.equal(notes[1].midi, 62);
});
test('quoted chord labels do not silently create an accompaniment', () => {
  assert.equal(compileAbc(phrase('"Am"C4 |]')).summary.voices, 1);
});
test('saved scores require optimistic revision checks and survive restart', t => {
  const dir = scratch(t), store = new MusicStore(dir), first = store.saveScore(compileAbc(phrase('C4 |]')));
  assert.throws(() => store.saveScore(compileAbc(phrase('D4 |]')), { id: first.id }), /重新读取/);
  const second = store.saveScore(compileAbc(phrase('D4 |]')), { id: first.id, expectedRevision: first.revision });
  assert.notEqual(second.revision, first.revision);
  assert.equal(new MusicStore(dir).score(second.id).abc, second.abc);
  assert.throws(() => store.saveScore(compileAbc(phrase('E4 |]')), { id: first.id, expectedRevision: first.revision }), /重新读取/);
});
test('work retains original ABC after editing and deleting its score', t => {
  const dir = scratch(t), store = new MusicStore(dir), compiled = compileAbc(phrase('C4 |]'));
  const score = store.saveScore(compiled), work = store.addWork(compiled, { wav: Buffer.from('test'), seconds: 2 }, { score });
  store.saveScore(compileAbc(phrase('D4 |]')), { id: score.id, expectedRevision: score.revision });
  store.remove('scores', score.id);
  assert.equal(store.work(work.id).abc, compiled.abc);
  assert.equal(store.work(work.id).revision, score.revision);
  assert.equal(readFileSync(store.filePath(work.id, 'abc'), 'utf8'), compiled.abc);
  assert.deepEqual(readFileSync(store.filePath(work.id, 'mid')), compiled.midi);
  assert.throws(() => store.filePath('../../bad', 'wav'), /无效/);
});
test('title and instrument edits also invalidate stale revision tokens', t => {
  const store = new MusicStore(scratch(t)), compiled = compileAbc(phrase('C4 |]'));
  const first = store.saveScore(compiled), second = store.saveScore(compiled, { id: first.id, expectedRevision: first.revision, title: 'Renamed' });
  assert.notEqual(first.revision, second.revision);
  assert.throws(() => store.saveScore(compiled, { id: first.id, expectedRevision: first.revision }), /重新读取/);
  const third = store.saveScore(compileAbc(compiled.abc, { instrument: 'piano' }), { id: first.id, expectedRevision: second.revision, title: 'Renamed' });
  assert.notEqual(second.revision, third.revision);
});
test('headless sampled renderer emits stereo PCM and preserves audible dynamics', async t => {
  const renderer = new AudioRenderer(), compiled = compileAbc(phrase('!pp!C2 !ff!C2 |]'));
  const font = join(scratch(t), 'Test Bank.sf2'); testBank(font);
  const result = await renderer.render(compiled.midi, font);
  assert.equal(result.wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(result.wav.readUInt16LE(22), 2); assert.equal(result.wav.readUInt32LE(24), 44100);
  assert.equal(result.wav.readUInt16LE(34), 16);
  const samples = wavSamples(result.wav), rms = (start, end) => {
    const part = samples.slice(Math.floor(start * 88200), Math.floor(end * 88200));
    return Math.sqrt(part.reduce((sum, value) => sum + value * value, 0) / part.length);
  };
  assert.ok(rms(1.05, 1.3) > rms(0.05, 0.3) * 1.5);
  assert.ok(result.peak > 0.001 && result.peak <= 0.951);
});
test('renderer prevents overlapping jobs and reports a missing soundfont', async t => {
  const renderer = new AudioRenderer(), midi = compileAbc(phrase('C4 |]')).midi;
  const font = join(scratch(t), 'Test Bank.sf2'); testBank(font);
  const rendering = renderer.render(midi, font);
  await assert.rejects(renderer.render(midi, font), /正在生成/);
  await rendering;
  await assert.rejects(renderer.render(midi, join(tmpdir(), 'missing-abc-music-font.sf2')), /找不到/);
});
test('tool return delivery creates a score visible to the panel plus WAV/MIDI/snapshot', async t => {
  const { world } = worldFor(t);
  const result = await world.tools()[1].handler({ abc: phrase('C4 |]'), delivery: 'return' });
  assert.ok(!result.failed, result.text); assert.equal(result.blobs[0].mime, 'audio/wav');
  const scores = await world.invoke('scores', 'list'); assert.equal(scores.items.length, 1);
  const works = await world.invoke('works', 'list'); assert.equal(works.items.length, 1);
  const file = await world.invoke('works', 'file', [{ id: works.items[0].id, format: 'wav' }]);
  assert.equal(file.$file.sha256, createHash('sha256').update(result.blobs[0].bytes).digest('hex'));
});
test('event delivery honors archive/model and reports a failed event honestly', async t => {
  const { world } = worldFor(t), events = [];
  await world.start({ pushEvent: async (...args) => events.push(args) });
  const result = await world.tools()[1].handler({ abc: phrase('D4 |]') });
  assert.ok(!result.failed, result.text); assert.equal(events[0][0].type, 'audio.abc_played'); assert.equal(events[0][1].deliver, false);
  world.set({ eventDelivery: 'model' });
  await world.tools()[1].handler({ score: world.store.listScores()[0].id });
  assert.equal(events[1][1].deliver, true);
  await world.start({ pushEvent: async () => { throw new Error('event unavailable'); } });
  const failed = await world.tools()[1].handler({ score: world.store.listScores()[0].id });
  assert.equal(failed.failed, true); assert.match(failed.text, /event unavailable/); assert.equal(world.store.listWorks().length, 3);
  await world.stop();
});
test('panel preview renders audio without storing or emitting a work', async t => {
  const { world } = worldFor(t), events = [];
  await world.start({ pushEvent: async event => events.push(event) });
  const result = await world.invoke('scores', 'preview', [{ abc: phrase('C4 |]') }]);
  assert.equal(result.$binary.mime, 'audio/wav'); assert.equal(world.store.listWorks().length, 0); assert.equal(world.store.listScores().length, 0); assert.equal(events.length, 0);
  await world.stop();
});

test('instrument audition renders a test tone without creating scores or works', async t => {
  const { world } = worldFor(t), instruments = await world.invoke('instruments', 'list');
  const result = await world.invoke('instruments', 'preview', [instruments.state.instrument]);
  const wav = Buffer.from(result.$binary.base64, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.ok(wavSamples(wav).some(sample => Math.abs(sample) > .001));
  assert.deepEqual(world.store.listScores(), []);
  assert.deepEqual(world.store.listWorks(), []);
  await world.stop();
});
test('bad tool parameters do not create records', async t => {
  const { world } = worldFor(t);
  for (const args of [{}, { abc: phrase('C4 |]'), score: 'both' }, { abc: 'bad' }, { abc: phrase('C4 |]'), delivery: 'bad' }]) {
    const result = await world.tools()[1].handler(args); assert.equal(result.failed, true, JSON.stringify(args));
  }
  assert.equal(world.store.listScores().length, 0); assert.equal(world.store.listWorks().length, 0);
});
test('extension constructor has no filesystem effects and shares no old tool names', t => {
  const dir = join(scratch(t), 'uncreated'), world = def.create({ dataDir: dir });
  assert.equal(def.id, 'music-abc'); world.webUi(); assert.equal(existsSync(dir), false);
  assert.deepEqual(world.webUi().panels.map(one => one.id), ['scores', 'works', 'instruments', 'tools']);
  assert.ok(world.tools().every(tool => tool.name.startsWith('audio_abc_music_')));
});
test('score updates are pushed, and closing a panel removes its subscription', async t => {
  const { world } = worldFor(t), frames = []; let closed;
  const socket = { open: true, send: raw => frames.push(JSON.parse(raw)), onClose: cb => { closed = cb; } };
  world.stream('scores', socket);
  await world.invoke('scores', 'save', [{ abc: phrase('C4 |]') }]);
  assert.equal(frames[0].t, 'ready'); assert.equal(frames[1].t, 'changed'); closed(); assert.equal(world.streams.size, 0);
});
test('integrated describe retains ABC model-facing contracts and the configured env prompt', () => {
  const file = JSON.parse(readFileSync(new URL('../../describe.json', import.meta.url), 'utf8'));
  assert.deepEqual(file.tools.filter(tool => tool.name.startsWith('audio_abc_music_')), def.describe.tools);
  assert.deepEqual(file.events.filter(event => event.type === 'audio.abc_played'), def.describe.events);
  assert.equal(file.prompts[0].content, readFileSync(new URL('../../src/ENV_PROMPT.md', import.meta.url), 'utf8'));
});
test('download metadata pins the asset and retains its license without shipping samples', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../assets/music-abc/manifest.json', import.meta.url), 'utf8'));
  assert.equal(existsSync(new URL(`../../assets/music-abc/${manifest.file}`, import.meta.url)), false);
  assert.match(manifest.commit, /^[a-f0-9]{40}$/); assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.match(readFileSync(new URL('../../assets/music-abc/GeneralUser-GS-LICENSE.txt', import.meta.url), 'utf8'), /License v2.0/);
});
