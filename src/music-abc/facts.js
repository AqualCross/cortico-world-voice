/**
 * What can be measured about an ABC score before and after rendering: length, voices,
 * ranges, notes outside their instrument's usual range, repeated bars, rhythm variety,
 * steps/leaps, and long or downbeat notes that sit a semitone above a quoted chord.
 *
 * The receipt states these facts and leaves the judging to the writer.
 */
import { rangeOfProgram } from './instruments.js';
import { parseChord, pitchName } from './theory.js';

const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

function barKey(notes, from, to, withPitch) {
  return notes
    .filter(note => note.start >= from - 1e-9 && note.start < to - 1e-9)
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    .map(note => `${(note.start - from).toFixed(3)}:${note.duration.toFixed(3)}${withPitch ? `:${note.pitch}` : ''}`)
    .join(' ');
}

function voiceNames(abc) {
  const names = [];
  for (const line of String(abc).split('\n')) {
    const match = /^V:\s*([^\s]+)(?:\s+name="([^"]*)")?/i.exec(line.trim());
    if (match) names.push(match[2] || match[1]);
  }
  return names;
}

const KEY_MODES = {
  '': [0, 2, 4, 5, 7, 9, 11],
  'maj': [0, 2, 4, 5, 7, 9, 11],
  'major': [0, 2, 4, 5, 7, 9, 11],
  'm': [0, 2, 3, 5, 7, 8, 10],
  'min': [0, 2, 3, 5, 7, 8, 10],
  'minor': [0, 2, 3, 5, 7, 8, 10],
  'dor': [0, 2, 3, 5, 7, 9, 10],
  'dorian': [0, 2, 3, 5, 7, 9, 10],
  'mix': [0, 2, 4, 5, 7, 9, 10],
  'mixolydian': [0, 2, 4, 5, 7, 9, 10],
  'lyd': [0, 2, 4, 6, 7, 9, 11],
  'lydian': [0, 2, 4, 6, 7, 9, 11],
  'phr': [0, 1, 3, 5, 7, 8, 10],
  'phrygian': [0, 1, 3, 5, 7, 8, 10],
  'loc': [0, 1, 3, 5, 6, 8, 10],
  'locrian': [0, 1, 3, 5, 6, 8, 10],
};

/** The key's diatonic pitch classes, used to leave intentional 9ths/11ths/13ths alone. */
function keyInfo(tune, abc) {
  const text = /^K:\s*(.+)$/m.exec(String(abc))?.[1].trim() ?? '';
  if (text.toLowerCase() === 'none') return { label: text, pcs: null };
  const signature = tune.getKeySignature?.() ?? {};
  const chord = parseChord(`${signature.root || 'C'}${signature.acc || ''}`);
  if (!chord) return { label: text, pcs: null };
  const mode = String(signature.mode || '').toLowerCase();
  const intervals = KEY_MODES[mode] ?? KEY_MODES[''];
  return { label: text, pcs: intervals.map(interval => (chord.root + interval) % 12) };
}

/** Reads the parts of a tune that can be measured without rendering. */
export function measureAbc({ abc, tune, audio, song, notes, selected, warnings, writtenTrackCount = Infinity, backingNames = [] }) {
  const meter = tune.getMeterFraction?.() ?? { num: 4, den: 4 };
  // abcjs reports note starts/durations in whole notes; the meter tells us how many
  // quarter notes a bar holds (4/4 -> 4, 3/4 -> 3, 6/8 -> 3).
  const barQuarter = Math.max(1, meter.num * 4 / meter.den);
  const totalQuarter = Number.isFinite(audio.totalDuration)
    ? audio.totalDuration * 4
    : Math.max(0, ...notes.map(note => (note.start + note.duration) * 4));
  // A pickup is its own short bar; the remaining bars are full. Repeats are already
  // expanded in totalQuarter, so the count matches the rendered length.
  const pickupQuarter = Math.max(0, (tune.getPickupLength?.() ?? 0) * 4);
  const bars = Math.max(1, Math.round(Math.max(0, totalQuarter - pickupQuarter) / barQuarter) + (pickupQuarter > 1e-9 ? 1 : 0));
  const barStart = bar => pickupQuarter > 1e-9 ? (bar === 0 ? 0 : pickupQuarter + (bar - 1) * barQuarter) : bar * barQuarter;
  const barEnd = bar => pickupQuarter > 1e-9 ? (bar === 0 ? pickupQuarter : barStart(bar) + barQuarter) : (bar + 1) * barQuarter;
  const barOf = start => pickupQuarter > 1e-9
    ? (start < pickupQuarter - 1e-9 ? 0 : 1 + Math.floor((start - pickupQuarter) / barQuarter + 1e-9))
    : Math.floor(start / barQuarter + 1e-9);
  const writtenTempo = Number(tune.metaText?.tempo?.bpm);
  const tempo = Number.isFinite(writtenTempo) && writtenTempo > 0
    ? writtenTempo
    : (Number.isFinite(audio.tempo) ? audio.tempo : 100);
  const seconds = Number.isFinite(song?.duration) ? song.duration : totalQuarter * 60 / tempo;
  const names = voiceNames(abc);
  const key = keyInfo(tune, abc);
  const tracks = audio.tracks.filter(track => track.some(event => event.cmd === 'note'));

  const voices = tracks.map((track, index) => {
    const backing = index >= writtenTrackCount;
    const trackNotes = track.filter(event => event.cmd === 'note').map(note => ({ ...note, start: note.start * 4, duration: note.duration * 4 }));
    const programEvent = track.find(event => event.cmd === 'program');
    const program = programEvent?.instrument ?? trackNotes[0]?.instrument ?? selected.program;
    const drum = program === 128 || programEvent?.channel === 9 || (selected.isGMGSDrum === true && !programEvent);
    const range = drum || backing ? null : rangeOfProgram(program);
    const pitches = trackNotes.map(note => note.pitch);
    const lowest = Math.min(...pitches);
    const highest = Math.max(...pitches);
    const outOfRange = range ? trackNotes.filter(note => note.pitch < range[0] || note.pitch > range[1]).length : 0;
    const played = new Set(trackNotes.map(note => barOf(note.start)));
    const rawName = index < writtenTrackCount && names.length === writtenTrackCount ? names[index] : '';
    const name = rawName && !/^\d+$/.test(rawName) ? rawName : `声部 ${index + 1}`;
    return {
      name: backing ? (backingNames[index - writtenTrackCount] || '伴奏') : drum ? `${name}（鼓）` : name,
      backing, program, drum, notes: trackNotes.length, lowest, highest, outOfRange,
      silentBars: Math.max(0, bars - played.size),
    };
  });

  // The voice with the most notes is a useful stand-in for the melody; drums and the
  // generated backing never win it.
  let main = null;
  const melodic = voices.map((voice, index) => ({ voice, index })).filter(entry => !entry.voice.drum && !entry.voice.backing);
  if (melodic.length > 0) {
    const chosen = melodic.reduce((best, entry) => entry.voice.notes > best.voice.notes ? entry : best, melodic[0]);
    const trackNotes = tracks[chosen.index]
      .filter(event => event.cmd === 'note')
      .map(note => ({ ...note, start: note.start * 4, duration: note.duration * 4 }))
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const full = new Map();
    const shapes = new Set();
    let rhythmBars = 0;
    for (let bar = 0; bar < bars; bar++) {
      const key = barKey(trackNotes, barStart(bar), barEnd(bar), true);
      if (!key) continue;
      rhythmBars++;
      shapes.add(barKey(trackNotes, barStart(bar), barEnd(bar), false));
      full.set(key, [...(full.get(key) ?? []), bar + 1]);
    }
    const identicalBars = [...full.values()].filter(group => group.length > 1).sort((a, b) => a[0] - b[0]);
    const movement = { steps: 0, leaps: 0, repeats: 0, widest: 0 };
    for (let i = 1; i < trackNotes.length; i++) {
      const distance = Math.abs(trackNotes[i].pitch - trackNotes[i - 1].pitch);
      if (distance === 0) movement.repeats++;
      else if (distance <= 2) movement.steps++;
      else movement.leaps++;
      movement.widest = Math.max(movement.widest, distance);
    }
    main = {
      name: chosen.voice.name,
      ...movement,
      bars: rhythmBars,
      distinct: shapes.size,
      identicalBars,
    };
  }

  // Quoted chord labels are attached to the written note that starts them. The same
  // startChar is reused by every repeat, so the map also covers expanded repeats.
  const chordAtChar = new Map();
  for (const line of tune.lines ?? []) for (const staff of line.staff ?? []) for (const voice of staff.voices ?? []) {
    let current = '';
    for (const element of voice) {
      if (element.chord?.length) current = element.chord.map(chord => chord.name).filter(Boolean).join('/');
      if (element.el_type === 'note' && current) chordAtChar.set(element.startChar, current);
    }
  }

  const outside = [];
  const unreadable = new Set();
  for (const [index, track] of tracks.entries()) {
    if (voices[index].drum || voices[index].backing) continue;
    for (const note of track.filter(event => event.cmd === 'note')) {
      const symbol = chordAtChar.get(note.startChar);
      if (!symbol || /^(N\.?C\.?|\.|-)$/i.test(symbol)) continue;
      if (!/^[A-G]/.test(symbol)) continue;
      const chord = parseChord(symbol);
      if (!chord) { unreadable.add(symbol); continue; }
      const start = note.start * 4;
      const duration = note.duration * 4;
      const bar = barOf(start);
      const from = barStart(bar);
      const inBar = start - from;
      if (duration < 1 - 1e-9 && inBar > 1e-9) continue;
      const pc = ((note.pitch % 12) + 12) % 12;
      if (chord.pcs.includes(pc) || !chord.pcs.includes((pc + 11) % 12)) continue;
      // A perfect 11th or minor 7th above the root is a normal tension, not a clash.
      const interval = ((pc - chord.root) % 12 + 12) % 12;
      if (interval === 5 || interval === 10) continue;
      // A diatonic 9th/13th etc. is also a tension; only report chromatic ones.
      if (key.pcs?.includes(pc)) continue;
      outside.push({
        bar: bar + 1,
        beat: inBar + 1,
        pitch: note.pitch,
        chord: symbol,
        beats: duration,
      });
    }
  }

  return {
    bars,
    key: key.label,
    beatsPerBar: barQuarter,
    meter,
    tempo,
    seconds,
    voices,
    main,
    outside,
    unreadable: [...unreadable].sort(),
    warnings: [...warnings],
  };
}

/** The measured facts as receipt lines. */
export function describeFacts(facts, rendered = null) {
  const lines = [];
  const tempo = Number(facts.tempo.toFixed(1));
  lines.push(`${clock(facts.seconds)}，${facts.bars} 小节，${tempo} bpm，${facts.meter.num}/${facts.meter.den}${facts.key ? `，${facts.key}` : ''}。`);
  if (facts.voices.length > 0) {
    lines.push('声部：' + facts.voices.map(voice => {
      const range = voice.notes > 0 ? `${pitchName(voice.lowest)}–${pitchName(voice.highest)}` : '无音';
      const over = voice.outOfRange > 0 ? `，${voice.outOfRange} 个音超出常见音域` : '';
      return `${voice.name} ${voice.notes} 音（${range}${over}）`;
    }).join('；') + '。');
  }
  if (facts.main && facts.main.bars > 0) {
    const main = facts.main;
    lines.push(
      `主旋律（${main.name}）：${main.bars} 个有音小节里有 ${main.distinct} 种不同节奏；` +
      `${main.steps} 个级进，${main.leaps} 个跳进（最大 ${main.widest} 个半音），${main.repeats} 个重复音。`,
    );
  }
  if (facts.main?.identicalBars?.length > 0) {
    lines.push(
      '完全相同的小节：' +
      facts.main.identicalBars.slice(0, 8).map(group => group.join('=')).join(', ') +
      (facts.main.identicalBars.length > 8 ? ', …' : '') + '。',
    );
  }
  if (facts.outside.length > 0) {
    const shown = facts.outside.slice(0, 10).map(note =>
      `第 ${note.bar} 小节第 ${Number(note.beat.toFixed(2))} 拍 ${pitchName(note.pitch)} 在 ${note.chord} 上`);
    lines.push(`和弦冲突音（长音≥1拍或第一拍，${facts.outside.length}）：` + shown.join('；') + (facts.outside.length > 10 ? '；…' : '') + '。');
  }
  if (facts.unreadable.length > 0) lines.push(`无法解析的和弦：${facts.unreadable.join('、')}。`);
  if (facts.warnings.length > 0) {
    lines.push(`警告：${facts.warnings.slice(0, 8).join('；')}${facts.warnings.length > 8 ? '；…' : ''}。`);
  }
  if (rendered) {
    const level = Number.isFinite(rendered.rmsDb) ? `${rendered.rmsDb.toFixed(1)} dBFS RMS` : '';
    const peak = Number.isFinite(rendered.peakDb) ? `峰值 ${rendered.peakDb.toFixed(1)} dBFS` : '';
    if (level || peak) lines.push(`响度：${[level, peak].filter(Boolean).join('，')}。`);
  }
  return lines;
}
