/**
 * Motif macros for ABC lead sheets.
 *
 * A definition is a comment line:
 *
 *   % motif drip: A4 - - . C5 - A4 . | G4 - - . F4 - . .
 *
 * A music bar that is only `@drip`, `@drip+2` or `@drip-1` is replaced by the
 * motif's bars; the number moves every note by that many scale steps of the key.
 * Definitions and references stay in the score as comments/placeholders; the
 * expanded text is what abcjs engraves and renders.
 */
import { abcPitchToMidi, diatonicShift, keyFromAbc, midiToAbc } from './theory.js';

const NOTE = /^([\^_=]*)([A-Ga-g])([,']*)(.*)$/;
const NAME = String.raw`[\p{L}\p{N}_.-]+`;
const DEFINITION = new RegExp(String.raw`^\s*%(?:\s*)motif\s+(${NAME})\s*:\s*(.+?)\s*$`, 'iu');
const REFERENCE = /^(\s*(?:\[[^\]]+\]\s*)?(?:"[^"]*"\s*)*)@([^\s|]+)\s*$/u;

function transposeBody(text, steps, key) {
  return text.split(/(\s+)/).map(token => {
    if (!token || /^\s+$/.test(token)) return token;
    if (/^["!+\]\[{}()|zx%\/:>-]/.test(token)) return token;
    const match = NOTE.exec(token);
    if (!match) return token;
    const midi = abcPitchToMidi(match[2], match[3], match[1], key);
    return midiToAbc(diatonicShift(midi, steps, key), key) + match[4];
  }).join('');
}

/** Expands motif references. Returns the expanded ABC and any problems. */
export function expandMotifs(abc) {
  const source = String(abc);
  const definitions = new Map();
  const errors = [];
  for (const line of source.split('\n')) {
    const match = DEFINITION.exec(line);
    if (match) definitions.set(match[1], match[2].trim());
  }
  if (definitions.size === 0) {
    if (source.split('\n').some(line => !line.trim().startsWith('%') && /(^|\|)\s*@[\p{L}\p{N}_.-]+/u.test(line))) {
      errors.push('motif references exist but there is no "% motif name: ..." definition');
    }
    return { abc: source, definitions: [], errors };
  }
  const key = keyFromAbc(source);
  const lines = source.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%') || /^[A-Za-z]:/.test(trimmed)) return line;
    return line.split('|').map(bar => {
      const reference = REFERENCE.exec(bar);
      if (!reference) {
        if (bar.includes('@')) errors.push(`motif reference "${bar.trim()}" must occupy a whole bar`);
        return bar;
      }
      const prefix = reference[1];
      let name = reference[2];
      let steps = 0;
      let motif = definitions.get(name);
      if (motif === undefined) {
        const stepped = /^(.*?)([+-]\d+)$/.exec(name);
        if (stepped && definitions.has(stepped[1])) {
          name = stepped[1];
          steps = Number(stepped[2]);
          motif = definitions.get(name);
        }
      }
      if (motif === undefined) {
        errors.push(`motif "${name}" is not defined; add a "% motif ${name}: ..." line`);
        return bar;
      }
      let expanded = motif;
      if (steps !== 0) expanded = transposeBody(expanded, steps, key);
      if (expanded.includes('@')) errors.push(`motif "${name}" contains another motif reference`);
      return `${prefix} ${expanded} `;
    }).join('|');
  });
  return { abc: lines.join('\n'), definitions: [...definitions.keys()], errors };
}
