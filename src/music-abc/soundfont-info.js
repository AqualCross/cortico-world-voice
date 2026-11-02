import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { SoundBankLoader, SpessaLog } from 'spessasynth_core';

SpessaLog.setLogLevel(false, false, false);
try {
  const data = await readFile(workerData.path);
  const bank = SoundBankLoader.fromArrayBuffer(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const presets = bank.presets.map(({ name, bankMSB, bankLSB, program, isGMGSDrum, isDrum }) => ({ name, bankMSB, bankLSB, program, isGMGSDrum, isDrum }));
  if (!presets.length) throw new Error('音源没有可用的乐器预设。');
  parentPort.postMessage({ name: bank.soundBankInfo.name, presets });
} catch (error) { parentPort.postMessage({ error: error.message }); }
