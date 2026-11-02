import abcjs from 'abcjs';
import { BasicMIDI, SpessaLog } from 'spessasynth_core';
import { instrumentOf } from './instruments.js';
import { blocksCompile } from './warnings.js';

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

/** ABC is the source of truth. Never flatten voices into a second text notation. */
export function compileAbc(value, { instrument = 'nylon-guitar' } = {}) {
  const abc = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
  if (!abc) throw new Error('ABC 乐谱为空。');
  if (abc.length > MAX_ABC_LENGTH) throw new Error(`ABC 最多 ${MAX_ABC_LENGTH} 字符，请按乐段拆分。`);
  for (const header of ['X', 'M', 'L', 'K']) {
    if (!new RegExp(`^${header}:\\s*\\S`, 'm').test(abc)) throw new Error(`缺少 ${header}: 头；请提供 X、M、L、K，建议同时写 T 和 Q。`);
  }
  const selected = instrumentOf(instrument);
  const tunes = abcjs.parseOnly(abc);
  if (tunes.length !== 1) throw new Error('每份曲谱只接受一首曲子（一个 X:）。');
  const tune = tunes[0];
  const warnings = (tune.warnings ?? []).map(plain);
  const blocking = warnings.filter(blocksCompile);
  if (blocking.length) throw new Error(`ABC 需要修正：\n${blocking.join('\n')}`);
  const options = { program: selected.program, chordsOff: true, generateDownload: true };
  const audio = tune.setUpAudio(options);
  const notes = audio.tracks.flat().filter(event => event.cmd === 'note');
  if (!notes.length) throw new Error('曲谱中没有可演奏的音符。');
  if (notes.length > MAX_NOTES) throw new Error(`展开反复后最多 ${MAX_NOTES} 个音符。`);
  if (notes.some(note => note.pitch < 0 || note.pitch > 127)) throw new Error('音高超出 MIDI 范围 0–127。');
  const files = abcjs.synth.getMidiFile(abc, { ...options, midiOutputType: 'binary' });
  const data = Array.isArray(files) ? files[0] : files;
  let midi = Buffer.from(data);
  const song = BasicMIDI.fromArrayBuffer(midi.buffer.slice(midi.byteOffset, midi.byteOffset + midi.byteLength));
  if (selected.file) {
    // A second default program identifies voices without an explicit ABC program.
    const probe = abcjs.parseOnly(abc)[0].setUpAudio({ ...options, program: selected.program === 0 ? 127 : 0 });
    const channels = new Map();
    audio.tracks.forEach((track, index) => {
      const before = track.filter(event => event.cmd === 'program'), after = probe.tracks[index]?.filter(event => event.cmd === 'program') || [];
      before.forEach((event, offset) => {
        const patch = after[offset]?.instrument !== event.instrument ? selected : { program: event.instrument === 128 ? 0 : event.instrument, bankMSB: 0, bankLSB: 0, isGMGSDrum: event.instrument === 128 };
        channels.set(event.channel, { patch });
      });
    });
    song.modify({ channels, midiParams: { system: 'gs' } });
    midi = Buffer.from(song.writeMIDI());
  }
  if (!Number.isFinite(song.duration) || song.duration <= 0 || song.duration > MAX_SECONDS) {
    throw new Error(`展开反复后时长须在 0–${MAX_SECONDS} 秒之间；当前 ${song.duration.toFixed(1)} 秒。`);
  }
  return {
    abc, midi,
    summary: {
      title: String(tune.metaText.title || '未命名乐谱').slice(0, 160),
      instrument: selected.id, instrumentLabel: selected.name || selected.label || selected.id,
      soundfont: selected.file || '', notes: notes.length,
      voices: audio.tracks.filter(track => track.some(event => event.cmd === 'note')).length,
      seconds: Math.round(song.duration * 1000) / 1000,
      tempo: audio.tempo, meter: tune.getMeterFraction(), warnings: unengraved(warnings.filter(warning => !blocksCompile(warning))),
    },
  };
}
