import abcjs from 'abcjs';
import { BasicMIDI, MIDIMessage, MIDITrack, SpessaLog } from 'spessasynth_core';
import { instrumentOf } from './instruments.js';
import { blocksCompile } from './warnings.js';
import { measureAbc } from './facts.js';
import { expandMotifs } from './motifs.js';
import { GROOVES, GROOVE_NAMES, addBandToMidi, arrangeBand, chordTimeline, makeChordAt } from './band.js';

SpessaLog.setLogLevel(false, false, false);
export const MAX_ABC_LENGTH = 48000;
export const MAX_SECONDS = 360;
export const MAX_NOTES = 12000;
const plain = value => String(value).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
/** One entry per engraving-blocked token, e.g. "Duration not representable: z/8 (x8)". */
function unengraved(warnings) {
  const counts = new Map();
  for (const warning of warnings) {
    const token = warning.match(/Duration not representable: ([^:]*)/)?.[1].trim() ?? warning;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts].map(([token, count]) => `Duration not representable: ${token}${count > 1 ? ` (x${count})` : ''}`);
}

/** A score that cannot be rendered, with every problem the reader found. */
export class AbcError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'AbcError';
    this.problems = problems;
  }
}

/** ABC is the source of truth. Never flatten voices into a second text notation. */
export function compileAbc(value, { instrument = 'nylon-guitar', backing = 'off', groove = 'pop', energy = 3, sections = [] } = {}) {
  const backingMode = ['off', 'abcjs', 'band'].includes(backing) ? backing : 'off';
  const grooveName = String(groove || 'pop').toLowerCase();
  const energyValue = Math.round(Number(energy ?? 3));
  const sectionList = Array.isArray(sections) ? sections : [];
  const problems = [];
  const abc = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
  if (!abc) throw new AbcError(['ABC 乐谱为空。']);
  if (abc.length > MAX_ABC_LENGTH) throw new AbcError([`ABC 最多 ${MAX_ABC_LENGTH} 字符，请按乐段拆分。`]);
  const missing = ['X', 'M', 'L', 'K'].filter(header => !new RegExp(`^${header}:\\s*\\S`, 'm').test(abc));
  if (missing.length > 0) {
    throw new AbcError(missing.map(header => `缺少 ${header}: 头；请提供 X、M、L、K，建议同时写 T 和 Q。`));
  }

  const motif = expandMotifs(abc);
  if (motif.errors.length > 0) throw new AbcError(motif.errors);
  const expandedAbc = motif.abc;

  let selected;
  try {
    selected = instrumentOf(instrument);
  } catch (error) {
    problems.push(error.message);
    selected = instrumentOf('nylon-guitar');
  }

  let tunes;
  try {
    tunes = abcjs.parseOnly(expandedAbc);
  } catch (error) {
    problems.push(`ABC 解析失败：${error instanceof Error ? error.message : String(error)}`);
    throw new AbcError(problems);
  }
  if (tunes.length !== 1) problems.push('每份曲谱只接受一首曲子（一个 X:）。');
  const tune = tunes[0];
  if (!tune) throw new AbcError(problems.length > 0 ? problems : ['ABC 解析失败。']);

  const warnings = (tune.warnings ?? []).map(plain);
  const blocking = warnings.filter(blocksCompile);
  if (blocking.length > 0) problems.push(`ABC 需要修正：\n${blocking.join('\n')}`);

  const options = { program: selected.program, chordsOff: backingMode !== 'abcjs', generateDownload: true };
  let audio = null;
  try {
    audio = tune.setUpAudio(options);
  } catch (error) {
    problems.push(`ABC 音频事件生成失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const notes = audio?.tracks?.flat().filter(event => event.cmd === 'note') ?? [];
  if (notes.length === 0) problems.push('曲谱中没有可演奏的音符。');
  if (notes.length > MAX_NOTES) problems.push(`展开反复后最多 ${MAX_NOTES} 个音符。`);
  if (notes.some(note => note.pitch < 0 || note.pitch > 127)) problems.push('音高超出 MIDI 范围 0–127。');

  let midi = null;
  let song = null;
  if (audio && notes.length > 0) {
    try {
      const files = abcjs.synth.getMidiFile(expandedAbc, { ...options, midiOutputType: 'binary' });
      const data = Array.isArray(files) ? files[0] : files;
      midi = Buffer.from(data);
      song = BasicMIDI.fromArrayBuffer(midi.buffer.slice(midi.byteOffset, midi.byteOffset + midi.byteLength));
    } catch (error) {
      problems.push(`MIDI 生成失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (song && selected.file) {
    // A second default program identifies voices without an explicit ABC program.
    try {
      const probe = abcjs.parseOnly(expandedAbc)[0].setUpAudio({ ...options, program: selected.program === 0 ? 127 : 0 });
      const channels = new Map();
      audio.tracks.forEach((track, index) => {
        const before = track.filter(event => event.cmd === 'program');
        const after = probe.tracks[index]?.filter(event => event.cmd === 'program') || [];
        before.forEach((event, offset) => {
          const patch = after[offset]?.instrument !== event.instrument
            ? selected
            : { program: event.instrument === 128 ? 0 : event.instrument, bankMSB: 0, bankLSB: 0, isGMGSDrum: event.instrument === 128 };
          channels.set(event.channel, { patch });
        });
      });
      song.modify({ channels, midiParams: { system: 'gs' } });
      midi = Buffer.from(song.writeMIDI());
    } catch (error) {
      problems.push(`音色映射失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (song && (!Number.isFinite(song.duration) || song.duration <= 0 || song.duration > MAX_SECONDS)) {
    problems.push(`展开反复后时长须在 0–${MAX_SECONDS} 秒之间；当前 ${Number.isFinite(song.duration) ? song.duration.toFixed(1) : '?'} 秒。`);
  }
  if (problems.length > 0) throw new AbcError(problems);

  const meter = tune.getMeterFraction();
  const barQuarter = Math.max(1, meter.num * 4 / meter.den);
  const pickupQuarter = Math.max(0, (tune.getPickupLength?.() ?? 0) * 4);
  const totalQuarter = Number.isFinite(audio.totalDuration)
    ? audio.totalDuration * 4
    : Math.max(0, ...notes.map(note => (note.start + note.duration) * 4));
  const bars = Math.max(1, Math.round(Math.max(0, totalQuarter - pickupQuarter) / barQuarter) + (pickupQuarter > 1e-9 ? 1 : 0));
  const firstBar = pickupQuarter > 1e-9 ? 1 : 0;
  const allTracks = audio.tracks.filter(track => track.some(event => event.cmd === 'note'));
  let writtenTrackCount = allTracks.length;
  let backingNames = [];
  let backingNotes = 0;
  let factsAudio = audio;
  let checkedSections = [];

  if (backingMode === 'abcjs') {
    try {
      const written = tune.setUpAudio({ ...options, chordsOff: true });
      writtenTrackCount = written.tracks.filter(track => track.some(event => event.cmd === 'note')).length;
    } catch {
      writtenTrackCount = allTracks.length;
    }
    backingNames = ['伴奏（abcjs）'];
    backingNotes = allTracks.slice(writtenTrackCount).reduce((sum, track) => sum + track.filter(event => event.cmd === 'note').length, 0);
  } else if (backingMode === 'band') {
    if (!GROOVE_NAMES.includes(grooveName)) {
      problems.push(`groove "${grooveName}" is not known; use one of: ${GROOVE_NAMES.join(', ')}`);
    } else if (GROOVES[grooveName]?.beats && GROOVES[grooveName].beats !== barQuarter) {
      problems.push(`groove "${grooveName}" is in ${GROOVES[grooveName].beats}/4 and the tune's bar is ${barQuarter} quarter notes`);
    }
    if (!(energyValue >= 1 && energyValue <= 5)) problems.push(`energy ${String(energy)} must be an integer from 1 to 5`);
    for (const [index, section] of sectionList.entries()) {
      if (!section || typeof section !== 'object') { problems.push(`sections[${index}] must be an object`); continue; }
      const fromBar = Number(section.fromBar), toBar = Number(section.toBar);
      if (!Number.isInteger(fromBar) || fromBar < 1) problems.push(`sections[${index}].fromBar must be an integer of 1 or more`);
      if (!Number.isInteger(toBar) || toBar < fromBar) problems.push(`sections[${index}].toBar must be an integer no smaller than fromBar`);
      const sectionGroove = section.groove === undefined ? '' : String(section.groove).toLowerCase();
      if (sectionGroove && !GROOVE_NAMES.includes(sectionGroove)) problems.push(`sections[${index}].groove "${sectionGroove}" is not known`);
      else if (sectionGroove && GROOVES[sectionGroove]?.beats && GROOVES[sectionGroove].beats !== barQuarter) problems.push(`sections[${index}].groove "${sectionGroove}" does not fit this meter`);
      const sectionEnergy = section.energy === undefined ? undefined : Math.round(Number(section.energy));
      if (sectionEnergy !== undefined && !(sectionEnergy >= 1 && sectionEnergy <= 5)) problems.push(`sections[${index}].energy must be an integer from 1 to 5`);
      const stopBars = Array.isArray(section.stopBars) ? section.stopBars.map(Number) : [];
      if (stopBars.some(value => !Number.isInteger(value) || value < 1)) problems.push(`sections[${index}].stopBars must be integers of 1 or more`);
      checkedSections.push({
        fromBar, toBar,
        ...(sectionGroove ? { groove: sectionGroove } : {}),
        ...(sectionEnergy !== undefined ? { energy: sectionEnergy } : {}),
        ...(stopBars.length > 0 ? { stopBars: stopBars.filter(value => Number.isInteger(value) && value >= 1) } : {}),
      });
    }
    checkedSections.sort((a, b) => a.fromBar - b.fromBar);
    const timeline = chordTimeline(tune, audio);
    if (timeline.length === 0 && grooveName !== 'none') problems.push('backing=band needs at least one quoted chord (for example "C") to build the band from');
    if (problems.length > 0) throw new AbcError(problems);
    if (timeline.length > 0) {
      const tempoInfo = tune.metaText?.tempo;
      const writtenBpm = Number(tempoInfo?.bpm);
      const tempoUnit = Number(tempoInfo?.duration?.[0]) || 0.25;
      const quarterBpm = Number.isFinite(writtenBpm) && writtenBpm > 0 ? writtenBpm * tempoUnit * 4 : 120;
      const bandTracks = arrangeBand({
        title: String(tune.metaText.title || 'Untitled'),
        tempo: quarterBpm, barQuarter, pickupQuarter, bars, firstBar,
        chordAt: makeChordAt(timeline), groove: grooveName, energy: energyValue,
        sections: checkedSections, secondsPerQuarter: 60 / quarterBpm,
      });
      backingNames = bandTracks.map(track => track.name);
      const added = addBandToMidi(song, bandTracks, { MIDITrack, MIDIMessage });
      backingNotes = added.count;
      if (added.count > 0) {
        midi = Buffer.from(song.writeMIDI());
        song = BasicMIDI.fromArrayBuffer(midi.buffer.slice(midi.byteOffset, midi.byteOffset + midi.byteLength));
        factsAudio = {
          ...audio,
          tracks: [...audio.tracks, ...bandTracks.map(track => {
            const events = [{ cmd: 'program', instrument: track.role === 'drums' ? 128 : track.program, channel: track.role === 'drums' ? 9 : 0 }];
            for (const note of track.notes) events.push({ cmd: 'note', pitch: note.pitch, start: note.at / 4, duration: note.len / 4, instrument: track.role === 'drums' ? 128 : track.program });
            return events;
          })],
          totalDuration: Math.max(audio.totalDuration ?? 0, ...bandTracks.flatMap(track => track.notes.map(note => (note.at + note.len) / 4)), 0),
        };
      }
    }
  }

  const writtenTracks = allTracks.slice(0, writtenTrackCount);
  const writtenNotes = writtenTracks.reduce((sum, track) => sum + track.filter(event => event.cmd === 'note').length, 0);

  const facts = measureAbc({ abc: expandedAbc, tune, audio: factsAudio, song, notes, selected, warnings, writtenTrackCount, backingNames });
  const summary = {
    title: String(tune.metaText.title || '未命名乐谱').slice(0, 160),
    instrument: selected.id, instrumentLabel: selected.name || selected.label || selected.id,
    soundfont: selected.file || '', notes: writtenNotes, motifs: motif.definitions.length,
    voices: writtenTracks.length,
    backing: backingMode, backingNotes,
    ...(backingMode === 'band' ? { groove: grooveName, energy: energyValue, sections: checkedSections } : {}),
    seconds: Math.round(song.duration * 1000) / 1000,
    tempo: facts.tempo, meter, key: facts.key, bars: facts.bars,
    outOfRange: facts.voices.reduce((sum, voice) => sum + voice.outOfRange, 0),
    warnings: unengraved(warnings.filter(warning => !blocksCompile(warning))),
  };
  return { abc, expandedAbc, midi, summary, facts };
}
