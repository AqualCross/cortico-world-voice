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
  // Normalize to a high percentile so one transient does not decide the whole song;
  // a soft knee catches the few peaks above it, and a short fade removes the tail click.
  const hop = 2048, peaks = [];
  for (let i = 0; i < count; i += hop) {
    let local = 0;
    for (let k = i; k < Math.min(count, i + hop); k++) local = Math.max(local, Math.abs(left[k]), Math.abs(right[k]));
    peaks.push(local);
  }
  peaks.sort((a, b) => a - b);
  const reference = peaks[Math.floor(peaks.length * 0.995)] || 1e-6;
  const gain = Math.min(2.5, 0.8 / reference);
  const knee = 0.8, ceiling = 0.95;
  const shape = value => {
    const magnitude = Math.abs(value);
    if (magnitude <= knee) return value;
    return Math.sign(value) * (knee + (ceiling - knee) * Math.tanh((magnitude - knee) / (ceiling - knee)));
  };
  const fadeLength = Math.min(count, Math.floor(sampleRate * 0.5));
  let masteredPeak = 0, sumSq = 0;
  for (let i = 0; i < count; i++) {
    const fade = i >= count - fadeLength ? (count - 1 - i) / fadeLength : 1;
    left[i] = shape(left[i] * gain) * fade;
    right[i] = shape(right[i] * gain) * fade;
    masteredPeak = Math.max(masteredPeak, Math.abs(left[i]), Math.abs(right[i]));
    sumSq += (left[i] * left[i] + right[i] * right[i]) / 2;
  }
  const rmsDb = 10 * Math.log10(sumSq / Math.max(1, count) + 1e-12);
  const peakDb = 20 * Math.log10(Math.max(1e-12, masteredPeak));
  const wav = audioToWav([left, right], sampleRate);
  parentPort.postMessage({ wav, seconds: count / sampleRate, peak: masteredPeak, peakDb, rmsDb, sampleRate }, [wav]);
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
