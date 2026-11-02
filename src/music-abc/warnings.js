// Durations shorter than a 64th note have no engraved form; MIDI and audio are unaffected.
const message = 'Duration not representable';
export const blocksCompile = warning => !String(warning).includes(message);
