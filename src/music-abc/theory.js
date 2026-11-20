/**
 * Chord symbols and pitch names for measured facts.
 *
 * The chord reader follows the lead-sheet grammar used by cortico-world-compose's
 * `src/theory.ts` (MIT): a root, an optional quality, extensions/alterations, and an
 * optional slash bass. It deliberately returns null instead of throwing so a label
 * the reader does not understand can be reported as a fact rather than blocking a
 * render.
 */

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function pitchName(midi) {
  return `${SHARP_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function parsePitchClass(text) {
  const match = /^([A-G])([#b]{0,2})$/.exec(text);
  if (!match) return null;
  let pc = LETTER[match[1]];
  for (const char of match[2]) pc += char === '#' ? 1 : -1;
  return ((pc % 12) + 12) % 12;
}

const NO_CHORD = /^(N\.?C\.?|\.|-)$/i;

/** Parses a chord label into pitch classes. Returns null when the label is not a chord. */
export function parseChord(symbol) {
  // abcjs normalizes chord labels to Unicode accidentals; the reader works in ASCII.
  const text = String(symbol ?? '').replaceAll('♭', 'b').replaceAll('♯', '#').trim();
  if (!text || NO_CHORD.test(text)) return null;
  const head = /^([A-G][#b]?)(.*)$/.exec(text);
  if (!head) return null;
  const root = parsePitchClass(head[1]);
  if (root === null) return null;
  let rest = head[2].replace(/[()\s,]/g, '');
  let bass = root;
  const slash = /\/([A-G][#b]?)$/.exec(rest);
  if (slash) {
    const pc = parsePitchClass(slash[1]);
    if (pc === null) return null;
    bass = pc;
    rest = rest.slice(0, slash.index);
  }

  let third = 4;
  let fifth = 7;
  let seventh = null;
  let major7 = false;
  let diminished = false;
  const lead = /^(maj|Maj|MAJ|M(?!aj)|Δ|\^|min|m(?!aj)|-|dim|°|o(?=7|$)|aug|\+|ø)/.exec(rest);
  if (lead) {
    const quality = lead[1];
    if (/^(maj|Maj|MAJ|M|Δ|\^)$/.test(quality)) major7 = true;
    else if (quality === 'min' || quality === 'm' || quality === '-') third = 3;
    else if (quality === 'dim' || quality === '°' || quality === 'o') { third = 3; fifth = 6; diminished = true; }
    else if (quality === 'aug' || quality === '+') fifth = 8;
    else if (quality === 'ø') { third = 3; fifth = 6; seventh = 10; }
    rest = rest.slice(quality.length);
  }

  const seventhOf = () => (major7 ? 11 : diminished ? 9 : 10);
  const extensions = new Set();
  const token = /^(sus4|sus2|sus|add9|add11|add13|add2|add4|6\/9|69|maj|M(?=7|9|11|13)|13|11|9|7|6|5|b5|#5|\+5|-5|b9|#9|#11|#4|b13|alt)/;
  while (rest.length > 0) {
    const match = token.exec(rest);
    if (!match) return null;
    const value = match[1];
    rest = rest.slice(value.length);
    if (value === '7') seventh = seventhOf();
    else if (value === '9') { seventh ??= seventhOf(); extensions.add(2); }
    else if (value === '11') { seventh ??= seventhOf(); extensions.add(2); extensions.add(5); if (third === 4) third = null; }
    else if (value === '13') { seventh ??= seventhOf(); extensions.add(2); extensions.add(9); }
    else if (value === '6') extensions.add(9);
    else if (value === '6/9' || value === '69') { extensions.add(9); extensions.add(2); }
    else if (value === 'maj' || value === 'M') major7 = true;
    else if (value === 'sus4' || value === 'sus') { third = null; extensions.add(5); }
    else if (value === 'sus2') { third = null; extensions.add(2); }
    else if (value === 'add9' || value === 'add2') extensions.add(2);
    else if (value === 'add11' || value === 'add4') extensions.add(5);
    else if (value === 'add13') extensions.add(9);
    else if (value === '5') third = null;
    else if (value === 'b5' || value === '-5') fifth = 6;
    else if (value === '#5' || value === '+5') fifth = 8;
    else if (value === 'b9') extensions.add(1);
    else if (value === '#9') extensions.add(3);
    else if (value === '#11' || value === '#4') extensions.add(6);
    else if (value === 'b13') extensions.add(8);
    else if (value === 'alt') { extensions.add(1); extensions.add(3); extensions.add(8); }
  }

  if (major7 && seventh !== null) seventh = 11;
  if (major7 && seventh === null && extensions.size > 0 && (extensions.has(2) || extensions.has(9))) {
    seventh = text.includes('6') ? null : 11;
  }
  const intervals = [0, ...(third === null ? [] : [third]), fifth, ...(seventh === null ? [] : [seventh]), ...extensions];
  return {
    symbol: text,
    root,
    bass,
    third,
    fifth,
    seventh,
    extensions: [...extensions],
    pcs: [...new Set(intervals.map(interval => (((root + interval) % 12) + 12) % 12))],
  };
}

/** Three or four notes for a comping hand: third and seventh first, then colour, around a register. */
export function voiceChord(chord, around) {
  const wanted = [];
  if (chord.third !== null) wanted.push(chord.third);
  if (chord.seventh !== null) wanted.push(chord.seventh);
  for (const extension of chord.extensions) if (wanted.length < 4) wanted.push(extension);
  if (wanted.length < 4) wanted.push(chord.fifth);
  if (wanted.length < 3) wanted.push(0);
  const notes = [...new Set(wanted.map(interval => (chord.root + interval) % 12))].map(pc => {
    let note = around - (((around - pc) % 12) + 12) % 12;
    if (around - note > 6) note += 12;
    return Math.min(74, Math.max(50, note));
  });
  return [...new Set(notes)].sort((a, b) => a - b);
}

/** The low register root of a bass note. */
export function bassRoot(pc) {
  return 28 + ((pc - 4 + 12) % 12);
}

const LETTER_ORDER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const MODE_INTERVALS = {
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

const modeWord = value => {
  const mode = String(value || '').toLowerCase();
  if (mode === 'm' || mode === 'min') return 'minor';
  if (!mode) return 'major';
  return mode;
};

function keyFromTonicMode(tonic, mode, tonicLetter = '') {
  const intervals = MODE_INTERVALS[modeWord(mode)] ?? MODE_INTERVALS[''];
  const scale = intervals.map(interval => (tonic + interval) % 12);
  const signatures = new Map();
  const letters = new Map();
  const start = LETTER_ORDER.indexOf(String(tonicLetter || '').toUpperCase()) >= 0
    ? LETTER_ORDER.indexOf(String(tonicLetter).toUpperCase())
    : Math.max(0, LETTER_ORDER.findIndex(letter => LETTER[letter] === tonic));
  for (let degree = 0; degree < 7; degree++) {
    const letter = LETTER_ORDER[(start + degree) % 7];
    const target = scale[degree];
    let diff = target - LETTER[letter];
    if (diff > 6) diff -= 12;
    if (diff < -6) diff += 12;
    signatures.set(letter, diff);
    letters.set(target, letter);
  }
  return {
    tonic, scale, signatures, letters,
    flats: [...signatures.values()].some(diff => diff < 0),
  };
}

/** A key from an ABC `K:` header, enough for spelling and diatonic transposition. */
export function keyFromAbc(abc) {
  const line = /^K:\s*(.+)$/m.exec(String(abc))?.[1].trim() ?? 'C';
  const match = /^([A-G][#b]?)\s*(m|min|minor|maj|major|dorian|mixolydian|lydian|phrygian|locrian)?/i.exec(line);
  if (!match) return keyFromTonicMode(0, 'major');
  return keyFromTonicMode(parsePitchClass(match[1]), match[2] || 'major', match[1][0]);
}

/** A key from abcjs' getKeySignature() result. */
export function keyFromSignature(signature) {
  if (!signature) return keyFromTonicMode(0, 'major');
  const tonic = parsePitchClass(`${signature.root || 'C'}${signature.acc || ''}`) ?? 0;
  const mode = signature.mode === 'm' ? 'minor' : signature.mode || 'major';
  return keyFromTonicMode(tonic, mode, signature.root || '');
}

/** MIDI pitch of an ABC note token's letter, octave marks, and explicit accidental. */
export function abcPitchToMidi(letter, marks, accidental, key) {
  const upper = letter.toUpperCase();
  let octave = letter === upper ? 4 : 5;
  for (const mark of marks) octave += mark === "'" ? 1 : -1;
  let pc = LETTER[upper] + (key.signatures.get(upper) ?? 0);
  if (accidental) {
    pc = LETTER[upper];
    if (accidental !== '=') {
      for (const mark of accidental) pc += mark === '^' ? 1 : mark === '_' ? -1 : 0;
    }
  }
  return 12 * (octave + 1) + pc;
}

const SHARP_LETTERS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const FLAT_LETTERS = ['C', 'D', 'D', 'E', 'E', 'F', 'G', 'G', 'A', 'A', 'B', 'B'];

/** Writes a MIDI pitch back as ABC, spelling it against the key where possible. */
export function midiToAbc(midi, key) {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const letter = key.letters.get(pc) ?? (key.flats ? FLAT_LETTERS[pc] : SHARP_LETTERS[pc]);
  const natural = LETTER[letter];
  const signature = key.signatures.get(letter) ?? 0;
  let diff = pc - natural;
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  const accidental = pc === natural + signature ? '' : pc === natural ? '=' : diff > 0 ? '^'.repeat(diff) : '_'.repeat(-diff);
  const written = octave >= 5 ? letter.toLowerCase() : letter;
  const marks = octave >= 5 ? "'".repeat(octave - 5) : ','.repeat(4 - octave);
  return `${accidental}${written}${marks}`;
}

/** Moves a MIDI pitch by scale steps of the key; chromatic notes keep their distance. */
export function diatonicShift(pitch, steps, key) {
  const rel = (((pitch - key.tonic) % 12) + 12) % 12;
  const offsets = key.scale.map(pc => (((pc - key.tonic) % 12) + 12) % 12);
  let degree = 0;
  for (let i = 0; i < 7; i++) if (offsets[i] <= rel) degree = i;
  const extra = rel - offsets[degree];
  const base = pitch - rel;
  const target = degree + steps;
  const octave = Math.floor(target / 7);
  return base + 12 * octave + offsets[((target % 7) + 7) % 7] + extra;
}
