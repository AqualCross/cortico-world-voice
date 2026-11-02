import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { BasicMIDI, SoundBankLoader, SpessaLog, SpessaSynthProcessor, SpessaSynthSequencer, audioToWav } from 'spessasynth_core';

SpessaLog.setLogLevel(false, false, false);
try {
  const font = await readFile(workerData.soundfont);
  const midi = new Uint8Array(workerData.midi);
  const song = BasicMIDI.fromArrayBuffer(midi.buffer);
  const bank = SoundBankLoader.fromArrayBuffer(font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength));
  const sampleRate = 44100;
  const synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false });
  synth.soundBankManager.addSoundBank(bank, 'main');
  await synth.processorInitialized;
  synth.setSystemParameter('autoAllocateVoices', true);
  const seq = new SpessaSynthSequencer(synth);
  seq.skipToFirstNoteOn = false;
  seq.loopCount = 0;
  seq.loadNewSongList([song]);
  seq.play();
  const count = Math.ceil(sampleRate * (song.duration + 3));
  const left = new Float32Array(count), right = new Float32Array(count);
  for (let offset = 0; offset < count; offset += 128) {
    seq.processTick();
    synth.process(left, right, offset, Math.min(128, count - offset));
  }
  let peak = 0;
  for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  if (!Number.isFinite(peak) || peak < 1e-7) throw new Error('音源输出为空或无效。');
  // A fixed gain preserves dynamics across works; only turn down to prevent clipping.
  const gain = Math.min(2.5, 0.95 / peak);
  const fadeStart = count - Math.floor(sampleRate * 0.04);
  for (let i = 0; i < count; i++) {
    const fade = i >= fadeStart ? (count - 1 - i) / (count - fadeStart) : 1;
    left[i] *= gain * fade; right[i] *= gain * fade;
  }
  const wav = audioToWav([left, right], sampleRate);
  parentPort.postMessage({ wav, seconds: count / sampleRate, peak: peak * gain, sampleRate }, [wav]);
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
