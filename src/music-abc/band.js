/**
 * The band: groove patterns and a deterministic arranger for ABC lead sheets.
 *
 * The written ABC supplies melody, optional counter-lines and quoted chord names.
 * This module turns the chord names into comp, bass and drum parts adapted from
 * cortico-world-compose's `grooves.ts` / `arrange.ts` (MIT, Copyright (c) 2026
 * Phantivia, https://github.com/Phantivia/cortico-world-compose), but keeps the
 * output in quarter-note positions so it can be merged into the abcjs MIDI.
 * See licenses/cortico-world-compose-MIT.txt.
 */
import { bassRoot, parseChord, voiceChord } from './theory.js';

const KICK = 36, RIM = 37, SNARE = 38, CLAP = 39, HAT = 42, PEDAL = 44, OPEN = 46, RIDE = 51, TAMB = 54, MARACA = 70;

export const GROOVES = {
  pop: {
    summary: 'straight eighths: piano chords, electric bass, backbeat',
    grid: 8, beats: 4, comp: 'piano', bass: 'electric bass',
    compPatterns: { lo: ['x-------'], mid: ['x.x.x.x.', 'x.x.x.xo'], hi: ['x.xxx.xx', 'x.xxx.xx'] },
    bassPatterns: { lo: ['R-------'], mid: ['R--RR-5-', 'R--RR-a-'] },
    drums: [
      { note: HAT, a: 'xoxoxoxo', min: 2 }, { note: KICK, a: 'X...X...', b: 'X..xX...', min: 2 },
      { note: SNARE, a: '..X...X.', min: 3 }, { note: OPEN, a: '........', b: '.......o', min: 4 }, { note: TAMB, a: 'oooooooo', min: 5 },
    ],
  },
  rock: {
    summary: 'driving eighths: overdriven guitar, electric bass, loud backbeat',
    grid: 8, beats: 4, comp: 'overdrive guitar', bass: 'electric bass',
    compPatterns: { lo: ['x-------'], mid: ['X.x.X.x.'], hi: ['XxXxXxXx'] },
    bassPatterns: { lo: ['R-------'], mid: ['RRRRRRRR', 'RRRRRR5a'] },
    drums: [
      { note: HAT, a: 'XxXxXxXx', min: 2 }, { note: KICK, a: 'X..xX...', b: 'X..xX.x.', min: 2 },
      { note: SNARE, a: '..X...X.', min: 2 }, { note: OPEN, a: '........', b: '.......x', min: 4 },
    ],
  },
  ballad: {
    summary: 'slow and open: piano broken chords, soft bass, cross-stick',
    grid: 8, beats: 4, comp: 'piano', bass: 'acoustic bass',
    compPatterns: { lo: ['x-------'], mid: ['1-2-3-4-', '1-2-3-2-'], hi: ['12343234'] },
    bassPatterns: { lo: ['R-------'], mid: ['R-----5-', 'R-----a-'] },
    drums: [
      { note: RIM, a: '....x...', min: 3 }, { note: KICK, a: 'X.......', b: 'X....x..', min: 3 }, { note: HAT, a: 'o.o.o.o.', min: 4 },
    ],
  },
  bossa: {
    summary: 'bossa nova: nylon guitar comping, acoustic bass, rim-click clave',
    grid: 8, beats: 4, comp: 'nylon guitar', bass: 'acoustic bass',
    compPatterns: { lo: ['x-...x-.', '..x-....'], mid: ['x..x..x.', '..x..x..'], hi: ['x..x..x.', '.x..x..x'] },
    bassPatterns: { lo: ['R---5---'], mid: ['R--55--R', 'R--55--a'] },
    drums: [
      { note: HAT, a: 'XoxoXoxo', min: 2 }, { note: RIM, a: 'x..x..x.', b: '..x.x...', min: 3 },
      { note: KICK, a: 'x..ox..o', min: 3 }, { note: MARACA, a: 'oooooooo', min: 5 },
    ],
  },
  samba: {
    summary: 'fast samba in sixteenths: nylon guitar, busy percussion',
    grid: 16, beats: 4, comp: 'nylon guitar', bass: 'acoustic bass',
    compPatterns: { lo: ['x-----..x-----..'], mid: ['x..x..x...x.x...', '..x..x..x..x..x.'], hi: ['x..x..x...x.x...', '..x..x..x..x..x.'] },
    bassPatterns: { lo: ['R-------5-------'], mid: ['R--.5-..R--.5-..', 'R--.5-..R--.5-a.'] },
    drums: [
      { note: HAT, a: 'XoxoXoxoXoxoXoxo', min: 2 }, { note: KICK, a: 'X..xX..xX..xX..x', min: 3 },
      { note: RIM, a: 'x..x..x...x.x...', b: '..x.x...x..x..x.', min: 3 }, { note: TAMB, a: 'x.xxx.xxx.xxx.xx', min: 4 },
    ],
  },
  swing: {
    summary: 'jazz swing: walking bass, ride cymbal, piano stabs; eighths are swung',
    grid: 8, beats: 4, swing: 0.66, swingUnit: 1, comp: 'piano', bass: 'acoustic bass',
    compPatterns: { lo: ['x-------'], mid: ['x..x....', '...x..x.'], hi: ['x..x...x', '..x..x..'] },
    bassPatterns: { lo: ['R---5---'], mid: ['R.3.5.a.', 'R.5.3.a.'] },
    drums: [
      { note: RIDE, a: 'X.XxX.Xx', min: 2 }, { note: PEDAL, a: '..x...x.', min: 2 },
      { note: KICK, a: 'o...o...', min: 4 }, { note: SNARE, a: '...o....', b: '.......o', min: 4 },
    ],
  },
  waltz: {
    summary: 'three-four: bass on one, chords on two and three',
    grid: 6, beats: 3, comp: 'piano', bass: 'acoustic bass',
    compPatterns: { lo: ['x-----'], mid: ['..x.x.'], hi: ['..x.x.', '..xxx.'] },
    bassPatterns: { lo: ['R-----'], mid: ['R-....', '5-....'] },
    drums: [{ note: HAT, a: '..o.o.', min: 3 }, { note: KICK, a: 'x.....', min: 3 }],
  },
  funk: {
    summary: 'sixteenth-note funk: clean guitar chops, syncopated electric bass',
    grid: 16, beats: 4, comp: 'clean guitar', bass: 'electric bass',
    compPatterns: { lo: ['x---....x---....'], mid: ['..x.x..x.x..x.x.', '..x.x..x.x.x..x.'], hi: ['..x.x..x.x..x.x.', '..x.x..x.x.x..x.'] },
    bassPatterns: { lo: ['R-------R---5---'], mid: ['R..R.8.R..R.5.a.', 'R..R.8.R.3.5.a..'] },
    drums: [
      { note: HAT, a: 'xoxoxoxoxoxoxoxo', min: 2 }, { note: KICK, a: 'X..x..X...x.X...', min: 2 },
      { note: SNARE, a: '....X..o.o..X..o', min: 3 }, { note: OPEN, a: '................', b: '..............x.', min: 4 },
    ],
  },
  lofi: {
    summary: 'laid-back hip-hop beat: electric piano chords, soft kick and snare, lazy sixteenths',
    grid: 16, beats: 4, swing: 0.57, swingUnit: 0.5, comp: 'electric piano', bass: 'electric bass', touch: 0.85,
    compPatterns: { lo: ['x---------------'], mid: ['x---------------', 'x-------x-------'], hi: ['x-----x---------', 'x-------x---x---'] },
    bassPatterns: { lo: ['R---------------'], mid: ['R-----..R---5-..', 'R-----..R--.a-..'] },
    drums: [
      { note: KICK, a: 'X.....x...X.....', b: 'X.....x..xX.....', min: 2 }, { note: RIM, a: '....X.......X...', min: 2 },
      { note: HAT, a: 'o.o.o.o.o.o.o.o.', min: 3 }, { note: OPEN, a: '................', b: '..............o.', min: 5 },
    ],
  },
  dance: {
    summary: 'four-on-the-floor: kick on every beat, off-beat bass and hats, synth chords',
    grid: 16, beats: 4, comp: 'synth pad', bass: 'synth bass',
    compPatterns: { lo: ['x---------------'], mid: ['x..x..x.x..x..x.'], hi: ['x.xx.xx.x.xx.xx.'] },
    bassPatterns: { lo: ['R-------R-------'], mid: ['..R...R...R...R.', '..R...R...R...a.'] },
    drums: [
      { note: KICK, a: 'X...X...X...X...', min: 2 }, { note: OPEN, a: '..x...x...x...x.', min: 3 },
      { note: CLAP, a: '....X.......X...', min: 3 }, { note: HAT, a: 'o.o.o.o.o.o.o.o.', min: 4 },
    ],
  },
  ambient: {
    summary: 'no beat: one sustained string chord and a bass note per bar',
    grid: 1, beats: 0, comp: 'strings', bass: 'cello', touch: 0.8,
    compPatterns: { lo: ['x'], mid: ['x'], hi: ['x'] },
    bassPatterns: { lo: ['R'], mid: ['R'] },
    drums: [],
  },
};

export const GROOVE_NAMES = [...Object.keys(GROOVES), 'none'];

const PROGRAMS = {
  'piano': 0, 'electric piano': 4, 'nylon guitar': 24, 'acoustic bass': 32,
  'electric bass': 33, 'overdrive guitar': 29, 'clean guitar': 27, 'strings': 48,
  'synth pad': 89, 'synth bass': 38, 'cello': 42,
};
const programOf = name => PROGRAMS[name] ?? 0;

const MIX = {
  comp: { volume: 84, reverb: 32, pan: 54 },
  bass: { volume: 104, reverb: 0, pan: 64 },
  drums: { volume: 100, reverb: 22, pan: 64 },
};

const level = char => (char === 'X' ? 1.15 : char === 'o' ? 0.6 : 0.88);
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** Moves a quarter-note position onto the groove's swung grid. */
function swung(beat, groove) {
  if (!groove?.swing || !groove.swingUnit) return beat;
  const unit = groove.swingUnit, amount = groove.swing;
  const base = Math.floor(beat / unit + 1e-9) * unit;
  const x = (beat - base) / unit;
  return base + unit * (x < 0.5 ? x * (amount / 0.5) : amount + (x - 0.5) * ((1 - amount) / 0.5));
}

function rng(seed) {
  let a = 2166136261;
  for (const char of seed) a = Math.imul(a ^ char.charCodeAt(0), 16777619);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A chord timeline from the written ABC. Quoted chord labels attach to the note
 * that starts them; note events repeat those startChars through repeats, so the
 * timeline is already expanded to performance order.
 */
export function chordTimeline(tune, audio) {
  const atChar = new Map();
  for (const line of tune.lines ?? []) for (const staff of line.staff ?? []) for (const voice of staff.voices ?? []) {
    let current = '';
    for (const element of voice) {
      if (element.chord?.length) current = element.chord.map(chord => chord.name).filter(Boolean).join('/');
      if (element.el_type === 'note' && current) atChar.set(element.startChar, current);
    }
  }
  const events = [];
  const seen = new Set();
  for (const track of audio.tracks) for (const note of track) {
    if (note.cmd !== 'note') continue;
    const symbol = atChar.get(note.startChar);
    if (!symbol) continue;
    const start = note.start * 4;
    const key = `${start}:${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ start, symbol });
  }
  return events.sort((a, b) => a.start - b.start);
}

/** Returns the chord sounding at a quarter-note position, or null for N.C./silence. */
export function makeChordAt(timeline) {
  return quarter => {
    let symbol = null;
    for (const event of timeline) {
      if (event.start > quarter + 1e-9) break;
      symbol = event.symbol;
    }
    return parseChord(symbol);
  };
}

/**
 * Generates the band in quarter-note positions. `firstBar` is the first full bar
 * (a pickup is bar 0 and is left unaccompanied).
 */
export function arrangeBand({
  title, tempo, barQuarter, pickupQuarter, bars, firstBar,
  chordAt, groove: defaultGroove, energy: defaultEnergy, sections = [], secondsPerQuarter,
}) {
  const random = rng(`${title}:${tempo}:${bars}:${defaultGroove}:${defaultEnergy}`);
  const tracks = new Map();
  const programs = new Map();
  const programChanges = new Map();
  const add = (role, note) => {
    if (!tracks.has(role)) tracks.set(role, []);
    tracks.get(role).push(note);
  };
  const sectionAt = bar => {
    const found = sections.find(section => bar + 1 >= section.fromBar && bar + 1 <= section.toBar);
    return { groove: found?.groove || defaultGroove, energy: found?.energy ?? defaultEnergy, stopBars: found?.stopBars || [] };
  };
  const startOf = bar => pickupQuarter > 1e-9 ? (bar === 0 ? 0 : pickupQuarter + (bar - 1) * barQuarter) : bar * barQuarter;

  for (let bar = firstBar; bar < bars; bar++) {
    const { groove: grooveName, energy, stopBars } = sectionAt(bar);
    const groove = GROOVES[grooveName];
    if (!groove) continue;
    const barStart = startOf(bar);
    const firstChord = chordAt(barStart);
    const lastChord = chordAt(barStart + barQuarter - 1e-6);
    if (!firstChord && !lastChord) continue;
    const tier = energy <= 2 ? 'lo' : energy >= 4 ? 'hi' : 'mid';
    const touch = (0.6 + 0.09 * energy) * (groove.touch ?? 1);
    const slot = groove.grid === 1 ? barQuarter : barQuarter / groove.grid;
    const pick = patterns => patterns[bar % patterns.length];
    const nextChord = chordAt(barStart + barQuarter);
    if (!programs.has('comp')) programs.set('comp', programOf(groove.comp));
    if (!programs.has('bass')) programs.set('bass', programOf(groove.bass));
    for (const [role, program] of [['comp', programOf(groove.comp)], ['bass', programOf(groove.bass)]]) {
      const list = programChanges.get(role) || [];
      if (!list.length || list[list.length - 1].program !== program) list.push({ at: barStart, program });
      programChanges.set(role, list);
    }
    const push = (role, at, length, pitch, velocity, spread = 0) => {
      const swungAt = swung(at, groove);
      const swungEnd = swung(at + length, groove);
      const jitterSeconds = role === 'comp' ? 0.007 : role === 'bass' ? 0.005 : role === 'drums' ? 0.004 : 0;
      const strumSeconds = role === 'comp' && /guitar/.test(groove.comp) ? 0.007 : 0.002;
      const shift = ((random() - 0.5) * 2 * jitterSeconds + spread * strumSeconds) / secondsPerQuarter;
      add(role, {
        at: Math.max(0, swungAt + shift),
        len: Math.max(0.05, swungEnd - swungAt),
        pitch,
        velocity: Math.round(clamp(velocity + (random() - 0.5) * 10, 1, 127)),
      });
    };

    if (stopBars.includes(bar + 1)) {
      if (firstChord) {
        const voicing = voiceChord(firstChord, 62);
        voicing.forEach(pitch => push('comp', barStart, 0.45, pitch, 92 * touch));
        push('bass', barStart, 0.45, bassRoot(firstChord.bass), 100 * touch);
      }
      if (groove.drums.some(layer => energy >= layer.min)) {
        for (const pitch of [36, 38, 46]) push('drums', barStart, 0.2, pitch, 100 * touch);
      }
      continue;
    }

    let around = 62;
    const cp = pick(groove.compPatterns[tier]);
    for (let i = 0; i < cp.length; i++) {
      const char = cp[i];
      if (char === '.' || char === '-') continue;
      const chord = chordAt(barStart + i * slot);
      if (!chord) continue;
      let holds = 0;
      while (cp[i + 1 + holds] === '-') holds++;
      const voicing = voiceChord(chord, around);
      around = clamp(Math.round(voicing.reduce((sum, note) => sum + note, 0) / voicing.length), 58, 66);
      const ringing = holds === 0 && (cp[i + 1] === '.' || cp[i + 1] === undefined);
      const length = holds > 0 ? (1 + holds) * slot * 0.96 : groove.grid === 1 ? slot * 0.98 : ringing ? Math.min(slot * 1.6, 1) : slot * 0.9;
      if (/[1-4]/.test(char)) {
        push('comp', barStart + i * slot, Math.max(length, slot * 2), voicing[(Number(char) - 1) % voicing.length], 74 * touch);
      } else {
        voicing.forEach((pitch, index) => push('comp', barStart + i * slot, length, pitch, (72 + 3 * index) * touch * level(char), index));
      }
    }

    const bp = pick(groove.bassPatterns[tier === 'lo' ? 'lo' : 'mid']);
    for (let i = 0; i < bp.length; i++) {
      const char = bp[i];
      if (char === '.' || char === '-') continue;
      const chord = chordAt(barStart + i * slot);
      if (!chord) continue;
      let holds = 0;
      while (bp[i + 1 + holds] === '-') holds++;
      const root = bassRoot(chord.bass);
      const pitch = char === '5' ? (root + chord.fifth <= 48 ? root + chord.fifth : root + chord.fifth - 12)
        : char === '8' ? root + 12
        : char === '3' ? root + (chord.third ?? 5)
        : char === 'a' ? (nextChord ? bassRoot(nextChord.bass) - 1 : root)
        : root;
      push('bass', barStart + i * slot, (1 + holds) * slot * 0.92, Math.max(28, pitch), (char === 'R' ? 96 : 84) * touch);
    }

    const drumsOn = groove.drums.some(layer => energy >= layer.min);
    if (drumsOn) {
      const previousSection = bar > firstBar ? sectionAt(bar - 1) : null;
      const sectionStart = !previousSection || previousSection.groove !== grooveName || previousSection.energy !== energy;
      const nextSection = sectionAt(bar + 1);
      const sectionChange = nextSection.groove !== grooveName || nextSection.energy !== energy;
      const phraseEnd = bar < bars - 1 && ((bar + 1) % 8 === 0 || sectionChange);
      const fillFrom = barQuarter - (barQuarter === 3 ? 1 : 2);
      for (const layer of groove.drums) {
        if (energy < layer.min) continue;
        const pattern = bar % 2 === 1 && layer.b ? layer.b : layer.a;
        for (let i = 0; i < pattern.length; i++) {
          if (pattern[i] === '.') continue;
          if (phraseEnd && (layer.note === SNARE || layer.note === RIM) && i * slot >= fillFrom) continue;
          push('drums', barStart + i * slot, 0.2, layer.note, 96 * touch * level(pattern[i]));
        }
      }
      if (phraseEnd) {
        const toms = energy >= 4 ? [50, 48, 45, 43] : [38, 38, 38, 38];
        const count = barQuarter === 3 ? 2 : 4;
        for (let k = 0; k < count; k++) {
          push('drums', barStart + fillFrom + k * 0.5, 0.2, toms[k + (4 - count)], (58 + 12 * k) * touch);
        }
      }
      if (sectionStart && energy >= 4) push('drums', barStart, 1, 49, 88 * touch);
    }
  }

  const result = [];
  for (const [role, notes] of tracks) {
    if (!notes.length) continue;
    const mix = MIX[role];
    result.push({
      role,
      name: role === 'comp' ? '和弦伴奏（band）' : role === 'bass' ? '贝斯（band）' : '鼓（band）',
      program: role === 'drums' ? 0 : programs.get(role) ?? (role === 'comp' ? 0 : 32),
      programChanges: role === 'drums' ? [] : programChanges.get(role) ?? [],
      volume: mix.volume, reverb: mix.reverb, pan: mix.pan,
      notes,
    });
  }
  return result;
}

/** Adds the arranged tracks to a BasicMIDI song, choosing free channels. */
export function addBandToMidi(song, tracks, { MIDITrack, MIDIMessage }) {
  const used = new Set();
  for (const track of song.tracks) for (const channel of track.channels) used.add(channel);
  const free = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15].filter(channel => !used.has(channel));
  let next = 0;
  const count = tracks.reduce((sum, track) => sum + track.notes.length, 0);
  const division = Number(song.timeDivision) || 480;
  let maxTick = 0;
  for (const track of tracks) {
    const channel = track.role === 'drums' ? 9 : (free[next++] ?? 1);
    const midiTrack = new MIDITrack();
    midiTrack.name = track.name;
    midiTrack.channels.add(channel);
    if (track.role !== 'drums') midiTrack.events.push(new MIDIMessage(0, 0xc0 | channel, [track.program]));
    midiTrack.events.push(new MIDIMessage(0, 0xb0 | channel, [7, track.volume]));
    midiTrack.events.push(new MIDIMessage(0, 0xb0 | channel, [10, track.pan]));
    midiTrack.events.push(new MIDIMessage(0, 0xb0 | channel, [91, track.reverb]));
    for (const change of track.programChanges || []) midiTrack.events.push(new MIDIMessage(Math.max(0, Math.round(change.at * division)), 0xc0 | channel, [change.program]));
    for (const note of track.notes) {
      const on = Math.max(0, Math.round(note.at * division));
      const off = Math.max(on + 1, Math.round((note.at + note.len) * division));
      midiTrack.events.push(new MIDIMessage(on, 0x90 | channel, [note.pitch, note.velocity]));
      midiTrack.events.push(new MIDIMessage(off, 0x80 | channel, [note.pitch, 0]));
      maxTick = Math.max(maxTick, off);
    }
    midiTrack.events.sort((a, b) => a.ticks - b.ticks || ((a.statusByte & 0xf0) === 0x80 ? 0 : 1) - ((b.statusByte & 0xf0) === 0x80 ? 0 : 1));
    song.tracks.push(midiTrack);
  }
  return { count, maxTick };
}
