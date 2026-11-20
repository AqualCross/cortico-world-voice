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
import { parseChord } from '../../src/music-abc/theory.js';
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
test('named blocks allow a partial score revision', async t => {
  const { world } = worldFor(t), tool = world.tools()[0];
  const abc = 'X:1\nT:Blocks\nM:4/4\nL:1/4\nQ:1/4=100\nK:C\n% block: A\n|: C D E F :|\n% end: A\n% block: B\n|: G A B c :|\n% end: B\n';
  const saved = await world.invoke('scores', 'save', [{ abc }]);
  const revised = await tool.handler({ action: 'revise', id: saved.id, expectedRevision: saved.revision, block: 'B', abc: '|: A B c d :|' });
  assert.ok(!revised.failed, revised.text);
  const after = await world.invoke('scores', 'get', [saved.id]);
  assert.match(after.abc, /A B c d/);
  assert.match(after.abc, /C D E F/);
  assert.notEqual(after.revision, saved.revision);
  const missing = await tool.handler({ action: 'revise', id: saved.id, block: 'C', abc: '|: C D E F :|' });
  assert.equal(missing.failed, true);
  assert.match(missing.text, /找不到块/);
});

test('motif macros expand and transpose by scale steps', () => {
  const abc = 'X:1\nT:Motif\nM:4/4\nL:1/4\nQ:1/4=100\nK:C\n% motif drip: C D E F\n@drip | @drip+1 | @drip-1 |]';
  const compiled = compileAbc(abc);
  assert.equal(compiled.summary.motifs, 1);
  assert.match(compiled.expandedAbc, /C D E F/);
  const notes = notesOf(compiled);
  assert.deepEqual(notes.slice(0, 4).map(note => note.midi), [60, 62, 64, 65]);
  assert.deepEqual(notes.slice(4, 8).map(note => note.midi), [62, 64, 65, 67]);
  assert.deepEqual(notes.slice(8, 12).map(note => note.midi), [59, 60, 62, 64]);
  assert.throws(() => compileAbc('X:1\nM:4/4\nL:1/4\nK:C\n@nope |]'), error => {
    assert.ok(error.problems.some(problem => /no "% motif/.test(problem)));
    return true;
  });
});

test('chord facts leave diatonic tensions alone', () => {
  const compiled = compileAbc('X:1\nM:4/4\nL:1/4\nQ:1/4=100\nK:C\n"A" D4 | "C" ^C4 |]');
  assert.equal(compiled.facts.key, 'C');
  assert.equal(compiled.facts.outside.length, 1);
  assert.equal(compiled.facts.outside[0].chord, 'C');
  const e = compileAbc('X:1\nM:4/4\nL:1/4\nQ:1/4=100\nK:E\n"A" =D4 | "E" =F4 |]');
  assert.equal(e.facts.outside.length, 1);
  assert.equal(e.facts.outside[0].chord, 'E');
});

test('facts report voices, ranges, repeated bars and notes outside a quoted chord', () => {
  const abc = phrase('V:1 name="Melody"\n"C" C E G ^C | "F" F A c A |]\nV:2 name="Bass"\n%%MIDI program 32\nC,2 G,2 | F,2 c,2 |]');
  const compiled = compileAbc(abc);
  assert.equal(compiled.facts.bars, 2);
  assert.equal(compiled.facts.voices.length, 2);
  assert.equal(compiled.facts.voices[0].name, 'Melody');
  assert.equal(compiled.facts.voices[1].outOfRange, 1);
  assert.equal(compiled.summary.outOfRange, 1);
  assert.equal(compiled.facts.outside.length, 1);
  assert.equal(compiled.facts.outside[0].chord, 'C');
  assert.equal(compiled.facts.outside[0].pitch, 61);
});
test('abcjs backing is opt-in and keeps written voices separate', () => {
  const abc = phrase('"C" C E G B | "F" F A c A |]');
  const off = compileAbc(abc);
  const on = compileAbc(abc, { backing: 'abcjs' });
  assert.equal(off.summary.backing, 'off');
  assert.equal(off.summary.voices, 1);
  assert.equal(off.summary.backingNotes, 0);
  assert.equal(on.summary.backing, 'abcjs');
  assert.equal(on.summary.voices, 1);
  assert.ok(on.summary.backingNotes > 0);
  assert.equal(on.facts.voices.length, 2);
  assert.equal(on.facts.voices[1].backing, true);
  assert.equal(on.facts.voices[1].name, '伴奏（abcjs）');
  assert.equal(on.facts.main.name, '声部 1');
});
test('band backing arranges comp, bass and drums from quoted chords', () => {
  const abc = phrase('"C" E G c B | "Am" A c e d | "F" F A c B | "G7" G B d f |]');
  const low = compileAbc(abc, { backing: 'band', groove: 'pop', energy: 1 });
  const band = compileAbc(abc, { backing: 'band', groove: 'pop', energy: 3 });
  assert.equal(band.summary.backing, 'band');
  assert.equal(band.summary.groove, 'pop');
  assert.equal(band.summary.energy, 3);
  assert.equal(band.summary.voices, 1);
  assert.ok(band.summary.backingNotes > low.summary.backingNotes);
  assert.equal(band.facts.main.name, '声部 1');
  assert.ok(band.facts.voices.some(voice => voice.name === '和弦伴奏（band）'));
  assert.ok(band.facts.voices.some(voice => voice.name === '贝斯（band）'));
  assert.ok(band.facts.voices.some(voice => voice.name === '鼓（band）'));
});
test('band backing validates chords, groove and meter', () => {
  assert.throws(() => compileAbc(phrase('C D E F |]'), { backing: 'band' }), error => {
    assert.ok(error.problems.some(problem => /quoted chord/.test(problem)));
    return true;
  });
  assert.throws(() => compileAbc('X:1\nM:3/4\nL:1/4\nQ:1/4=100\nK:C\n"C" C D E |]', { backing: 'band', groove: 'pop' }), error => {
    assert.ok(error.problems.some(problem => /groove "pop"/.test(problem)));
    return true;
  });
  assert.throws(() => compileAbc(phrase('"C" C D E F |]'), { backing: 'band', sections: [{ fromBar: 3, toBar: 1 }] }), error => {
    assert.ok(error.problems.some(problem => /toBar/.test(problem)));
    return true;
  });
});
test('band backing accepts per-section groove and energy overrides', () => {
  const abc = phrase(Array.from({ length: 8 }, (_, index) => index % 4 === 0 ? '"C" E G c B' : index % 4 === 1 ? '"Am" A c e d' : index % 4 === 2 ? '"F" F A c B' : '"G7" G B d f').join(' | ') + ' |]');
  const band = compileAbc(abc, {
    backing: 'band', groove: 'pop', energy: 3,
    sections: [{ fromBar: 1, toBar: 4, groove: 'bossa', energy: 2, stopBars: [2] }, { fromBar: 5, toBar: 8, groove: 'funk', energy: 5 }],
  });
  assert.equal(band.summary.sections.length, 2);
  assert.deepEqual(band.summary.sections[0].stopBars, [2]);
  assert.equal(band.summary.sections[1].groove, 'funk');
  assert.equal(band.summary.sections[1].energy, 5);
  assert.ok(band.summary.backingNotes > 0);
  assert.ok(band.facts.voices.some(voice => voice.name === '鼓（band）'));
});
test('backing is a persisted configuration value', async t => {
  const { world, patches } = worldFor(t);
  assert.equal(world.status().backing, 'off');
  world.set({ backing: 'band', groove: 'bossa', energy: 4 });
  assert.equal(world.status().backing, 'band');
  assert.equal(world.status().groove, 'bossa');
  assert.equal(world.status().energy, 4);
  assert.deepEqual(patches.at(-1), { backing: 'band', groove: 'bossa', energy: 4 });
  assert.throws(() => world.set({ backing: 'other' }), /backing/);
  assert.throws(() => world.set({ groove: 'other' }), /groove/);
  assert.throws(() => world.set({ energy: 9 }), /energy/);
});
test('the arrangement panel is an alias of the scores panel', async t => {
  const { world } = worldFor(t);
  const list = await world.invoke('arrange', 'list');
  assert.deepEqual(list.items, []);
  await world.invoke('scores', 'save', [{ abc: phrase('"C" C E G |]') }]);
  const arranged = await world.invoke('arrange', 'list');
  assert.equal(arranged.items.length, 1);
});
test('a sheet with several problems reports all of them', () => {
  assert.throws(() => compileAbc('X:1\nM:4/4\nL:1/4\nK:C\nH9 |]\n'), error => {
    assert.ok(Array.isArray(error.problems));
    assert.ok(error.problems.length >= 2);
    assert.ok(error.problems.some(problem => /H9/.test(problem)));
    assert.ok(error.problems.some(problem => /没有可演奏/.test(problem)));
    return true;
  });
  assert.throws(() => compileAbc('X:1\nC D E F |]'), error => {
    assert.deepEqual(error.problems.map(problem => problem.match(/缺少 ([XMLK]):/)[1]), ['M', 'L', 'K']);
    return true;
  });
});
test('quoted chord symbols name the expected pitch classes', () => {
  const pcs = symbol => [...parseChord(symbol).pcs].sort((a, b) => a - b);
  assert.deepEqual(pcs('C'), [0, 4, 7]);
  assert.deepEqual(pcs('Am7'), [0, 4, 7, 9]);
  assert.deepEqual(pcs('Fmaj7'), [0, 4, 5, 9]);
  assert.deepEqual(pcs('G7'), [2, 5, 7, 11]);
  assert.deepEqual(pcs('Bb7#11'), [2, 4, 5, 8, 10]);
  assert.deepEqual(pcs('F#m7b5'), [0, 4, 6, 9]);
  assert.deepEqual(pcs('F♯m7b5'), [0, 4, 6, 9]);
  assert.deepEqual(pcs('B♭maj7'), [2, 5, 9, 10]);
  assert.deepEqual(pcs('Csus4'), [0, 5, 7]);
  assert.deepEqual(pcs('C6/9'), [0, 2, 4, 7, 9]);
  assert.deepEqual(pcs('G/B'), [2, 7, 11]);
});
test('saved scores require optimistic revision checks and survive restart', t => {
  const dir = scratch(t), store = new MusicStore(dir), first = store.saveScore(compileAbc(phrase('C4 |]')));
  assert.throws(() => store.saveScore(compileAbc(phrase('D4 |]')), { id: first.id }), /重新读取/);
  const second = store.saveScore(compileAbc(phrase('D4 |]')), { id: first.id, expectedRevision: first.revision });
  assert.notEqual(second.revision, first.revision);
  assert.equal(new MusicStore(dir).score(second.id).abc, second.abc);
  assert.throws(() => store.saveScore(compileAbc(phrase('E4 |]')), { id: first.id, expectedRevision: first.revision }), /重新读取/);
});
test('work stores a WAV record and keeps score provenance', t => {
  const dir = scratch(t), store = new MusicStore(dir), compiled = compileAbc(phrase('C4 |]'));
  const score = store.saveScore(compiled), work = store.addWork(compiled, { wav: Buffer.from('test'), seconds: 2 }, { score });
  store.saveScore(compileAbc(phrase('D4 |]')), { id: score.id, expectedRevision: score.revision });
  store.remove('scores', score.id);
  assert.equal(store.work(work.id).abc, undefined);
  assert.equal(store.work(work.id).revision, score.revision);
  assert.equal(readFileSync(store.filePath(work.id, 'wav'), 'utf8'), 'test');
  assert.throws(() => store.filePath(work.id, 'mid'), /无效/);
  assert.throws(() => store.filePath(work.id, 'abc'), /无效/);
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
  assert.ok(Number.isFinite(result.rmsDb) && result.rmsDb < 0);
  assert.ok(Number.isFinite(result.peakDb) && result.peakDb <= -0.4);
});
test('renderer prevents overlapping jobs and reports a missing soundfont', async t => {
  const renderer = new AudioRenderer(), midi = compileAbc(phrase('C4 |]')).midi;
  const font = join(scratch(t), 'Test Bank.sf2'); testBank(font);
  const rendering = renderer.render(midi, font);
  await assert.rejects(renderer.render(midi, font), /正在生成/);
  await rendering;
  await assert.rejects(renderer.render(midi, join(tmpdir(), 'missing-abc-music-font.sf2')), /找不到/);
});
test('tool return delivery creates a score plus a WAV-only work record', async t => {
  const { world } = worldFor(t);
  const result = await world.tools()[1].handler({ abc: phrase('C4 |]'), delivery: 'return' });
  assert.ok(!result.failed, result.text); assert.equal(result.blobs[0].mime, 'audio/wav');
  assert.match(result.text, /声部：/); assert.match(result.text, /响度：/);
  const scores = await world.invoke('scores', 'list'); assert.equal(scores.items.length, 1);
  const works = await world.invoke('works', 'list'); assert.equal(works.items.length, 1);
  assert.equal(works.items[0].analysis.bars, 1);
  assert.equal(works.items[0].abc, undefined);
  assert.equal(existsSync(join(world.store.dir, 'works', `${works.items[0].id}.mid`)), false);
  assert.equal(existsSync(join(world.store.dir, 'works', `${works.items[0].id}.abc`)), false);
  const file = await world.invoke('works', 'file', [{ id: works.items[0].id, format: 'wav' }]);
  assert.equal(file.$file.sha256, createHash('sha256').update(result.blobs[0].bytes).digest('hex'));
});
test('the scores panel exports a MIDI file on demand', async t => {
  const { world } = worldFor(t);
  const plain = await world.invoke('scores', 'midi', [{ abc: phrase('C4 |]') }]);
  assert.equal(plain.$binary.mime, 'audio/midi');
  const bytes = Buffer.from(plain.$binary.base64, 'base64');
  assert.equal(bytes.toString('ascii', 0, 4), 'MThd');
  const saved = await world.invoke('scores', 'save', [{ abc: phrase('"C" C E G c |]'), backing: 'band', groove: 'lofi', energy: 2 }]);
  const withBand = await world.invoke('scores', 'midi', [{ score: saved.id }]);
  const bandBytes = Buffer.from(withBand.$binary.base64, 'base64');
  const song = BasicMIDI.fromArrayBuffer(bandBytes.buffer.slice(bandBytes.byteOffset, bandBytes.byteOffset + bandBytes.byteLength));
  assert.ok(song.tracks.length > 2);
});

test('a rejected score is kept as a draft that can be read back', async t => {
  const { world } = worldFor(t), tool = world.tools()[0];
  const checked = await tool.handler({ action: 'check', abc: 'X:1\nM:4/4\nL:1/4\nK:C\nH9 |]', title: 'Bad' });
  assert.equal(checked.failed, true);
  assert.match(checked.text, /草稿已保留/);
  const drafts = JSON.parse((await tool.handler({ action: 'drafts' })).text);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].title, 'Bad');
  assert.ok(drafts[0].problems.length >= 2);
  const draft = JSON.parse((await tool.handler({ action: 'draft', id: drafts[0].id })).text);
  assert.match(draft.abc, /H9/);
  assert.equal(draft.draft, true);
  const got = JSON.parse((await tool.handler({ action: 'get', id: drafts[0].id })).text);
  assert.equal(got.draft, true);
});
test('the play tool can render abcjs backing and records it on the work', async t => {
  const { world } = worldFor(t);
  const result = await world.tools()[1].handler({ abc: phrase('"C" C E G B | "F" F A c A |]'), backing: 'abcjs', delivery: 'return' });
  assert.ok(!result.failed, result.text);
  assert.match(result.text, /伴奏 abcjs/);
  const works = await world.invoke('works', 'list');
  assert.equal(works.items[0].backing, 'abcjs');
  assert.ok(works.items[0].backingNotes > 0);
  assert.equal(works.items[0].analysis.backing, 'abcjs');
});
test('the play tool can render band backing and records groove and energy', async t => {
  const { world } = worldFor(t);
  const result = await world.tools()[1].handler({
    abc: phrase('"C" E G c B | "Am" A c e d |]'), backing: 'band', groove: 'lofi', energy: 2, delivery: 'return',
  });
  assert.ok(!result.failed, result.text);
  assert.match(result.text, /伴奏 band（lofi，能量 2）/);
  const works = await world.invoke('works', 'list');
  assert.equal(works.items[0].backing, 'band');
  assert.equal(works.items[0].groove, 'lofi');
  assert.equal(works.items[0].energy, 2);
  assert.ok(works.items[0].backingNotes > 0);
  assert.equal(works.items[0].analysis.groove, 'lofi');
  assert.equal(works.items[0].analysis.energy, 2);
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
