/**
 * FireRed AED：对切出来的一整块音频做「说话 / 唱歌 / 音乐」三分类（非流式）。
 *
 * 与 FireRed VAD 共用同一个 `cmvn.ark` 与同一套 kaldi fbank；模型
 * `fireredvad_aed.onnx` 约 2.4 MB。只在块落盘后跑一次，不进实时断句链路。
 * 判定门限取自官方 inference_aed.sh：人声帧占比低于 0.1 的整块按音乐算。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KaldiFbank, applyCmvn, cmvnFromMatrix, parseCmvnMatrix, type Cmvn } from './fbank.ts';
import { FIRERED_SESSION_OPTIONS, loadOnnxRuntime, type OrtModule, type OrtSession } from './firered.ts';

export const FIRERED_AED_FILE = 'fireredvad_aed.onnx';
const AED_MIN_BYTES = 1_000_000;
const SPEECH_TH = 0.4;
const SINGING_TH = 0.5;
const MUSIC_TH = 0.5;
/** 人声帧占比低于这个数，整块按音乐处理。 */
const VOICE_FLOOR = 0.1;

/** 给人看的中文标签（记录与事件里用）。 */
export const AED_LABELS = Object.freeze({ speech: '说话', singing: '唱歌', music: '音乐' });

export type AedLabel = 'speech' | 'singing' | 'music';

export interface AedResult {
  label: AedLabel;
  speech: number;
  singing: number;
  music: number;
  voice: number;
}

/** AED 模型在不在（与 VAD 同目录，体积下限挡半个文件）。 */
export function aedReady(dir: string): boolean {
  try {
    return statSync(join(dir, FIRERED_AED_FILE)).size >= AED_MIN_BYTES;
  } catch {
    return false;
  }
}

/** 块级三分类；模型只在第一次 `create()` 时加载。 */
export class FireRedAedClassifier {
  private constructor(
    private readonly ort: OrtModule,
    private readonly session: OrtSession,
    private readonly cmvn: Cmvn,
  ) {}

  static async create(opts: { modelPath: string; cmvnPath?: string; cmvn?: Cmvn; ort?: OrtModule; session?: OrtSession }): Promise<FireRedAedClassifier> {
    if (!opts.modelPath) throw new Error('FireRed AED 需要模型路径。');
    if (!opts.cmvnPath && !opts.cmvn) throw new Error('FireRed AED 需要 cmvn.ark。');
    const ort = opts.ort ?? loadOnnxRuntime();
    const session = opts.session ?? await ort.InferenceSession.create(opts.modelPath, FIRERED_SESSION_OPTIONS);
    const cmvn = opts.cmvn ?? cmvnFromMatrix(parseCmvnMatrix(readFileSync(opts.cmvnPath!)));
    return new FireRedAedClassifier(ort, session, cmvn);
  }

  /** @param pcm 16k 单声道 PCM16（一整块）。 */
  async classify(pcm: Int16Array): Promise<AedResult> {
    const fbank = new KaldiFbank();
    const frames: Float32Array[] = [];
    for (let i = 0; i < pcm.length; i += 320) {
      for (const frame of fbank.accept(pcm.subarray(i, i + 320))) {
        frames.push(applyCmvn(frame, this.cmvn, new Float32Array(frame.length)));
      }
    }
    if (!frames.length) return { label: 'music', speech: 0, singing: 0, music: 0, voice: 0 };
    const flat = new Float32Array(frames.length * 80);
    frames.forEach((frame, index) => {
      for (let k = 0; k < frame.length; k += 1) flat[index * 80 + k] = frame[k];
    });
    const out = await this.session.run({ feat: new this.ort.Tensor('float32', flat, [1, frames.length, 80]) });
    const probs = out.probs.data;
    let speech = 0;
    let singing = 0;
    let music = 0;
    let voice = 0;
    for (let i = 0; i < frames.length; i += 1) {
      const s = probs[i * 3];
      const g = probs[i * 3 + 1];
      const m = probs[i * 3 + 2];
      if (s >= SPEECH_TH) speech += 1;
      if (g >= SINGING_TH) singing += 1;
      if (m >= MUSIC_TH) music += 1;
      if (s >= SPEECH_TH || g >= SINGING_TH) voice += 1;
    }
    const n = frames.length;
    const ratios = { speech: speech / n, singing: singing / n, music: music / n, voice: voice / n };
    const label: AedLabel = ratios.voice < VOICE_FLOOR ? 'music' : (ratios.singing > ratios.speech ? 'singing' : 'speech');
    return {
      label,
      speech: Math.round(ratios.speech * 1000) / 1000,
      singing: Math.round(ratios.singing * 1000) / 1000,
      music: Math.round(ratios.music * 1000) / 1000,
      voice: Math.round(ratios.voice * 1000) / 1000,
    };
  }
}
