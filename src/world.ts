/**
 * World 骨架与依赖管理：显卡检测、uv 识别/安装、GPT-SoVITS 项目与权重的安装任务。
 * 状态只描述可确认的事实：磁盘上有什么、命令跑出什么；不假装能力可用。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldWebUiDecl, WorldHost, WorldStreamSocket } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { RVC_PACKAGES, SING_PACKAGES, TORCH_SOURCE, WINDOWS_PREBUILT } from './catalog.ts';
import { AUDIO_CONFIG_GROUP, type AudioConfigSection } from './config.ts';
import { FIRERED_VAD_FILES, PARAFORMER_FILES, SENSEVOICE_FILES, TIER_SPECS } from './catalog.ts';
import { synthesizeCloud } from './cloud.ts';
import { GptSovitsService, gptSovitsMissing, type GptSovitsSetup } from './gpt-sovits.ts';
import { formatFromName, transcribeDashscope, transcribeDashscopeAsync, transcribeOpenai } from './stt.ts';
import { ClipsStore, type ClipRecord } from './clips.ts';
import { TranscriptsStore } from './transcripts.ts';
import { audioPath, migrateLayout } from './storage.ts';
import { importLegacyRecords } from './import-legacy.ts';
import { encodeWav, wavSeconds } from './wav.ts';
import { TimbreStore } from './timbre.ts';
import { bankDir, listBanks } from './banks.ts';
import { RvcVoices } from './rvc-voices.ts';
import { RvcEngine, type RvcState } from './rvc.ts';
import { SingEngine, type SingState } from './singer.ts';
import { appInfoOf, listAudioApps, windowTitleOf, type AudioApp } from './apps.ts';
import { runChain } from './prepare.ts';
import { readLanes, removeLane, setLane, writeLanes } from './lanes.ts';
import { captureModuleStatus } from './capture.ts';
import { ListenEngine, type HeardChunk } from './listen.ts';
import { sileroModelUsable } from './vad.ts';
import { paraformerReady } from './stream-asr.ts';
import { FIRERED_AED_FILE, FireRedAedClassifier, aedReady } from './firered-aed.ts';
import { FIRERED_CMVN_FILE } from './firered.ts';
import { detectGpu, type GpuReport, type Tier } from './gpu.ts';
import { weightsDir, GptSovitsProjectJob, GptSovitsWeightsJob, ModelFilesJob, ProjectEnvJob, RvcAssetsJob, RvcProjectJob, SingerModelsJob, STT_PACKAGES, UvPackagesJob, VadJob, asrEnvDir, fireRedModelDir, isRvcProjectDir, rvcAssetsDir, rvcProjectDir, singEnvDir, singerDir, sttDir, vadDir, type InstallRoots } from './install.ts';
import { Job, type JobState } from './jobs.ts';
import { decodeMono16k } from './decode.ts';
import { LocalAsr } from './local-asr.ts';
import { parsedFromFields, senseVoiceNote } from './sensevoice-tags.ts';
import { envPython, projectPython } from './project-env.ts';
import { detectFfmpeg, installFfmpeg, probeFfmpeg, type FfmpegInfo } from './ffmpeg.ts';
import { PcmOutput, loadAudify } from './audio-out.ts';
import { playFile, playFileStream } from './play.ts';
import { ToolTextStore } from './tool-text.ts';
import { PlayQueue } from './queue.ts';
import { SubtitleOverlay, type SubtitleStyle } from './subtitle.ts';
import { detectUv, installUv, probeUv, type UvInfo } from './uv.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 切分方式的人读名字（工具回执用）。 */
function vadLabel(kind: string): string {
  if (kind === 'energy') return '能量门限';
  if (kind === 'silero') return 'Silero VAD';
  if (kind === 'firered') return 'FireRed VAD';
  if (kind === 'stream') return '流式转文本';
  return kind || '跟随默认';
}

/** 六项能力；值为 true 表示已接入并可调用。 */
export interface CapabilityState {
  listen: boolean;
  transcribe: boolean;
  speak: boolean;
  sing: boolean;
  convert: boolean;
  play: boolean;
}

const NOTHING_WIRED: CapabilityState = {
  listen: false,
  transcribe: false,
  speak: false,
  sing: false,
  convert: false,
  play: true,
};

const CAPABILITY_LABELS: ReadonlyArray<[keyof CapabilityState, string]> = [
  ['listen', '本机声音监听'],
  ['transcribe', '语音转文本'],
  ['speak', '文本转语音'],
  ['sing', '歌声合成'],
  ['convert', '音色转换'],
  ['play', '音频播放'],
];

/** 记录页三栏；同一套动作按这一栏名分派。 */
export type RecordsKind = 'transcripts' | 'clips';

function recordKind(value: unknown): RecordsKind {
  const kind = String(value ?? '');
  if (kind !== 'transcripts' && kind !== 'clips') throw new Error(`未知记录类型：${kind || '（空）'}`);
  return kind;
}

/** uv 装在哪里：本 World 自己的数据目录 `audio/uv`，随 World 删除，不碰系统 PATH。 */
export function uvDir(dataDir: string): string {
  return audioPath(dataDir, 'uv');
}

/** 依赖页的一份快照。 */
export interface DepsState {
  gpu: GpuReport;
  tier: Tier;
  uv: UvInfo;
  uvJob: JobState;
  ffmpeg: FfmpegInfo;
  ffmpegJob: JobState;
  project: JobState & { dir: string };
  weights: JobState & { dir: string; bytes: number };
  env: { gpt: JobState & { dir: string }; rvc: JobState & { dir: string }; stt: JobState & { dir: string }; sing: JobState & { dir: string } };
  rvc: {
    project: JobState & { dir: string };
    assets: JobState & { dir: string; bytes: number };
  };
  singer: { models: JobState & { dir: string } };
  vad: {
    silero: JobState & { dir: string };
    firered: JobState & { dir: string; bytes: number };
  };
  stt: {
    sensevoice: JobState & { dir: string; bytes: number };
    paraformer: JobState & { dir: string; bytes: number };
  };
}

export interface AudioWorldOptions {
  /** `worlds.audio` 的活引用。 */
  cfg: AudioConfigSection;
  timezone: string;
  dataDir: string;
  /** 部署目录与 bot 代码包目录；工具说明的覆盖写在部署的 worlds/<id>/ 下。 */
  botDir: string;
  packageDir: string;
  /** 运行时根与模型根（框架的 `<部署根>/runtimes`、`<部署根>/models`）。 */
  runtimesRoot: () => string;
  modelsRoot: () => string;
  /** 写回 `worlds.audio` 配置。 */
  persist: (patch: unknown) => void;
  /** 部署 .env 里的密钥：读与写。 */
  secret: (name: string) => string;
  storeSecret: (name: string, value: string) => void;
}

/** 后台待合成的一句话。 */
interface SpeakJob {
  id: string;
  text: string;
  voice?: string;
  instruction?: string;
  /** 只合成不播放；完成时推 audio.say_done 带回路径。 */
  silent?: boolean;
}

/** 全部工具的声明；定义里的 describe 与 `tools()` 都取它。 */
export const AUDIO_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'audio_status',
    description: 'Report which audio capabilities are wired up right now (listen, transcribe, speak, sing, convert, play). Call it before promising any audio output when you are unsure.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'audio_play',
    description: 'Play an audio file now (a local path, or a log:/mem: blob handle); later requests queue up behind it. Returns the queue id and position — playback finishes in the background, so do not wait for it.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute path to the audio file; give this or handle.' },
        handle: { type: 'string', description: 'A log:/mem: blob handle for the audio; give this or path.' },
        volume: { type: 'number', minimum: 0, maximum: 100, description: 'Volume for this item; defaults to the configured volume.' },
      },
    },
  },
  {
    name: 'audio_say',
    description: 'Say a line with the configured speech engine and play it through the audio queue. Returns at once: synthesis and playback run in the background, and only a failure comes back as an audio.say_failed event. With silent=true it synthesizes in the background without playback and the file path comes back as an audio.say_done event.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The line to say.', maxLength: 2000 },
        voice: { type: 'string', description: 'Optional voice for this line; empty uses the configured one.' },
        silent: { type: 'boolean', description: 'Synthesize only; do not play.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'audio_convert',
    description: 'Convert an audio file (a local path, or a log:/mem: blob handle) into the configured RVC voice and play the result through the audio queue. Returns at once: conversion runs in the background, the result lands in the speech records, and only a failure comes back as an audio.convert_failed event.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute path to the audio file to convert; give this or handle.' },
        handle: { type: 'string', description: 'A log:/mem: blob handle for the audio; give this or path.' },
        voice: { type: 'string', description: 'Optional voice file name (the .pth in the voice folder); empty uses the configured one.' },
        silent: { type: 'boolean', description: 'Convert only; do not play. The path and an audio blob handle come back as an audio.convert_done event.' },
      },
    },
  },
  {
    name: 'audio_sing',
    description: 'Sing the given lyrics with the configured DiffSinger voicebank and play the song through the audio queue. Returns at once: synthesis runs in the background, the result lands in the speech records, and only a failure comes back as an audio.sing_failed event.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lyrics: { type: 'string', description: 'Lyrics to sing; Chinese characters. Punctuation only splits phrases.', maxLength: 2000 },
        silent: { type: 'boolean', description: 'Sing only; do not play. The path and an audio blob handle come back as an audio.sing_done event.' },
      },
      required: ['lyrics'],
    },
  },
  {
    name: 'audio_transcribe',
    description: 'Transcribe an audio file (a local path, or a log:/mem: blob handle) with the configured speech-to-text engine. Returns at once: transcription runs in the background, the text lands in the transcript records and comes back as an audio.transcribed event; a failure comes back as audio.transcribe_failed.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute path to the audio file; give this or handle.' },
        handle: { type: 'string', description: 'A log:/mem: blob handle for the audio; give this or path.' },
      },
    },
  },
  {
    name: 'audio_listen',
    description: 'Start, stop or inspect hearing: system audio, the microphone, or one application. Lanes split audio by voice activity and transcribe each chunk, or — when a lane is set to streaming — transcribe live and cut sentences by the engine endpoints. Transcribed sentences land in the transcript records (no audio files are kept). With the delivery setting on notify, each audio.heard is pushed with trigger=debounce, so the core batches close sentences into one wake-up (window and batch limits come from the framework batching settings).',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start, stop or status.' },
        source: { type: 'string', description: 'system, mic, or an application process name / PID. Omit to start or stop every configured lane.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'audio_queue',
    description: 'Inspect or change the playback queue: list it, skip the current item, remove one queued item by id, or stop and clear everything.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        act: { type: 'string', enum: ['list', 'skip', 'remove', 'clear'], description: 'list, skip, remove or clear.' },
        id: { type: 'string', description: 'Queue id to remove (only for act=remove).' },
      },
      required: ['act'],
    },
  },
];

/** 按名字取工具声明；工具顺序变了不用跟着改下标。 */
function decl(name: string): Omit<ToolDef, 'handler'> {
  const found = AUDIO_TOOL_DECLS.find((item) => item.name === name);
  if (!found) throw new Error(`工具声明缺 ${name}`);
  return found;
}

/** 工具页卡片上一句话，按语言取。 */
const TOOL_SUMMARIES: Readonly<Record<string, { zh: string; en: string }>> = {
  audio_status: { zh: '报告语音能力此刻的接入状态。', en: 'Reports which audio capabilities are wired up right now.' },
  audio_listen: { zh: '开始、停止或查看本机声音监听。', en: 'Starts, stops or inspects hearing.' },
  audio_play: { zh: '播放一个音频文件，后面的排队。', en: 'Plays an audio file; later requests queue up.' },
  audio_say: { zh: '按当前引擎合成一句话并播放。', en: 'Synthesizes a line with the current engine and plays it.' },
  audio_convert: { zh: '把一段音频换成当前变声音色，转完自动播放。', en: 'Converts an audio file into the configured voice and plays it.' },
  audio_sing: { zh: '用 DiffSinger 把歌词唱出来并播放。', en: 'Sings lyrics with DiffSinger and plays the song.' },
  audio_transcribe: { zh: '转写一个音频文件，完成后以事件带回文字。', en: 'Transcribes an audio file in the background; the text arrives as an event.' },
  audio_queue: { zh: '查看或改动播放队列。', en: 'Inspect or change the playback queue.' },
};

/** uv 的安装任务；识别到本机已有 uv 时 present() 直接为真。 */
class UvJob extends Job {
  constructor(private readonly dir: () => string, private readonly probe: () => Promise<UvInfo>) {
    super();
  }

  protected present(): boolean {
    return existsSync(join(this.dir(), 'uv.exe'));
  }

  protected async work(signal: AbortSignal): Promise<void> {
    this.state.detail = '下载 uv';
    const info = await installUv(this.dir(), signal, (n) => { this.state.done += n; });
    this.state.detail = `uv ${info.version}`;
    await this.probe();
  }
}

/** ffmpeg 的安装任务；识别到本机已有 ffmpeg 时不需要执行它。 */
class FfmpegJob extends Job {
  constructor(private readonly dir: () => string, private readonly probe: () => Promise<FfmpegInfo>) {
    super();
  }

  protected present(): boolean {
    return existsSync(join(this.dir(), 'ffmpeg.exe'));
  }

  protected async work(signal: AbortSignal): Promise<void> {
    this.state.detail = '下载 ffmpeg';
    const info = await installFfmpeg(this.dir(), signal, (n) => { this.state.done += n; });
    this.state.detail = `ffmpeg ${info.version}`;
    await this.probe();
  }
}

export class AudioWorld implements World {
  readonly id = 'audio';

  private readonly roots: InstallRoots;
  private readonly project: GptSovitsProjectJob;
  private readonly weights: GptSovitsWeightsJob;
  private readonly rvcProject: RvcProjectJob;
  private readonly rvcAssets: RvcAssetsJob;
  private readonly singerModels: SingerModelsJob;
  private readonly vadJob: VadJob;
  private readonly fireredModels: ModelFilesJob;
  private readonly gptEnvJob: ProjectEnvJob;
  private readonly rvcEnvJob: ProjectEnvJob;
  private readonly singEnvJob: UvPackagesJob;
  private readonly sensevoiceJob: ModelFilesJob;
  private readonly paraformerJob: ModelFilesJob;
  private readonly sensevoiceEnvJob: UvPackagesJob;
  private readonly uvJob: UvJob;
  private readonly ffmpegJob: FfmpegJob;
  private readonly toolText: ToolTextStore;
  private readonly transcripts: TranscriptsStore;
  private readonly clips: ClipsStore;
  private readonly lanesFile: string;
  private readonly timbre: TimbreStore;
  private readonly rvcVoices: RvcVoices;
  private readonly queue: PlayQueue;
  /** 桌面字幕层：常驻一条 PowerShell 的透明置顶窗，跟着播放队列显示当前这句。 */
  private readonly subtitle = new SubtitleOverlay();
  /** 本机声音监听：车道、切分、切块入库与自动转写。 */
  private readonly hearing: ListenEngine;
  /** 听页的电平推送连接；与 100ms 的推送定时器一起管。 */
  private readonly levelSockets = new Set<WorldStreamSocket>();
  private levelTimer: NodeJS.Timeout | null = null;
  /** 块级细分（FireRed AED）的会话；模型目录不变就复用。 */
  private aed: { key: string; ready: Promise<FireRedAedClassifier> } | null = null;
  /** 后台合成：audio_say 立刻回执，一条一条按提交顺序做，好了进播放队列。 */
  private readonly speakJobs: SpeakJob[] = [];
  private speakBusy = false;
  private speakSeq = 0;
  /** World 停一次加一，用来丢掉停止之前提交、还在合成的那些。 */
  private speakGen = 0;
  private host: WorldHost | null = null;
  private output: PcmOutput | null = null;
  /** 本机识别子进程；模型目录变了就换一个。 */
  private asr: { modelDir: string; client: LocalAsr } | null = null;
  /** 本机 GPT-SoVITS 服务；档位或项目变了就重开。 */
  private sovits: GptSovitsService | null = null;
  private sovitsKey = '';
  /** 变声引擎：常驻子进程，空闲退出；项目、档位或 ffmpeg 变了就换一个。 */
  private rvcCache: { key: string; engine: RvcEngine } | null = null;
  /** 变声一条接一条地做，别让两条请求抢同一个 worker。 */
  private convertChain: Promise<unknown> = Promise.resolve();
  private convertSeq = 0;
  /** 最近一次变声的结果；变声页那一行显示它。 */
  private rvcLast: { voice: string; seconds: number | null; ms: number; path: string; at: string } | null = null;
  /** 唱歌引擎：第一次唱才起，空闲退出；换声库就换进程。 */
  private singCache: { key: string; engine: SingEngine } | null = null;
  /** 一首接一首地唱。 */
  private singChain: Promise<unknown> = Promise.resolve();
  /** 转写一条接一条地跑，结果以事件带回。 */
  private transcribeChain: Promise<unknown> = Promise.resolve();
  private transcribeSeq = 0;
  /** 入参句柄落临时文件时用的序号。 */
  private handleSeq = 0;
  private singSeq = 0;
  /** 最近一次唱歌的结果；唱歌页那一行显示它。 */
  private singLast: { voice: string; seconds: number | null; ms: number; path: string; at: string } | null = null;
  private gpuCache: { at: number; report: GpuReport } | null = null;
  private uvCache: { at: number; info: UvInfo } | null = null;
  private ffmpegCache: { at: number; info: FfmpegInfo } | null = null;

  constructor(private readonly opts: AudioWorldOptions) {
    this.roots = { runtimesRoot: opts.runtimesRoot, modelsRoot: opts.modelsRoot };
    this.project = new GptSovitsProjectJob(this.roots);
    this.weights = new GptSovitsWeightsJob(this.roots, () => this.tier());
    this.rvcProject = new RvcProjectJob(this.roots);
    this.rvcAssets = new RvcAssetsJob(this.roots);
    this.singerModels = new SingerModelsJob(this.roots);
    this.vadJob = new VadJob(this.roots);
    this.fireredModels = new ModelFilesJob(() => fireRedModelDir(this.roots), () => FIRERED_VAD_FILES);
    this.gptEnvJob = new ProjectEnvJob({
      dir: () => this.project.dir(),
      uv: async () => (await this.uvInfo()).path ?? '',
      torch: () => TORCH_SOURCE[this.tier()],
      preinstall: () => WINDOWS_PREBUILT,
    });
    this.singEnvJob = new UvPackagesJob(() => singEnvDir(this.roots), async () => (await this.uvInfo()).path ?? '', SING_PACKAGES);
    this.rvcEnvJob = new ProjectEnvJob({
      dir: () => this.rvcProject.dir(),
      uv: async () => (await this.uvInfo()).path ?? '',
      torch: () => TORCH_SOURCE[this.tier()],
      packages: () => RVC_PACKAGES,
    });
    this.sensevoiceJob = new ModelFilesJob(() => sttDir(this.roots, 'sensevoice'), () => SENSEVOICE_FILES);
    this.paraformerJob = new ModelFilesJob(() => sttDir(this.roots, 'paraformer'), () => PARAFORMER_FILES);
    this.sensevoiceEnvJob = new UvPackagesJob(() => asrEnvDir(this.roots), async () => (await this.uvInfo()).path ?? '', STT_PACKAGES);
    this.uvJob = new UvJob(() => uvDir(this.opts.dataDir), () => this.uvInfo());
    this.ffmpegJob = new FfmpegJob(() => audioPath(this.opts.dataDir, 'ffmpeg'), () => this.ffmpegInfo());
    this.queue = new PlayQueue((o) => this.playAny(o), () => this.opts.cfg.volume, {
      onStart: (item) => this.subtitle.show(item.text, item.seconds, this.subtitleStyle()),
      onEnd: () => this.subtitle.hide(),
    });
    this.toolText = new ToolTextStore(AUDIO_TOOL_DECLS, { botDir: opts.botDir, packageDir: opts.packageDir, id: this.id });
    // 记录里的时间统一写本地墙钟串（带偏移），面板按位置切片就能直接显示。
    const clock = (): string => nowIso(opts.timezone);
    this.transcripts = new TranscriptsStore(audioPath(opts.dataDir, 'transcripts'), 200, clock);
    this.clips = new ClipsStore(audioPath(opts.dataDir, 'out'), 200, clock);
    this.lanesFile = audioPath(opts.dataDir, 'lanes.json');
    this.hearing = new ListenEngine({
      lanesFile: this.lanesFile,
      cfg: () => this.opts.cfg,
      sileroModel: () => join(vadDir(this.roots), 'silero_vad.onnx'),
      streamModel: () => sttDir(this.roots, 'paraformer'),
      fireRedDir: () => fireRedModelDir(this.roots),
      log: {
        info: (message, meta) => this.host?.log.info(message, meta),
        warn: (message, meta) => this.host?.log.warn(message, meta),
        debug: (message, meta) => this.host?.log.debug(message, meta),
      },
      transcribe: (pcm) => this.transcribeHeard(pcm),
      classify: (pcm) => this.classifyChunk(pcm),
      ship: (chunk, text, info) => this.shipHeard(chunk, text, info),
      titleOf: (pid) => windowTitleOf(pid),
      busy: () => Boolean(this.queue.snapshot().current),
      clock,
    });
    this.timbre = new TimbreStore(audioPath(opts.dataDir, 'timbre'));
    this.rvcVoices = new RvcVoices(audioPath(opts.dataDir, 'rvc'));
  }

  /** 此刻的接入状态；引擎接入时在这里改。 */
  capabilities(): CapabilityState {
    const cfg = this.opts.cfg;
    const speakKey = cfg.speak.engine === 'dashscope' ? cfg.speak.dashscope.apiKeySecret : cfg.speak.openai.apiKeySecret;
    const sttKey = cfg.stt.engine === 'openai' ? cfg.stt.openai.apiKeySecret : cfg.stt.dashscope.apiKeySecret;
    const cloudSpeak = cfg.speak.engine !== 'gpt-sovits' && !!this.opts.secret(speakKey).trim();
    const cloudStt = cfg.stt.engine !== 'sensevoice' && cfg.stt.engine !== 'moonshine' && !!this.opts.secret(sttKey).trim();
    const localStt = cfg.stt.engine === 'sensevoice' && existsSync(envPython(asrEnvDir(this.roots))) && existsSync(join(this.sensevoiceModelDir(), 'model.int8.onnx'));
    const localSpeak = cfg.speak.engine === 'gpt-sovits' && !!cfg.speak.gptSovits.refAudio.trim() && gptSovitsMissing(this.sovitsSetup()).length === 0;
    return { ...NOTHING_WIRED, listen: captureModuleStatus().ok, speak: cloudSpeak || localSpeak, convert: this.rvcReady(), sing: this.singReady(), transcribe: cloudStt || localStt };
  }

  /** 本机 GPT-SoVITS 的启动参数：项目、权重、设备与卡号。 */
  private sovitsSetup(): GptSovitsSetup {
    const tier = this.tier();
    const spec = TIER_SPECS[tier];
    const projectDir = this.project.dir();
    return {
      projectDir,
      modelsDir: weightsDir(this.roots),
      python: projectPython(projectDir),
      device: tier,
      gpuIndex: Number(/^gpu(\d+)$/.exec(this.opts.cfg.speak.gptSovits.tier)?.[1] ?? '0'),
      version: spec.version,
      t2sWeights: spec.t2sWeights,
      vitsWeights: spec.vitsWeights,
    };
  }

  private sovitsService(): GptSovitsService {
    const setup = this.sovitsSetup();
    const key = `${setup.projectDir}|${setup.device}|${setup.gpuIndex}|${setup.version}`;
    if (this.sovits && this.sovitsKey === key) return this.sovits;
    void this.sovits?.stop();
    this.sovits = new GptSovitsService(setup);
    this.sovitsKey = key;
    return this.sovits;
  }

  /** SenseVoice 模型目录：配置里填了就用它，否则用依赖页装的那份。 */
  private sensevoiceModelDir(): string {
    return this.opts.cfg.stt.sensevoice.modelDir.trim() || sttDir(this.roots, 'sensevoice');
  }

  /** 常驻的识别子进程；模型目录变了就换一个。 */
  private localAsr(): LocalAsr {
    const modelDir = this.sensevoiceModelDir();
    if (this.asr?.modelDir === modelDir) return this.asr.client;
    this.asr?.client.dispose();
    const client = new LocalAsr({
      command: envPython(asrEnvDir(this.roots)),
      args: [fileURLToPath(new URL('../python/sensevoice_asr.py', import.meta.url)), modelDir, '2'],
    });
    this.asr = { modelDir, client };
    return client;
  }

  /** 环境模板里没有占位符；接入后按需报值。 */
  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    const handlers: Array<ToolDef['handler']> = [
      this.statusTool().handler!,
      this.playTool().handler!,
      this.sayTool().handler!,
      this.convertTool().handler!,
      this.singTool().handler!,
      this.transcribeTool().handler!,
      this.listenTool().handler!,
      this.queueTool().handler!,
    ];
    return this.toolText.resolve().map((tool, index) => ({ ...tool, handler: handlers[index] }));
  }

  /** 导航上的状态灯：四项能力各自可确认的状态 + 「在听 N 路」徽章；不做技术细节展示。 */
  webUi(language?: string): WorldWebUiDecl {
    const en = Boolean(language?.toLowerCase().startsWith('en'));
    const views = this.hearing.views();
    const up = views.filter((lane) => lane.listening);
    const bad = views.find((lane) => lane.error);
    const module = this.hearing.module();
    const listenLamp = module.ok && !bad
      ? { state: up.length ? 'online' : 'offline', hint: up.length ? `${up.length} 路在听` : '没有勾选的来源' }
      : { state: bad || !module.ok ? 'error' : 'offline', hint: bad?.error || module.error };
    const speak = this.capabilities().speak;
    const speakHint = speak
      ? (this.opts.cfg.speak.engine === 'gpt-sovits' ? '本机 GPT-SoVITS 就绪' : '已填密钥')
      : this.opts.cfg.speak.engine === 'gpt-sovits'
        ? (gptSovitsMissing(this.sovitsSetup()).length ? `还缺 ${gptSovitsMissing(this.sovitsSetup()).join('、')}` : '还没选参考音频')
        : '还没填密钥';
    const rvc = this.rvcRuntime();
    const sing = this.singRuntime();
    return {
      lamps: [
        { label: en ? 'Listen' : '听', state: listenLamp.state as 'online' | 'error' | 'offline', hint: String(listenLamp.hint ?? '') },
        { label: en ? 'Speech' : '说话', state: speak ? 'online' : 'offline', hint: speakHint },
        { label: en ? 'Convert' : '变声', state: rvc.ready ? 'online' : 'offline', hint: rvc.ready ? `音色 ${rvc.voice.replace(/\.pth$/i, '')}` : (rvc.missing.length ? `还缺 ${rvc.missing.join('、')}` : '还没选音色') },
        { label: en ? 'Sing' : '唱歌', state: sing.ready ? 'online' : 'offline', hint: sing.ready ? `声库 ${this.bankLabel(sing.bank)}` : `还缺 ${sing.missing.join('、')}` },
      ],
      badges: up.length ? [{ label: en ? 'live' : '在听', value: up.length, tone: 'on' as const }] : [],
      panels: [
        {
          id: 'deps',
          title: '依赖',
          description: '显卡检测、uv 与本机 GPT-SoVITS 的源码与权重。',
          getMethods: ['state'],
        },
        {
          id: 'speak',
          title: '说话',
          description: '说话、变声、唱歌、播放、记录五个页签；引擎不同，用到的配置项也不同。',
          getMethods: ['state'],
        },
        {
          id: 'listen',
          title: '听',
          description: '监听哪路声音、怎么切分、转文本用哪个引擎，以及转写记录。',
          getMethods: ['state'],
        },
        {
          id: 'tools',
          title: '工具',
          getMethods: ['list'],
        },
      ],
      promptDocs: [
        {
          key: 'worlds.audio.envPrompt',
          title: '提示词',
          description: '',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      stream: (panel, socket) => this.streamPanel(panel, socket),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    for (const note of migrateLayout(this.opts.dataDir)) {
      host.log.warn('声音：旧数据没能搬进 audio/', { err: note });
    }
    try {
      const report = importLegacyRecords(this.opts.dataDir, {
        transcripts: this.transcripts,
        clips: this.clips,
      });
      const total = report.stt + report.tts;
      if (!report.skipped && total) host.log.info(`声音：并进旧 World 的记录 ${total} 条`);
    } catch (err) {
      host.log.warn('声音：旧 World 的记录没能并进来', { err });
    }
    // 挂载时先探一次显卡：档位与权重都按它解析，别等第一次说话才发现还没检测过。
    void this.gpu();
    this.hearing.start();
    await host.pushEvent({
      type: 'audio.started',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'external',
      senderKey: this.id,
      text: '声音 World 已挂载；按勾选的来源在听，audio_status 报告当前状态。',
    });
  }

  async stop(): Promise<void> {
    this.speakGen += 1;
    this.speakJobs.length = 0;
    this.hearing.dispose();
    this.stopLevelPush();
    this.host = null;
    await this.queue.dispose();
    this.subtitle.dispose();
    this.asr?.client.dispose();
    this.asr = null;
    await this.sovits?.stop();
    this.sovits = null;
    this.rvcCache?.engine.dispose();
    this.rvcCache = null;
    this.singCache?.engine.dispose();
    this.singCache = null;
    this.output?.close();
    this.output = null;
  }

  /** 有 audify + ffmpeg 时走常驻输出（边解边放），否则退回 PowerShell 播放。 */
  private async playAny(opts: { path: string; volume: number; signal: AbortSignal }): Promise<void> {
    const audify = loadAudify();
    const ffmpeg = (await this.ffmpegInfo()).path;
    if (audify && ffmpeg && ffmpeg !== 'ffmpeg') {
      const output = this.output ??= new PcmOutput(audify, () => 100);
      const onAbort = (): void => output.cut();
      opts.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await playFileStream({ ...opts, ffmpeg, output });
        return;
      } finally {
        opts.signal.removeEventListener('abort', onAbort);
      }
    }
    await playFile(opts);
  }

  /** 面板与工具共用的数据面。 */
  async invoke(panel: string, method: string, args: unknown[] = []): Promise<unknown> {
    // 三个面板的控件都走这里写配置，和框架的配置页是同一份值。
    if (method === 'setConfigValue') return this.saveConfigValue(String(args[0] ?? ''), args[1]);
    if (panel === 'speak') {
      if (method === 'state') return this.speakState();
      // 二级页签：「播放」与「记录（语音）」的调用都从这里进来。
      if (method === 'queue') {
        const [act, ...rest] = args as string[];
        return this.queueInvoke(act, rest);
      }
      if (method === 'clips') {
        const [act, ...rest] = args as string[];
        return this.recordsInvoke(act, ['clips', ...rest]);
      }
      if (method === 'useTimbre') {
        const file = String(args[0] ?? '').trim();
        if (file) this.selectTimbre(file);
        else this.opts.persist({ speak: { gptSovits: { refAudio: '', refText: '' } } } as never);
        return this.speakState();
      }
      if (method === 'importTimbreFromPath') {
        const source = String(args[0] ?? '').trim();
        if (!source) throw new Error('没有选到文件。');
        const item = this.timbre.importFile(source);
        this.selectTimbre(item.file);
        return this.speakState();
      }
      if (method === 'importTimbreBytes') {
        const name = String(args[0] ?? '').trim();
        const base64 = String(args[1] ?? '');
        const item = this.timbre.importBytes(name || 'timbre.wav', Buffer.from(base64, 'base64'));
        this.selectTimbre(item.file);
        return this.speakState();
      }
      if (method === 'setTimbreText') {
        const file = String(args[0] ?? '').trim();
        const text = String(args[1] ?? '');
        if (!file) throw new Error('没有选中的参考音频。');
        this.timbre.setText(file, text);
        if (this.currentTimbreFile() === file) {
          this.opts.persist({ speak: { gptSovits: { refText: text } } } as never);
        }
        return this.speakState();
      }
      if (method === 'useRvcVoice') {
        const file = String(args[0] ?? '').trim();
        const model = file && this.rvcVoices.list().includes(file) ? this.rvcVoices.pathOf(file) : '';
        this.opts.persist({ convert: { model } } as never);
        return this.speakState();
      }
      if (method === 'importRvcVoice') {
        const source = String(args[0] ?? '').trim();
        if (!source) throw new Error('没有选到文件。');
        const file = this.rvcVoices.importFile(source);
        this.opts.persist({ convert: { model: this.rvcVoices.pathOf(file) } } as never);
        return this.speakState();
      }
      if (method === 'convert') {
        const input = String(args[0] ?? '').trim();
        if (!input) throw new Error('先选一段要变声的音频。');
        await this.convertFile(input, String(args[1] ?? '').trim() || undefined, 'ui');
        return this.speakState();
      }
      if (method === 'playLastConvert') {
        if (!this.rvcLast) throw new Error('还没有转过音。');
        if (!existsSync(this.rvcLast.path)) throw new Error('上一次变声的文件不在了。');
        this.queue.enqueue({ path: this.rvcLast.path, origin: 'ui', seconds: this.rvcLast.seconds ?? undefined });
        return this.speakState();
      }
      if (method === 'sing') {
        const lyrics = String(args[0] ?? '');
        if (!lyrics.trim()) throw new Error('先写一句歌词。');
        await this.singSong(lyrics, 'ui');
        return this.speakState();
      }
      if (method === 'playLastSing') {
        if (!this.singLast) throw new Error('还没有唱过。');
        if (!existsSync(this.singLast.path)) throw new Error('上一次唱的文件不在了。');
        this.queue.enqueue({ path: this.singLast.path, origin: 'ui', seconds: this.singLast.seconds ?? undefined });
        return this.speakState();
      }
      if (method === 'saveSecret') {
        const name = String(args[0] ?? '').trim();
        const value = String(args[1] ?? '').trim();
        if (!name) throw new Error('密钥变量名为空。');
        if (!value) throw new Error('密钥为空。');
        this.opts.storeSecret(name, value);
        return this.speakState();
      }
      throw new Error(`未知方法 speak/${method}`);
    }
    if (panel === 'listen') {
      if (method === 'state') return this.listenState();
      // 二级页签「记录（转写）」的调用。
      if (method === 'transcripts') {
        const [act, ...rest] = args as string[];
        return this.recordsInvoke(act, ['transcripts', ...rest]);
      }
      if (method === 'levels') return this.hearing.levels();
      if (method === 'start') {
        this.hearing.start();
        this.broadcastStateChange();
        return this.listenState();
      }
      if (method === 'stop') {
        this.hearing.stop();
        this.broadcastStateChange();
        return this.listenState();
      }
      if (method === 'apps') {
        const { apps, error } = await listAudioApps(true);
        // 勾过、但现在没在出声的车道也补上名字，面板那一行才不是只有 PID。
        const seen = new Set(apps.map((app) => app.id));
        const remembered = await Promise.all(readLanes(this.lanesFile)
          .filter((lane) => /^app:\d+$/.test(lane.id) && !seen.has(lane.id))
          .map(async (lane): Promise<AudioApp | null> => {
            const pid = Number(lane.id.slice(4));
            const info = await appInfoOf(pid);
            return info.name ? { id: lane.id, name: info.name, pid, title: info.title } : null;
          }));
        return { apps: [...apps, ...remembered.filter((item): item is AudioApp => item !== null)], error };
      }
      if (method === 'setLane') {
        const id = String(args[0] ?? '').trim();
        if (!id) throw new Error('要勾选哪一路？');
        const vad = String(args[1] ?? '').trim();
        writeLanes(this.lanesFile, setLane(readLanes(this.lanesFile), id, vad));
        this.hearing.sync();
        this.broadcastStateChange();
        return this.listenState();
      }
      if (method === 'removeLane') {
        const id = String(args[0] ?? '').trim();
        if (!id) throw new Error('要取消哪一路？');
        writeLanes(this.lanesFile, removeLane(readLanes(this.lanesFile), id));
        this.hearing.sync();
        this.broadcastStateChange();
        return this.listenState();
      }
      if (method === 'addApp') {
        const text = String(args[0] ?? '').trim();
        const id = await this.resolveLaneId(text);
        writeLanes(this.lanesFile, setLane(readLanes(this.lanesFile), id, ''));
        this.hearing.sync();
        this.broadcastStateChange();
        return this.listenState();
      }
      if (method === 'saveSecret') {
        const name = String(args[0] ?? '').trim();
        const value = String(args[1] ?? '').trim();
        if (!name || !value) throw new Error('密钥变量名与密钥都要填。');
        this.opts.storeSecret(name, value);
        return this.listenState();
      }
      throw new Error(`未知方法 listen/${method}`);
    }
    if (panel === 'records') return this.recordsInvoke(method, args);
    if (panel === 'tools') {
      if (method === 'list') return this.toolTextView(this.toolText.read());
      if (method === 'save') return this.toolTextView(this.toolText.save(args[0] as { expectedRevision: string; overrides: unknown }));
      if (method === 'reset') return this.toolTextView(this.toolText.reset(args[0] as { expectedRevision: string }));
      throw new Error(`未知方法 tools/${method}`);
    }
    if (panel === 'queue') return this.queueInvoke(method, args);
    if (panel !== 'deps') {
      if (method === 'status') return this.statusText();
      throw new Error(`未知面板 ${panel}`);
    }
    switch (method) {
      case 'state':
        return this.depsState();
      case 'installUv':
        void this.uvJob.install();
        return this.depsState();
      case 'installFfmpeg':
        void this.ffmpegJob.install();
        return this.depsState();
      case 'prepareGpt':
        void this.prepareGpt();
        return this.depsState();
      case 'prepareRvc':
        void this.prepare([this.rvcProject, this.rvcEnvJob, this.rvcAssets]);
        return this.depsState();
      case 'prepareSinger':
        void this.prepare([this.singerModels, this.singEnvJob]);
        return this.depsState();
      case 'prepareSilero':
        void this.prepare([this.vadJob]);
        return this.depsState();
      case 'prepareFirered':
        void this.prepare([this.fireredModels]);
        return this.depsState();
      case 'prepareSensevoice':
        void this.prepare([this.sensevoiceJob, this.sensevoiceEnvJob]);
        return this.depsState();
      case 'prepareParaformer':
        void this.prepare([this.paraformerJob]);
        return this.depsState();
      case 'cancel':
        this.uvJob.cancel();
        this.project.cancel();
        this.weights.cancel();
        this.ffmpegJob.cancel();
        this.rvcProject.cancel();
        this.rvcAssets.cancel();
        this.singerModels.cancel();
        this.vadJob.cancel();
        this.fireredModels.cancel();
        this.gptEnvJob.cancel();
        this.rvcEnvJob.cancel();
        this.sensevoiceJob.cancel();
        this.sensevoiceEnvJob.cancel();
        this.singEnvJob.cancel();
        this.paraformerJob.cancel();
        return this.depsState();
      default:
        throw new Error(`未知方法 ${panel}/${method} ${args.length ? JSON.stringify(args) : ''}`);
    }
  }

  async depsState(): Promise<DepsState> {
    const gpu = await this.gpu();
    const uv = await this.uvInfo();
    return {
      gpu,
      tier: gpu.tier,
      uv,
      uvJob: this.uvJob.status(),
      ffmpeg: await this.ffmpegInfo(),
      ffmpegJob: this.ffmpegJob.status(),
      project: { ...this.project.status(), dir: this.project.dir() },
      weights: { ...this.weights.status(), dir: this.weights.dir(), bytes: this.weights.bytes() },
      env: {
        gpt: { ...this.gptEnvJob.status(), dir: this.project.dir() },
        rvc: { ...this.rvcEnvJob.status(), dir: this.rvcProject.dir() },
        stt: { ...this.sensevoiceEnvJob.status(), dir: asrEnvDir(this.roots) },
        sing: { ...this.singEnvJob.status(), dir: singEnvDir(this.roots) },
      },
      rvc: {
        project: { ...this.rvcProject.status(), dir: rvcProjectDir(this.roots) },
        assets: { ...this.rvcAssets.status(), dir: rvcAssetsDir(this.roots), bytes: this.rvcAssets.bytes() },
      },
      singer: { models: { ...this.singerModels.status(), dir: singerDir(this.roots) } },
      vad: {
        silero: { ...this.vadJob.status(), dir: vadDir(this.roots) },
        firered: { ...this.fireredModels.status(), dir: fireRedModelDir(this.roots), bytes: this.fireredModels.bytes() },
      },
      stt: {
        sensevoice: { ...this.sensevoiceJob.status(), dir: sttDir(this.roots, 'sensevoice'), bytes: this.sensevoiceJob.bytes() },
        paraformer: { ...this.paraformerJob.status(), dir: sttDir(this.roots, 'paraformer'), bytes: this.paraformerJob.bytes() },
      },
    };
  }

  /** 一件「获取」：按顺序跑，已就绪的跳过，失败就停在那里，下次接着来。 */
  private async prepare(steps: Array<{ status(): JobState; install(): Promise<void> }>): Promise<void> {
    // 权重档位要靠显卡检测结果，先确保检测跑过。
    await this.gpu();
    await runChain(steps);
  }

  /** 本机服务从项目目录里的 .venv 起进程；不停掉就替换目录或重建环境，会卡在被占用的文件上。 */
  private async prepareGpt(): Promise<void> {
    await this.sovits?.stop();
    await this.prepare([this.project, this.gptEnvJob, this.weights]);
  }

  /** 按选定档位解析成实际要用的权重：CPU 档用 CPU 权重，指定或自动有显卡时用显卡权重。 */
  tier(): Tier {
    const choice = this.opts.cfg.speak.gptSovits.tier;
    if (choice === 'cpu') return 'cpu';
    // 明确点了某张卡就是要用显卡；别因为检测缓存没热就悄悄退回 CPU。
    if (choice !== 'auto') return 'cuda';
    return this.gpuCache?.report?.tier ?? 'cpu';
  }

  /** 显卡检测缓存 15 秒；点「重新检测」清缓存。 */
  private async gpu(): Promise<GpuReport> {
    const now = Date.now();
    if (this.gpuCache && now - this.gpuCache.at < 15_000) return this.gpuCache.report;
    const report = await detectGpu();
    this.gpuCache = { at: now, report };
    return report;
  }

  /** uv 先看本机（配置/PATH/常见位置），再看自己目录里装的那份。 */
  private async uvInfo(): Promise<UvInfo> {
    const now = Date.now();
    if (this.uvCache && now - this.uvCache.at < 15_000) return this.uvCache.info;
    const found = await detectUv(this.opts.cfg.uvPath);
    let info = found;
    if (!info.path) {
      const local = join(uvDir(this.opts.dataDir), 'uv.exe');
      if (existsSync(local)) {
        const version = await probeUv(local);
        if (version) info = { path: local, version, source: 'installed', detail: null };
      }
    }
    this.uvCache = { at: now, info };
    return info;
  }

  /** 听页：监听与转文本两组的当前值、已选的车道、运行态与密钥是否已填。应用列表另走 `apps`。 */
  private listenState(): unknown {
    const cfg = this.opts.cfg;
    const has = (name: string): boolean => !!this.opts.secret(name).trim();
    const model = join(vadDir(this.roots), 'silero_vad.onnx');
    const streamDir = sttDir(this.roots, 'paraformer');
    const fireDir = fireRedModelDir(this.roots);
    return {
      listen: cfg.listen,
      stt: cfg.stt,
      secrets: {
        dashscope: has(cfg.stt.dashscope.apiKeySecret),
        openai: has(cfg.stt.openai.apiKeySecret),
      },
      lanes: readLanes(this.lanesFile),
      runtime: {
        module: this.hearing.module(),
        listening: this.hearing.listening,
        paused: this.hearing.isPaused,
        lanes: this.hearing.views(),
        silero: { path: model, exists: sileroModelUsable(model) },
        aed: { ready: aedReady(fireDir) },
        stream: { engine: 'paraformer', dir: streamDir, ready: paraformerReady(streamDir) },
      },
    };
  }

  /** 「添加」里填的进程名 / PID → 车道 id；只接受此刻正在出声的应用。 */
  private async resolveLaneId(text: string): Promise<string> {
    if (!text) throw new Error('填个进程名或 PID。');
    const { apps, error } = await listAudioApps(true);
    if (error) throw new Error(`读不到正在出声的应用：${error}`);
    if (/^\d+$/.test(text)) {
      const byPid = apps.find((app) => app.pid === Number(text));
      if (!byPid) throw new Error(`PID ${text} 现在没在出声。`);
      return byPid.id;
    }
    const want = text.toLowerCase().replace(/\.exe$/, '');
    const byName = apps.find((app) => app.name.toLowerCase() === want);
    if (!byName) {
      const names = apps.map((app) => app.name).slice(0, 8).join('、');
      throw new Error(names ? `没找到 ${want}；现在出声的有：${names}` : `没找到 ${want}；现在没有应用在出声。`);
    }
    return byName.id;
  }

  /** 工具里的来源：system / mic / app:<PID> / PID / 进程名（进程名只认此刻在出声的）。 */
  private async laneIdOf(text: string): Promise<string> {
    const value = text.trim();
    if (value === 'system' || value === 'mic') return value;
    if (/^app:\d+$/i.test(value)) return value.toLowerCase();
    if (/^\d+$/.test(value)) return `app:${Number(value)}`;
    return this.resolveLaneId(value);
  }

  /** 块级细分：第一次用才建会话；模型不在或推理失败时抛错，引擎会退回正常转写。 */
  private async classifyChunk(pcm: Int16Array): Promise<{ label: 'speech' | 'singing' | 'music' } | null> {
    const dir = fireRedModelDir(this.roots);
    if (!aedReady(dir)) {
      throw new Error('FireRed AED 模型还没下载：去「依赖」页对「FireRed VAD」点「获取」。');
    }
    const modelPath = join(dir, FIRERED_AED_FILE);
    if (!this.aed || this.aed.key !== modelPath) {
      this.aed = {
        key: modelPath,
        ready: FireRedAedClassifier.create({ modelPath, cmvnPath: join(dir, FIRERED_CMVN_FILE) }),
      };
    }
    try {
      const classifier = await this.aed.ready;
      const result = await classifier.classify(pcm);
      return { label: result.label };
    } catch (err) {
      this.aed = null;
      throw err;
    }
  }

  /** 一块听好的声音自动转写：本机 SenseVoice 或云端引擎，和 audio_transcribe 同一套。 */
  private async transcribeHeard(pcm: Int16Array): Promise<string> {
    const cfg = this.opts.cfg;
    const engine = cfg.stt.engine;
    if (engine === 'moonshine') throw new Error('Moonshine 不能流式识别：流式来源请把切分方式选成「流式转文本」（引擎待接）；整段转写改用 SenseVoice 或云端引擎。');
    if (engine === 'sensevoice') {
      if (!existsSync(envPython(asrEnvDir(this.roots))) || !existsSync(join(this.sensevoiceModelDir(), 'model.int8.onnx'))) {
        throw new Error('本机识别还没装好：先去「依赖」页对 SenseVoice 点「获取」。');
      }
      const result = await this.localAsr().transcribe(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      const parsed = parsedFromFields(result);
      const note = senseVoiceNote(parsed);
      return note ? `${parsed.text}（${note}）` : parsed.text;
    }
    const name = engine === 'openai' ? cfg.stt.openai.apiKeySecret : cfg.stt.dashscope.apiKeySecret;
    const apiKey = this.opts.secret(name).trim();
    if (!apiKey) throw new Error(`还没有填密钥：在「听」页把 ${name} 写上。`);
    const bytes = encodeWav(pcm, 16_000);
    if (engine === 'dashscope') {
      return transcribeDashscope({
        baseUrl: cfg.stt.dashscope.baseUrl,
        apiKey,
        model: cfg.stt.dashscope.model,
        bytes,
        format: 'wav',
        langHint: cfg.stt.langHint,
        context: cfg.stt.context,
        itn: cfg.stt.dashscope.itn,
        keepDialect: cfg.stt.dashscope.keepDialect,
        sampleRate: cfg.stt.sampleRate,
      });
    }
    if (engine === 'dashscope-async') {
      return transcribeDashscopeAsync({
        baseUrl: cfg.stt.dashscope.baseUrl,
        apiKey,
        model: cfg.stt.dashscope.model,
        bytes,
        name: 'heard.wav',
        format: 'wav',
        langHint: cfg.stt.langHint,
      });
    }
    return transcribeOpenai({
      baseUrl: cfg.stt.openai.baseUrl,
      apiKey,
      model: cfg.stt.openai.model,
      bytes,
      format: 'wav',
      name: 'heard.wav',
      langHint: cfg.stt.langHint,
      context: cfg.stt.context,
    });
  }

  /** 引擎写临时 wav 的地方：放系统临时目录，用完就删，不在数据目录里留空壳。 */
  private scratch(name: string): string {
    const dir = join(tmpdir(), 'cortico-audio');
    mkdirSync(dir, { recursive: true });
    return join(dir, name);
  }

  /** 入参二选一：本地路径，或 Core 分配的 log:/mem: 句柄；句柄按 mime 落到临时文件。 */
  private inputFile(args: { path?: unknown; handle?: unknown }): string {
    const path = String(args.path ?? '').trim();
    if (path) return path;
    const handle = String(args.handle ?? '').trim();
    if (!handle) throw new Error('需要 path 或 handle。');
    const blob = this.host?.blob(handle);
    if (!blob) throw new Error(`读不到附件 ${handle}。`);
    const ext = blob.mime === 'audio/wav' ? 'wav' : blob.mime === 'audio/mpeg' ? 'mp3' : 'bin';
    const file = this.scratch(`in${Date.now()}-${++this.handleSeq}.${ext}`);
    writeFileSync(file, blob.bytes);
    return file;
  }

  /** 转写记录里写的模型名：跟随当前识别引擎。 */
  private sttLabel(): string {
    const cfg = this.opts.cfg.stt;
    if (cfg.engine === 'sensevoice') return 'SenseVoiceSmall';
    if (cfg.engine === 'dashscope' || cfg.engine === 'dashscope-async') return cfg.dashscope.model;
    return cfg.openai.model;
  }

  /** 一块听来的声音：正文进转写记录，再写一条 audio.heard；不存音频文件。 */
  private async shipHeard(chunk: HeardChunk, text: string, info: { transcribeError: string; aedLabel?: string }): Promise<void> {
    // World 已经停了：这块只留在记录里。
    if (!this.host) return;
    const cfg = this.opts.cfg;

    if (text) {
      // 听到的正文进「记录 → 转写」；来源写当时的应用 / 窗口标题，不留音频。
      try {
        this.transcripts.add({
          text,
          note: chunk.target || chunk.app || chunk.source,
          source: { kind: 'live', ref: chunk.target || chunk.app || chunk.source },
          model: this.sttLabel(),
          protocol: cfg.stt.engine,
          language: cfg.stt.langHint,
          seconds: Math.round(chunk.durationMs / 100) / 10,
          audioBytes: 0,
          format: '',
        });
      } catch (err) {
        this.host?.log.warn('听：这一句没能存进转写记录', { err: err instanceof Error ? err.message : String(err) });
      }
    }

    const seconds = (chunk.durationMs / 1000).toFixed(1);
    const bits = [`${seconds} 秒`, chunk.target || chunk.source];
    if (chunk.forced) bits.push('被强切');
    const head = `听到一段声音（${bits.join(' · ')}）`;
    const tail = text ? `：${text}` : info.transcribeError ? `；转写失败：${info.transcribeError}` : '';
    // 通知模式交给内核合批：trigger=debounce 由 WakeBus 按框架的 batching 配置合并投递，
    // 几句会在同一次唤醒里一起给到模型；这里不自己计时。
    const notify = cfg.listen.deliver === 'notify';
    try {
      await this.host.pushEvent({
        type: 'audio.heard',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'external',
        senderKey: `audio:listen:${chunk.source}${chunk.app ? `:${chunk.app.toLowerCase()}` : ''}`,
        text: `${head}${tail}`,
        meta: {
          source: chunk.source,
          app: chunk.app,
          target: chunk.target,
          durationMs: chunk.durationMs,
          startedAt: chunk.startedAt,
          forced: chunk.forced,
          peakDb: chunk.peakDb,
          transcribed: Boolean(text),
          transcribeError: info.transcribeError,
        },
      }, notify ? { deliver: true, trigger: 'debounce' } : { deliver: false });
    } catch (err) {
      this.host?.log.warn('听：这一块的 audio.heard 没写进去', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 听页的电平通道：连接期间 100ms 推一帧，断开就停。 */
  private streamPanel(panel: string, socket: WorldStreamSocket): void {
    if (panel !== 'listen') {
      socket.close('unknown panel');
      return;
    }
    this.levelSockets.add(socket);
    socket.onClose(() => {
      this.levelSockets.delete(socket);
      if (!this.levelSockets.size) this.stopLevelPush();
    });
    this.sendLevels(socket);
    if (!this.levelTimer) {
      this.levelTimer = setInterval(() => this.pushLevels(), 100);
      this.levelTimer.unref?.();
    }
  }

  private sendLevels(socket: WorldStreamSocket): void {
    try {
      socket.send(JSON.stringify({ t: 'levels', ...this.hearing.levels() }));
    } catch {
      // 对端刚断，下一帧不再发。
    }
  }

  private pushLevels(): void {
    if (!this.levelSockets.size) {
      this.stopLevelPush();
      return;
    }
    const frame = JSON.stringify({ t: 'levels', ...this.hearing.levels() });
    for (const socket of this.levelSockets) {
      try {
        socket.send(frame);
      } catch {
        // 关闭中的连接忽略。
      }
    }
  }

  private stopLevelPush(): void {
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    this.levelSockets.clear();
  }

  /** 车道/开关变了：让打开着的听页重画一次状态，不用等轮询。 */
  private broadcastStateChange(): void {
    if (!this.levelSockets.size) return;
    for (const socket of this.levelSockets) {
      try {
        socket.send(JSON.stringify({ t: 'state' }));
      } catch {
        // 关闭中的连接忽略。
      }
    }
  }

  private listenStatusText(): string {
    const cfg = this.opts.cfg;
    const lanes = this.hearing.views();
    const module = this.hearing.module();
    const up = lanes.filter((lane) => lane.listening);
    const lines: string[] = [];
    if (!module.ok) lines.push(`听觉：采集模块不可用——${module.error}`);
    else if (up.length) lines.push(`听觉：在听 ${up.length} 路。`);
    else if (this.hearing.isPaused) lines.push('听觉：停着（勾选还留着，start 继续）。');
    else lines.push('听觉：没在听（没有勾选来源，或都没起来）。');
    for (const lane of lanes) {
      const bits = [lane.label, vadLabel(lane.vad), `${Math.round(lane.audioMs / 1000)} 秒`, `${lane.chunks} 块`];
      if (lane.listening) bits.push(`电平 ${Math.round(lane.level)} dBFS`);
      if (lane.error) bits.push(`错误：${lane.error}`);
      lines.push(`· ${bits.join(' · ')}`);
    }
    const vad = cfg.listen.vad;
    if (vad.kind === 'stream') {
      lines.push(`切分：默认 流式（Paraformer 中英：端点停 ${vad.minSilenceMs}ms 算一句，单句上限 ${vad.maxUtteranceMs}ms）。`);
    } else {
      lines.push(`切分：默认 ${vadLabel(vad.kind)}（${vad.kind === 'energy' ? `${vad.thresholdDb} dBFS` : `概率 ${vad.threshold}`}）· 最短语音 ${vad.minSpeechMs}ms · 收尾 ${vad.minSilenceMs}ms · 单块上限 ${vad.maxUtteranceMs}ms · 最短片段 ${vad.minUtteranceMs}ms。`);
    }
    lines.push(`转写：${cfg.listen.transcribe ? `开（${cfg.stt.engine}）` : '关'} · 投递：${cfg.listen.deliver === 'notify' ? '合并送达（内核 debounce 合批，窗口见框架批处理设置）' : '只归档'}。`);
    const recent = this.transcripts.list(200).filter((item) => item.source.kind === 'live').slice(0, 5);
    if (!recent.length) {
      lines.push('还没有听到带文字的句子。');
    } else {
      lines.push('最近听到：');
      for (const item of recent) {
        const bits = [`${(item.seconds ?? 0).toFixed(1)} 秒`, item.source.ref];
        if (item.text) bits.push(`「${item.text.length > 60 ? `${item.text.slice(0, 60)}…` : item.text}」`);
        lines.push(bits.join(' · '));
      }
    }
    if (module.ok) lines.push('可选来源：source=system、source=mic，或应用进程名 / PID。');
    return lines.join('\n');
  }

  private listenTool(): ToolDef {
    return {
      ...decl('audio_listen'),
      handler: async (args) => {
        const action = String(args.action ?? '').trim().toLowerCase();
        const source = String(args.source ?? '').trim();
        if (action === 'status') return this.listenStatusText();
        if (action === 'start') {
          if (source) {
            try {
              const id = await this.laneIdOf(source);
              writeLanes(this.lanesFile, setLane(readLanes(this.lanesFile), id, ''));
            } catch (err) {
              return `[audio_listen 失败] ${err instanceof Error ? err.message : String(err)}`;
            }
          } else if (!readLanes(this.lanesFile).length) {
            return '[audio_listen 没执行] 还没有勾选的来源：给 source（system、mic 或进程名 / PID），或在「听」页勾选。';
          }
          this.hearing.start();
          this.broadcastStateChange();
          const lanes = this.hearing.views();
          const up = lanes.filter((lane) => lane.listening);
          const lines = [`在听：${up.length ? up.map((lane) => `${lane.label}（${lane.vad}）`).join('、') : '（没有开起来的）'}。`];
          for (const lane of lanes) {
            if (!lane.listening && lane.error) lines.push(`${lane.label} 没起来：${lane.error}`);
          }
          lines.push('听到的话会自动转成文字存进「记录 → 转写」；不保存音频文件。');
          return lines.join('\n');
        }
        if (action === 'stop') {
          if (source) {
            try {
              const id = await this.laneIdOf(source);
              writeLanes(this.lanesFile, removeLane(readLanes(this.lanesFile), id));
              this.hearing.sync();
              this.broadcastStateChange();
              return `不听了：${id}（勾选也取消了）。`;
            } catch (err) {
              return `[audio_listen 失败] ${err instanceof Error ? err.message : String(err)}`;
            }
          }
          this.hearing.stop();
          this.broadcastStateChange();
          return '听觉停了：勾选保留，下次 start 按它们继续。';
        }
        return '[audio_listen 没执行] action 要填 start、stop 或 status。';
      },
    };
  }

  /** 当前选中的 RVC 音色（只认 rvc 目录里的文件）。 */
  private currentRvcFile(): string {
    const ref = this.opts.cfg.convert.model;
    const file = ref.split(/[\\/]/).pop() ?? '';
    return this.rvcVoices.list().includes(file) ? file : '';
  }

  /** 变声缺什么：源码、Python 环境、hubert 与 F0 资产；音色与 ffmpeg 另算。 */
  private rvcMissing(): string[] {
    const projectDir = this.rvcProject.dir();
    const assets = rvcAssetsDir(this.roots);
    const missing: string[] = [];
    if (!isRvcProjectDir(projectDir)) missing.push('RVC 源码');
    if (this.rvcEnvJob.status().phase !== 'ready') missing.push('RVC Python 环境');
    if (!existsSync(join(assets, 'hubert_base', 'pytorch_model.bin')) || !existsSync(join(assets, 'rmvpe', 'rmvpe.pt'))) missing.push('RVC 资产');
    return missing;
  }

  private rvcReady(): boolean {
    return this.rvcMissing().length === 0 && !!this.currentRvcFile();
  }

  /** 变声运行态：给变声页一句话，也给工具回执用。 */
  private rvcRuntime(): { ready: boolean; voice: string; missing: string[]; engine: RvcState } {
    return {
      ready: this.rvcReady(),
      voice: this.currentRvcFile(),
      missing: this.rvcMissing(),
      engine: this.rvcCache?.engine.state() ?? { phase: 'stopped', device: null, model: null, detail: null },
    };
  }

  /** 变声引擎：源码、资产、ffmpeg 位置与档位定一份；变了就换进程。 */
  private async rvcEngine(): Promise<RvcEngine> {
    const projectDir = this.rvcProject.dir();
    const tier = this.tier();
    const gpuIndex = Number(/^gpu(\d+)$/.exec(this.opts.cfg.speak.gptSovits.tier)?.[1] ?? '0');
    const ffmpeg = (await this.ffmpegInfo()).path;
    const ffmpegDir = ffmpeg && ffmpeg !== 'ffmpeg' ? dirname(ffmpeg) : '';
    const key = `${projectDir}|${tier}|${gpuIndex}|${ffmpegDir}`;
    if (this.rvcCache?.key === key) return this.rvcCache.engine;
    this.rvcCache?.engine.dispose();
    const engine = new RvcEngine({
      command: projectPython(projectDir),
      args: [
        fileURLToPath(new URL('../python/rvc_worker.py', import.meta.url)),
        projectDir,
        rvcAssetsDir(this.roots),
        this.rvcVoices.dir,
      ],
      env: {
        // 档位选 CPU 时把显卡藏起来，让上游 Config 落到 CPU。
        CUDA_VISIBLE_DEVICES: tier === 'cuda' ? String(gpuIndex) : '-1',
        // 上游用 ffmpeg 解输入音频，把本 World 自己那份放到子进程 PATH 前面。
        ...(ffmpegDir ? { PATH: `${ffmpegDir}${delimiter}${process.env.PATH ?? ''}` } : {}),
      },
    });
    this.rvcCache = { key, engine };
    return engine;
  }

  /** 把一段音频换成选中的音色：转完存进语音记录并入播放队列。 */
  private async convertFile(input: string, voice: string | undefined, origin: 'tool' | 'ui', silent = false, jobId = ''): Promise<ClipRecord> {
    const converted = await this.convertAudio(input, voice);
    const seconds = wavSeconds(converted.bytes);
    const clip = this.clips.add({
      bytes: converted.bytes,
      ext: 'wav',
      mime: 'audio/wav',
      text: `变声 · ${converted.voice}`,
      note: `变声自 ${converted.source}`.slice(0, 200),
      voice: converted.voice,
      model: 'RVC',
      format: 'wav',
      seconds,
      source: origin,
    });
    this.rvcLast = { voice: converted.voice, seconds, ms: converted.ms, path: clip.path, at: nowIso(this.opts.timezone) };
    if (silent) {
      // 路径和句柄都给：正文带本地路径，附件由 Core 分配 log: 句柄。
      void this.host?.pushEvent({
        type: 'audio.convert_done',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'external',
        senderKey: this.id,
        text: `audio_convert（${jobId}）已转换，未播放：${clip.path}（音色 ${converted.voice}，${seconds ?? '?'} 秒）。`,
        meta: { job: jobId, path: clip.path, voice: converted.voice, model: 'RVC', seconds },
        blobs: [{
          bytes: converted.bytes,
          mime: 'audio/wav',
          name: `${clip.id}.wav`,
          fallbackText: '这段变声后的音频；把这个句柄交给别的插件即可发送同一段音频。',
        }],
      }, { deliver: true }).catch(() => {});
      return clip;
    }
    this.queue.enqueue({ path: clip.path, origin, seconds: seconds ?? undefined });
    return clip;
  }

  /** 把一段音频换成当前音色，只回字节与音色名；唱歌的后处理也走这里。 */
  private async convertAudio(input: string, voice?: string): Promise<{ bytes: Buffer; voice: string; source: string; ms: number }> {
    const source = input.trim();
    if (!source) throw new Error('没有选要变声的音频。');
    if (!existsSync(source)) throw new Error(`没有这个文件：${source}`);
    const wanted = (voice?.trim() || this.currentRvcFile()).replace(/\.pth$/i, '');
    if (!wanted) throw new Error('还没有变声音色：在「说话 → 变声」页导入一个 .pth 并选中。');
    if (!this.rvcVoices.list().includes(`${wanted}.pth`)) throw new Error(`音色不在了：${wanted}.pth（在变声页重新导入）`);
    const missing = this.rvcMissing();
    if (missing.length) throw new Error(`还缺：${missing.join('、')}。去「依赖」页对 RVC 点「获取」。`);
    if (!(await this.ffmpegInfo()).path) throw new Error('变声要用 ffmpeg 解码音频：先在「依赖」页获取 ffmpeg。');
    const cfg = this.opts.cfg;
    const engine = await this.rvcEngine();
    const out = this.scratch(`cv${Date.now()}-${++this.convertSeq}.wav`);
    try {
      const result = await engine.convert({
        input: source,
        output: out,
        model: this.rvcVoices.pathOf(`${wanted}.pth`),
        pitch: cfg.convert.pitch,
        indexRate: cfg.convert.indexRate,
        protect: cfg.convert.protect,
      });
      return { bytes: readFileSync(out), voice: wanted, source, ms: result.ms };
    } finally {
      rmSync(out, { force: true });
    }
  }

  /** 后台变声：与工具同一套回执语义，成功不打扰，失败推事件。 */
  private queueConvert(input: string, voice: string | undefined, jobId: string, silent = false): void {
    const run = (): Promise<ClipRecord> => this.convertFile(input, voice, 'tool', silent, jobId);
    const next = this.convertChain.then(run, run);
    this.convertChain = next.catch(() => {});
    void next.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      void this.host?.pushEvent({
        type: 'audio.convert_failed',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'external',
        senderKey: this.id,
        text: `audio_convert（${jobId}）没转出来：${message}`,
      }).catch(() => {});
    });
  }

  /** 选中的声库：配置里那个在就用它，不在就退回扫到的第一个。 */
  private singBank(): { name: string; dir: string } | null {
    const dir = singerDir(this.roots);
    const wanted = this.opts.cfg.sing.voicebank.trim();
    if (wanted) {
      const path = bankDir(dir, wanted);
      if (path) return { name: wanted, dir: path };
    }
    const first = listBanks(dir)[0];
    if (!first) return null;
    const path = bankDir(dir, first.name);
    return path ? { name: first.name, dir: path } : null;
  }

  private bankLabel(name: string): string {
    return listBanks(singerDir(this.roots)).find((bank) => bank.name === name)?.label ?? name;
  }

  private singMissing(): string[] {
    const missing: string[] = [];
    if (!this.singBank()) missing.push('DiffSinger 声库');
    if (this.singEnvJob.status().phase !== 'ready') missing.push('DiffSinger 环境');
    return missing;
  }

  private singReady(): boolean {
    return this.singMissing().length === 0;
  }

  /** 唱歌运行态：给唱歌页一句话，也给工具回执用。 */
  private singRuntime(): { ready: boolean; bank: string; missing: string[]; engine: SingState } {
    return {
      ready: this.singReady(),
      bank: this.singBank()?.name ?? '',
      missing: this.singMissing(),
      engine: this.singCache?.engine.state() ?? { phase: 'stopped', voicebank: null, sampleRate: null, speakers: [], detail: null },
    };
  }

  /** 唱歌引擎：声库或解释器变了就换进程；第一次唱才拉起。 */
  private singerEngine(bankPath: string): SingEngine {
    const python = envPython(singEnvDir(this.roots));
    const key = `${bankPath}|${python}`;
    if (this.singCache?.key === key) return this.singCache.engine;
    this.singCache?.engine.dispose();
    const engine = new SingEngine({
      command: python,
      args: [fileURLToPath(new URL('../python/diffsinger_worker.py', import.meta.url)), bankPath],
      // 推理在 CPU 上跑：线程压到 4，唱的时候别把整机占满。
      env: { OMP_NUM_THREADS: '4' },
    });
    this.singCache = { key, engine };
    return engine;
  }

  /** 唱一首：歌词按当前声库与参数唱出来；「唱完变声」开着就再过一遍 RVC。 */
  private async singSong(lyrics: string, origin: 'tool' | 'ui', silent = false, jobId = ''): Promise<ClipRecord> {
    const text = lyrics.trim();
    if (!text) throw new Error('歌词为空。');
    const missing = this.singMissing();
    if (missing.length) throw new Error(`还缺：${missing.join('、')}。去「依赖」页对 DiffSinger 点「获取」。`);
    const bank = this.singBank()!;
    const cfg = this.opts.cfg;
    const engine = this.singerEngine(bank.dir);
    const out = this.scratch(`sg${Date.now()}-${++this.singSeq}.wav`);
    try {
      const result = await engine.sing({
        out,
        lyrics: text,
        bpm: cfg.sing.bpm,
        keyShift: cfg.sing.keyShift,
        scale: cfg.sing.scale,
        seed: cfg.sing.seed,
        speaker: cfg.sing.color.trim(),
        maxSeconds: 60,
      });
      let bytes: Buffer = readFileSync(out);
      let voice = cfg.sing.color.trim() || bank.name;
      let model = `DiffSinger · ${this.bankLabel(bank.name)}`;
      if (cfg.sing.convert) {
        try {
          const converted = await this.convertAudio(out);
          bytes = converted.bytes;
          voice = converted.voice;
          model = `DiffSinger → RVC · ${converted.voice}`;
        } catch (err) {
          // 后处理失败不该让整首歌丢掉：用干声照常交付，只记一条。
          this.host?.log.warn('唱歌：变声后处理失败，用干声', { err: err instanceof Error ? err.message : String(err) });
        }
      }
      const seconds = wavSeconds(bytes);
      const clip = this.clips.add({
        bytes,
        ext: 'wav',
        mime: 'audio/wav',
        text,
        note: '',
        voice,
        model,
        format: 'wav',
        seconds,
        source: origin,
      });
      this.singLast = { voice, seconds, ms: result.ms, path: clip.path, at: nowIso(this.opts.timezone) };
      if (silent) {
        void this.host?.pushEvent({
          type: 'audio.sing_done',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          origin: 'external',
          senderKey: this.id,
          text: `audio_sing（${jobId}）已唱完，未播放：${clip.path}（${voice}，${seconds ?? '?'} 秒）。`,
          meta: { job: jobId, path: clip.path, voice, model, seconds, notes: result.notes },
          blobs: [{
            bytes,
            mime: 'audio/wav',
            name: `${clip.id}.wav`,
            fallbackText: '这首唱好的音频；把这个句柄交给别的插件即可发送同一段音频。',
          }],
        }, { deliver: true }).catch(() => {});
        return clip;
      }
      this.queue.enqueue({ path: clip.path, origin, text, seconds: seconds ?? undefined });
      return clip;
    } finally {
      rmSync(out, { force: true });
    }
  }

  /** 后台唱歌：成功不打扰，失败推事件。 */
  private queueSing(lyrics: string, jobId: string, silent = false): void {
    const run = (): Promise<ClipRecord> => this.singSong(lyrics, 'tool', silent, jobId);
    const next = this.singChain.then(run, run);
    this.singChain = next.catch(() => {});
    void next.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      void this.host?.pushEvent({
        type: 'audio.sing_failed',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'external',
        senderKey: this.id,
        text: `audio_sing（${jobId}）没唱出来：${message}`,
      }).catch(() => {});
    });
  }

  /** 当前选中的参考音频（只认 timbre 目录里的文件）。 */
  private currentTimbreFile(): string {
    const ref = this.opts.cfg.speak.gptSovits.refAudio;
    const file = ref.split(/[\\/]/).pop() ?? '';
    return this.timbre.get(file) ? file : '';
  }

  /** 选中某个参考音频：路径与台本一起写进配置。 */
  private selectTimbre(file: string): void {
    const item = this.timbre.get(file);
    if (!item) return;
    this.opts.persist({ speak: { gptSovits: { refAudio: this.timbre.pathOf(file), refText: item.text } } } as never);
  }

  /** 面板写配置：只收已声明的键，按 schema 类型验收后按路径深合并进 `worlds.audio`。 */
  private saveConfigValue(key: string, raw: unknown): unknown {
    const properties = (AUDIO_CONFIG_GROUP.schema as {
      properties?: Record<string, { type?: string; minimum?: number; maximum?: number }>;
    }).properties ?? {};
    const def = properties[key];
    if (!def) throw new Error(`未知配置项：${key}`);
    let value: string | number | boolean;
    if (def.type === 'boolean') {
      if (typeof raw !== 'boolean') throw new Error(`${key} 要布尔值`);
      value = raw;
    } else if (def.type === 'number' || def.type === 'integer') {
      const next = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(next)) throw new Error(`${key} 要数字`);
      if (def.type === 'integer' && !Number.isInteger(next)) throw new Error(`${key} 要整数`);
      if (def.minimum !== undefined && next < def.minimum) throw new Error(`${key} 不能小于 ${def.minimum}`);
      if (def.maximum !== undefined && next > def.maximum) throw new Error(`${key} 不能大于 ${def.maximum}`);
      value = next;
    } else {
      value = String(raw ?? '');
    }
    const parts = key.slice('worlds.audio.'.length).split('.');
    const patch: Record<string, unknown> = {};
    let cursor = patch;
    for (const part of parts.slice(0, -1)) {
      const next: Record<string, unknown> = {};
      cursor[part] = next;
      cursor = next;
    }
    cursor[parts[parts.length - 1]] = value;
    this.opts.persist(patch as never);
    return { ok: true, key, value };
  }

  /** 说话页：三组配置、参考音频与变声音色清点、声库、密钥是否已填、可选的显卡。 */
  private async speakState(): Promise<unknown> {
    const cfg = this.opts.cfg;
    const has = (name: string): boolean => !!this.opts.secret(name).trim();
    const gpu = await this.gpu();
    return {
      speak: cfg.speak,
      convert: cfg.convert,
      sing: cfg.sing,
      timbres: this.timbre.list(),
      refFile: this.currentTimbreFile(),
      rvcVoices: this.rvcVoices.list(),
      rvcFile: this.currentRvcFile(),
      rvcRuntime: this.rvcRuntime(),
      lastConvert: this.rvcLast,
      singRuntime: this.singRuntime(),
      lastSing: this.singLast,
      banks: listBanks(singerDir(this.roots)),
      gpus: gpu.gpus.map((item) => ({ index: item.index, name: item.name, vramMB: item.vramMB })),
      secrets: {
        dashscope: has(cfg.speak.dashscope.apiKeySecret),
        openai: has(cfg.speak.openai.apiKeySecret),
      },
    };
  }

  /** 工具页的说明文案（面板按语言取）。 */
  private toolTextView(view: ReturnType<ToolTextStore['read']>): unknown {
    return {
      ...view,
      tools: view.tools.map((tool) => ({ ...tool, summary: TOOL_SUMMARIES[tool.name] })),
    };
  }

  /** 队列页的数据面：列表与三个动作都回一份新快照。 */
  private queueInvoke(method: string, args: unknown[]): unknown {
    switch (method) {
      case 'list':
        return this.queue.snapshot();
      case 'skip':
        return { text: this.queue.skip(), state: this.queue.snapshot() };
      case 'remove':
        return { text: this.queue.remove(String(args[0] ?? '')), state: this.queue.snapshot() };
      case 'clear':
        return { text: this.queue.clear(), state: this.queue.snapshot() };
      case 'subtitle':
        return this.subtitleStyle();
      case 'previewSubtitle':
        this.subtitle.show('字幕预览：这是一句桌面字幕。', 3, { ...this.subtitleStyle(), enabled: true }, { hideAfterMs: 4000 });
        return this.subtitleStyle();
      default:
        throw new Error(`未知方法 queue/${method}`);
    }
  }

  /** 桌面字幕的当前样式；缺字段或值不认识时退回默认，不拦播放。 */
  private subtitleStyle(): SubtitleStyle {
    const raw = (this.opts.cfg as { subtitle?: Partial<SubtitleStyle> }).subtitle ?? {};
    const vertical = raw.vertical === 'top' || raw.vertical === 'middle' ? raw.vertical : 'bottom';
    const align = raw.align === 'left' || raw.align === 'right' ? raw.align : 'center';
    const size = typeof raw.size === 'number' && Number.isFinite(raw.size) ? Math.min(96, Math.max(12, raw.size)) : 34;
    const color = typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : '#FFFFFF';
    return { enabled: raw.enabled !== false, size, color, vertical, align };
  }

  private playTool(): ToolDef {
    return {
      ...decl('audio_play'),
      handler: async (args) => {
        let path = '';
        try {
          path = this.inputFile(args);
        } catch (err) {
          return `[audio_play 没执行] ${err instanceof Error ? err.message : String(err)}`;
        }
        if (!existsSync(path)) return `[audio_play 没执行] 没有这个文件：${path}`;
        const volume = typeof args.volume === 'number' ? args.volume : undefined;
        const { id, position } = this.queue.enqueue({ path, volume, origin: 'tool' });
        return `已加入播放队列 ${id}（第 ${position} 条）：${path}`;
      },
    };
  }

  /** 合成一句：本机 GPT-SoVITS 或云端引擎。 */
  private async speakOnce(
    text: string,
    voice?: string,
    instruction?: string,
  ): Promise<{ wav: Buffer; engine: string; format: string; voice: string; model: string }> {
    const cfg = this.opts.cfg;
    const engine = cfg.speak.engine;
    if (engine === 'gpt-sovits') {
      const g = cfg.speak.gptSovits;
      const item = this.timbre.get(g.refAudio.split(/[\\/]/).pop() ?? '');
      const refAudio = item ? this.timbre.pathOf(item.file) : g.refAudio.trim();
      if (!refAudio) throw new Error('还没选参考音频：在「说话」页导入一段 WAV 并选中。');
      const wav = await this.sovitsService().synthesize(text, {
        refAudio,
        promptText: item?.text ?? g.refText,
        promptLang: '',
        textLang: cfg.speak.textLang,
        speed: g.speed,
      }, AbortSignal.timeout(600_000));
      return { wav, engine: 'gpt-sovits', format: 'wav', voice: item?.file ?? basename(refAudio), model: 'GPT-SoVITS' };
    }
    const name = engine === 'dashscope' ? cfg.speak.dashscope.apiKeySecret : cfg.speak.openai.apiKeySecret;
    const apiKey = this.opts.secret(name).trim();
    if (!apiKey) throw new Error(`还没有填密钥：在「说话」页把 ${name} 写上。`);
    const format = engine === 'dashscope' ? cfg.speak.dashscope.format : cfg.speak.openai.format;
    const usedVoice = voice?.trim() || (engine === 'dashscope' ? cfg.speak.dashscope.voice : cfg.speak.openai.voice);
    const wav = await synthesizeCloud({
      engine,
      apiKey,
      text,
      voice: usedVoice,
      format,
      instruction: instruction?.trim() || cfg.speak.dashscope.instruction,
      seed: engine === 'dashscope' && cfg.speak.dashscope.seed >= 0 ? cfg.speak.dashscope.seed : undefined,
      dashscope: {
        baseUrl: cfg.speak.dashscope.baseUrl,
        model: cfg.speak.dashscope.model,
        sampleRate: cfg.speak.dashscope.sampleRate,
        languageHints: cfg.speak.dashscope.languageHints,
      },
      openai: {
        baseUrl: cfg.speak.openai.baseUrl,
        model: cfg.speak.openai.model,
        sampleRate: cfg.speak.openai.sampleRate,
        languageHints: cfg.speak.openai.languageHints,
      },
    });
    const model = engine === 'dashscope' ? cfg.speak.dashscope.model : cfg.speak.openai.model;
    return { wav, engine, format: format || 'wav', voice: usedVoice, model };
  }

  private convertTool(): ToolDef {
    return {
      ...decl('audio_convert'),
      handler: async (args) => {
        let path = '';
        try {
          path = this.inputFile(args);
        } catch (err) {
          return `[audio_convert 没执行] ${err instanceof Error ? err.message : String(err)}`;
        }
        if (!existsSync(path)) return `[audio_convert 没执行] 没有这个文件：${path}`;
        const voice = String(args.voice ?? '').trim() || this.currentRvcFile();
        if (!voice) return '[audio_convert 没执行] 还没有变声音色：先在「说话 → 变声」页导入并选中一个 .pth。';
        const missing = this.rvcMissing();
        if (missing.length) return `[audio_convert 没执行] 还缺：${missing.join('、')}。去「依赖」页对 RVC 点「获取」。`;
        const silent = args.silent === true;
        const jobId = `cv${++this.convertSeq}`;
        this.queueConvert(path, voice, jobId, silent);
        return `已开始变声 ${jobId}（音色 ${voice.replace(/\.pth$/i, '')}）${silent ? '，完成后以 audio.convert_done 事件带回路径与音频附件，不播放' : '，完成后进「记录 → 语音」并自动播放'}；不用等它。`;
      },
    };
  }

  private singTool(): ToolDef {
    return {
      ...decl('audio_sing'),
      handler: async (args) => {
        const lyrics = String(args.lyrics ?? '').trim();
        if (!lyrics) return '[audio_sing 没执行] 需要 lyrics。';
        const missing = this.singMissing();
        if (missing.length) return `[audio_sing 没执行] 还缺：${missing.join('、')}。去「依赖」页对 DiffSinger 点「获取」。`;
        const silent = args.silent === true;
        const jobId = `sg${++this.singSeq}`;
        this.queueSing(lyrics, jobId, silent);
        const bank = this.singBank();
        return `已开始唱 ${jobId}（${bank ? this.bankLabel(bank.name) : 'DiffSinger'}）${silent ? '，唱完以 audio.sing_done 事件带回路径与音频附件，不播放' : '，唱完进「记录 → 语音」并自动播放'}；不用等它。`;
      },
    };
  }

  private sayTool(): ToolDef {
    return {
      ...decl('audio_say'),
      handler: async (args) => {
        const text = String(args.text ?? '').trim();
        if (!text) return '[audio_say 没执行] 需要 text。';
        const voice = args.voice ? String(args.voice) : undefined;
        const instruction = args.instruction ? String(args.instruction) : undefined;
        const silent = args.silent === true;
        const job: SpeakJob = { id: `say${++this.speakSeq}`, text, voice, instruction, silent };
        const ahead = (this.speakBusy ? 1 : 0) + this.speakJobs.length;
        this.speakJobs.push(job);
        void this.drainSpeak();
        const tail = silent ? '，完成后以 audio.say_done 事件带回文件路径，不播放' : '，说完会自动播放';
        return `已在后台开始合成 ${job.id}${ahead ? `（前面还有 ${ahead} 句）` : ''}${tail}；不用等它。`;
      },
    };
  }

  /** 后台合成一条接一条地做；成功不出声，失败推一条事件让模型知道。 */
  private async drainSpeak(): Promise<void> {
    if (this.speakBusy) return;
    this.speakBusy = true;
    const gen = this.speakGen;
    try {
      while (this.speakJobs.length) {
        const job = this.speakJobs.shift()!;
        try {
          const out = await this.speakOnce(job.text, job.voice, job.instruction);
          if (gen !== this.speakGen) return;
          const clip = this.saveClip(out, job.text);
          if (job.silent) {
            void this.host?.pushEvent({
              type: 'audio.say_done',
              ts: nowIso(this.opts.timezone),
              source: this.id,
              origin: 'external',
              senderKey: this.id,
              // 路径和句柄都给：正文带本地路径，附件由 Core 分配 log: 句柄。
              text: `audio_say（${job.id}）已合成，未播放：${clip.path}（${clip.voice}，${clip.seconds ?? '?'} 秒）。`,
              meta: { job: job.id, path: clip.path, voice: clip.voice, model: clip.model, seconds: clip.seconds },
              // 音频按 Core 的附件契约入 session：句柄随事件交给模型，别的插件用同一个句柄取回这段音频。
              blobs: [{
                bytes: out.wav,
                mime: 'audio/wav',
                name: `${clip.id}.wav`,
                fallbackText: '这段语音的音频文件；把这个句柄交给别的插件（例如 QQ 语音参数）即可发送同一段音频。',
              }],
            }, { deliver: true }).catch(() => {});
            continue;
          }
          this.queue.enqueue({
            path: clip.path,
            origin: 'tool',
            text: clip.text,
            seconds: clip.seconds ?? undefined,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (gen !== this.speakGen) return;
          void this.host?.pushEvent({
            type: 'audio.say_failed',
            ts: nowIso(this.opts.timezone),
            source: this.id,
            origin: 'external',
            senderKey: this.id,
            text: `audio_say（${job.id}）没说出来：${message}`,
          }).catch(() => {});
        }
      }
    } finally {
      this.speakBusy = false;
    }
  }

  /** 合成结果先入记录仓库再播放；面板的「语音」栏就是这些记录。 */
  private saveClip(out: { wav: Buffer; format: string; voice: string; model: string }, text: string): ClipRecord {
    return this.clips.add({
      bytes: out.wav,
      ext: out.format,
      text,
      voice: out.voice,
      model: out.model,
      seconds: wavSeconds(out.wav),
      source: 'tool',
    });
  }

  private transcribeTool(): ToolDef {
    return {
      ...decl('audio_transcribe'),
      handler: async (args) => {
        let path = '';
        try {
          path = this.inputFile(args);
        } catch (err) {
          return `[audio_transcribe 没执行] ${err instanceof Error ? err.message : String(err)}`;
        }
        if (!existsSync(path)) return `[audio_transcribe 没执行] 没有这个文件：${path}`;
        const cfg = this.opts.cfg;
        const engine = cfg.stt.engine;
        if (engine === 'moonshine') {
          return '[audio_transcribe 没执行] Moonshine 不能流式识别；这个工具只做整段转写，改用 SenseVoice 或云端的 DashScope / OpenAI 兼容服务。';
        }
        if (engine === 'sensevoice') {
          if (!existsSync(envPython(asrEnvDir(this.roots))) || !existsSync(join(this.sensevoiceModelDir(), 'model.int8.onnx'))) {
            return '[audio_transcribe 没执行] 本机识别还没装好：先去「依赖」页对 SenseVoice 点「获取」。';
          }
          if (!(await this.ffmpegInfo()).path) {
            return '[audio_transcribe 没执行] 本机识别要用 ffmpeg 解码：先在「依赖」页获取 ffmpeg。';
          }
        } else {
          if (!formatFromName(path)) return '[audio_transcribe 没执行] 认不出音频格式：换成 wav / mp3 这类常见格式。';
          const name = engine === 'openai' ? cfg.stt.openai.apiKeySecret : cfg.stt.dashscope.apiKeySecret;
          if (!this.opts.secret(name).trim()) return `[audio_transcribe 没执行] 还没有填密钥：在「听」页把 ${name} 写上。`;
          const size = statSync(path).size;
          if (cfg.stt.maxMb > 0 && size > cfg.stt.maxMb * 1024 * 1024) {
            return `[audio_transcribe 没执行] 音频 ${(size / 1024 / 1024).toFixed(1)} MB，超过上限 ${cfg.stt.maxMb} MB。`;
          }
        }
        // 慢活（解码 / 识别）放后台：结果写进「记录 → 转写」，文字以事件带回。
        const jobId = `asr${++this.transcribeSeq}`;
        this.queueTranscribeFile(path, engine, jobId);
        return `已开始转写 ${jobId}（${basename(path)}），完成后写进「记录 → 转写」并以 audio.transcribed 事件带回文字；不用等它。`;
      },
    };
  }

  /** 转写一条接一条地跑；失败推事件，成功由 `transcribeFileJob` 带正文推事件。 */
  private queueTranscribeFile(path: string, engine: string, jobId: string): void {
    const run = (): Promise<void> => this.transcribeFileJob(path, engine, jobId);
    const next = this.transcribeChain.then(run, run);
    this.transcribeChain = next.catch(() => {});
    void next.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      void this.host?.pushEvent({
        type: 'audio.transcribe_failed',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'external',
        senderKey: this.id,
        text: `audio_transcribe（${jobId}）没转出来：${message}`,
        meta: { job: jobId, path },
      }).catch(() => {});
    });
  }

  /** 真正做转写：成功写记录并推 audio.transcribed，失败抛给上层的失败事件。 */
  private async transcribeFileJob(path: string, engine: string, jobId: string): Promise<void> {
    const cfg = this.opts.cfg;
    let text = '';
    let note = '';
    if (engine === 'sensevoice') {
      const ffmpeg = await this.ffmpegInfo();
      if (!ffmpeg.path) throw new Error('本机识别要用 ffmpeg 解码：先在「依赖」页获取 ffmpeg。');
      const bytes = statSync(path).size;
      const pcm = await decodeMono16k(ffmpeg.path, path, AbortSignal.timeout(180_000));
      const result = await this.localAsr().transcribe(pcm);
      const parsed = parsedFromFields(result);
      note = senseVoiceNote(parsed);
      text = parsed.text;
      this.transcripts.add({
        text,
        source: { kind: 'file', ref: path },
        model: 'SenseVoiceSmall',
        protocol: 'sensevoice',
        language: parsed.language,
        seconds: pcm.length / 32_000,
        audioBytes: bytes,
        format: formatFromName(path) ?? '',
      });
    } else {
      const format = formatFromName(path);
      if (!format) throw new Error('认不出音频格式：换成 wav / mp3 这类常见格式。');
      const name = engine === 'openai' ? cfg.stt.openai.apiKeySecret : cfg.stt.dashscope.apiKeySecret;
      const apiKey = this.opts.secret(name).trim();
      if (!apiKey) throw new Error(`还没有填密钥：在「听」页把 ${name} 写上。`);
      const bytes = readFileSync(path);
      if (cfg.stt.maxMb > 0 && bytes.length > cfg.stt.maxMb * 1024 * 1024) {
        throw new Error(`音频 ${(bytes.length / 1024 / 1024).toFixed(1)} MB，超过上限 ${cfg.stt.maxMb} MB。`);
      }
      const fileName = path.split(/[/\\]/).pop() ?? `audio.${format}`;
      text = engine === 'dashscope'
        ? await transcribeDashscope({
          baseUrl: cfg.stt.dashscope.baseUrl,
          apiKey,
          model: cfg.stt.dashscope.model,
          bytes,
          format,
          langHint: cfg.stt.langHint,
          context: cfg.stt.context,
          itn: cfg.stt.dashscope.itn,
          keepDialect: cfg.stt.dashscope.keepDialect,
          sampleRate: cfg.stt.sampleRate,
        })
        : engine === 'dashscope-async'
          ? await transcribeDashscopeAsync({
            baseUrl: cfg.stt.dashscope.baseUrl,
            apiKey,
            model: cfg.stt.dashscope.model,
            bytes,
            name: fileName,
            format,
            langHint: cfg.stt.langHint,
          })
          : await transcribeOpenai({
            baseUrl: cfg.stt.openai.baseUrl,
            apiKey,
            model: cfg.stt.openai.model,
            bytes,
            format,
            name: fileName,
            langHint: cfg.stt.langHint,
            context: cfg.stt.context,
          });
      this.transcripts.add({
        text,
        source: { kind: 'file', ref: path },
        model: engine === 'openai' ? cfg.stt.openai.model : cfg.stt.dashscope.model,
        protocol: engine,
        language: cfg.stt.langHint,
        seconds: wavSeconds(bytes),
        audioBytes: bytes.length,
        format,
      });
    }
    const shown = text || (note ? `（没有识别出文字；${note}）` : '（没有识别出文字）');
    await this.host?.pushEvent({
      type: 'audio.transcribed',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'external',
      senderKey: this.id,
      text: `转写完成（${basename(path)}）：${note ? `${shown}（${note}）` : shown}`,
      meta: { job: jobId, path, transcribed: Boolean(text) },
    }, { deliver: true }).catch(() => {});
  }

  private recordsInvoke(method: string, args: unknown[]): unknown {
    switch (method) {
      case 'state':
        return this.recordsState();
      case 'remove': {
        const kind = recordKind(args[0]);
        this.recordStore(kind).remove(String(args[1] ?? ''));
        return this.recordsState();
      }
      case 'clear': {
        const kind = recordKind(args[0]);
        this.recordStore(kind).clear();
        return this.recordsState();
      }
      case 'play': {
        if (recordKind(args[0]) !== 'clips') throw new Error('转写记录不复制音频，不能试听。');
        const item = this.clips.get(String(args[1] ?? ''));
        if (!item) throw new Error('这条记录不在了。');
        if (!existsSync(item.path)) throw new Error('音频文件不在了（被手动删过？）。');
        this.queue.enqueue({ path: item.path, origin: 'ui', text: item.text, seconds: item.seconds ?? undefined });
        return { text: '已加入播放队列', state: this.recordsState() };
      }
      case 'openFolder':
        return this.openRecordFolder(recordKind(args[0]));
      default:
        throw new Error(`未知方法 records/${method}`);
    }
  }

  private recordsState(): unknown {
    return {
      transcripts: this.transcripts.summary(120),
      clips: this.clips.summary(120),
    };
  }

  private recordStore(kind: RecordsKind): TranscriptsStore | ClipsStore {
    return kind === 'transcripts' ? this.transcripts : this.clips;
  }

  /** 在资源管理器里打开某一栏的目录。 */
  private openRecordFolder(kind: RecordsKind): { ok: boolean; dir: string; detail?: string } {
    const dir = this.recordStore(kind).dir;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // 建不出来也让面板看到路径。
    }
    if (process.platform !== 'win32') return { ok: false, dir, detail: '只会在 Windows 上打开资源管理器' };
    try {
      const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), [dir], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return { ok: true, dir };
    } catch (err) {
      return { ok: false, dir, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private queueTool(): ToolDef {
    return {
      ...decl('audio_queue'),
      handler: async (args) => {
        const act = String(args.act ?? 'list');
        if (act === 'list') {
          const snap = this.queue.snapshot();
          const lines = [snap.current ? `正在播放：${snap.current.id} ${snap.current.shown}（已 ${snap.current.elapsedSec} 秒）` : '正在播放：（空）'];
          lines.push(snap.pending.length ? `排队 ${snap.pending.length} 条：${snap.pending.map((p) => `${p.id} ${p.shown}`).join('、')}` : '排队：（空）');
          if (snap.lastError) lines.push(`最近一次失败：${snap.lastError}`);
          return lines.join('\n');
        }
        if (act === 'skip') return this.queue.skip();
        if (act === 'remove') return this.queue.remove(String(args.id ?? ''));
        if (act === 'clear') return this.queue.clear();
        return '[audio_queue 没执行] act 只能是 list、skip、remove 或 clear。';
      },
    };
  }

  /** ffmpeg 先看本机（配置/PATH/常见位置），再看自己目录里装的那份。 */
  private async ffmpegInfo(): Promise<FfmpegInfo> {
    const now = Date.now();
    if (this.ffmpegCache && now - this.ffmpegCache.at < 15_000) return this.ffmpegCache.info;
    const found = await detectFfmpeg(this.opts.cfg.ffmpegPath);
    let info = found;
    if (!info.path) {
      const local = join(audioPath(this.opts.dataDir, 'ffmpeg'), 'ffmpeg.exe');
      if (existsSync(local)) {
        const version = await probeFfmpeg(local);
        if (version) info = { path: local, version, source: 'installed', detail: null };
      }
    }
    this.ffmpegCache = { at: now, info };
    return info;
  }

  private statusTool(): ToolDef {
    return {
      ...decl('audio_status'),
      handler: async () => this.statusText(),
    };
  }

  private statusText(): string {
    const state = this.capabilities();
    const wired = CAPABILITY_LABELS.filter(([key]) => state[key]).map(([, label]) => label);
    const missing = CAPABILITY_LABELS.filter(([key]) => !state[key]).map(([, label]) => label);
    const lines: string[] = [];
    if (!wired.length) lines.push(`声音 World 还没有接入任何引擎：${missing.join('、')}都还不能用。`);
    else lines.push(`已接入：${wired.join('、')}。未接入：${missing.length ? missing.join('、') : '无'}。`);
    if (state.listen) {
      const lanes = this.hearing.views();
      const up = lanes.filter((lane) => lane.listening);
      if (up.length) lines.push(`监听：${up.length} 路在听（${up.map((lane) => lane.label).join('、')}）。`);
      else if (lanes.length && this.hearing.isPaused) lines.push('监听：停着；audio_listen action=start 继续。');
      else lines.push('监听：没有勾选的来源；audio_listen 或「听」页都能开。');
    }
    if (state.convert) lines.push(`变声：RVC（音色 ${this.currentRvcFile().replace(/\.pth$/i, '')}）。`);
    else if (this.currentRvcFile()) lines.push(`变声：选了音色 ${this.currentRvcFile().replace(/\.pth$/i, '')}，还缺 ${this.rvcMissing().join('、')}。`);
    if (state.sing) {
      const bank = this.singBank();
      const sing = this.opts.cfg.sing;
      const shift = sing.keyShift ? ` · ${sing.keyShift > 0 ? '+' : ''}${sing.keyShift}` : '';
      lines.push(`唱歌：DiffSinger（${bank ? this.bankLabel(bank.name) : '声库'} · ${sing.bpm} BPM · ${sing.scale === 'minor' ? '小调' : '大调'}${shift}）。`);
    }
    return lines.join('\n');
  }
}
