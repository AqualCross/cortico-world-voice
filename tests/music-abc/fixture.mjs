import { writeFileSync } from 'node:fs';
import { BasicSoundBank, BasicPreset, BasicInstrument, EmptySample, Generator, GeneratorTypes, SpessaLog } from 'spessasynth_core';

SpessaLog.setLogLevel(false, false, false);
export function testBank(path, { name = 'Test tones', harmonic = 1 } = {}) {
  const bank = new BasicSoundBank(); bank.soundBankInfo.name = name;
  for (const [program, bankMSB, isGMGSDrum] of [[0, 0, false], [24, 0, false], [40, 0, false], [0, 8, false], [0, 0, true]]) {
    const sample = new EmptySample(); sample.name = 'Sine'; sample.originalKey = 60; sample.loopEnd = 256;
    const multiple = harmonic + (bankMSB ? 1 : 0) + (isGMGSDrum ? 2 : 0);
    sample.setAudioData(Float32Array.from({ length: 256 }, (_, i) => Math.sin(i / 256 * Math.PI * 2 * multiple) * .5), 44100);
    bank.addSamples(sample);
    const instrument = new BasicInstrument(); instrument.name = 'Test tone';
    instrument.globalZone.addGenerators(new Generator(GeneratorTypes.sampleModes, 1), new Generator(GeneratorTypes.releaseVolEnv, -3000));
    instrument.createZone(sample); bank.addInstruments(instrument);
    const preset = new BasicPreset(bank); Object.assign(preset, { name: `Tone ${program}${bankMSB ? ' variant' : ''}${isGMGSDrum ? ' drums' : ''}`, program, bankMSB, bankLSB: 0, isGMGSDrum });
    preset.createZone(instrument); bank.addPresets(preset);
  }
  bank.flush(); const bytes = Buffer.from(bank.writeSF2()); writeFileSync(path, bytes); return bytes;
}
