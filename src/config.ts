import type { ConfigGroup } from 'cortico/core/types.ts';

export type SpeakEngine = 'gpt-sovits' | 'dashscope' | 'openai';
export type ConvertEngine = 'rvc';
export type SingEngine = 'diffsinger';
export type SttEngine = 'sensevoice' | 'moonshine' | 'dashscope' | 'dashscope-async' | 'openai';
/** 说话页的推理档：自动、CPU，或指定某张显卡（`gpu0`、`gpu1`…）。 */
export type Tier = 'auto' | 'cpu' | `gpu${number}`;

/** config.json 的 `worlds.audio` 段，默认禁用；bot 或部署可启用。 */
export interface AudioConfigSection {
  enabled: boolean;
  /** 本机 uv 的路径；留空按「PATH → 常见安装位置 → 自己装的那份」识别。 */
  uvPath: string;
  /** 本机 ffmpeg 的路径；留空同上。 */
  ffmpegPath: string;
  /** 播放音量，0–100；条目没单独指定时用它。 */
  volume: number;
  /** 桌面字幕层：说话时在屏幕上显示一条透明背景的字幕。 */
  subtitle: {
    enabled: boolean;
    /** 字号（px）。 */
    size: number;
    /** 文字颜色，#RRGGBB。 */
    color: string;
    /** 竖排位置。 */
    vertical: 'top' | 'middle' | 'bottom';
    /** 横向对齐。 */
    align: 'left' | 'center' | 'right';
  };
  speak: {
    engine: SpeakEngine;
    textLang: string;
    gptSovits: { tier: Tier; refAudio: string; refText: string; speed: number };
    dashscope: {
      baseUrl: string;
      model: string;
      voice: string;
      apiKeySecret: string;
      format: string;
      sampleRate: number;
      instruction: string;
      languageHints: string;
      /** -1 = 不固定种子。 */
      seed: number;
    };
    openai: {
      baseUrl: string;
      model: string;
      voice: string;
      apiKeySecret: string;
      format: string;
      sampleRate: number;
      languageHints: string;
    };
  };
  convert: {
    engine: ConvertEngine;
    model: string;
    pitch: number;
    indexRate: number;
    protect: number;
  };
  sing: {
    engine: SingEngine;
    voicebank: string;
    color: string;
    /** 默认速度（BPM）；每字时值按拍折算。 */
    bpm: number;
    /** 默认移调（半音，正数更高）。 */
    keyShift: number;
    /** 旋律调式：大调 / 小调；音高由程序按调式自动生成。 */
    scale: 'major' | 'minor';
    /** 旋律随机种子；0 = 按歌词固定（同一首词每次同一条旋律）。 */
    seed: number;
    /** 唱完再走一遍变声，用「变声」页选中的音色；默认关。 */
    convert: boolean;
  };
  listen: {
    /** 默认切分方式；每路可以单独覆盖（存在 lanes.json）。 */
    vad: {
      kind: string;
      /** 神经 VAD 的概率门限（0–1），只对 silero 有意义。 */
      threshold: number;
      /** 能量门限的 dBFS。 */
      thresholdDb: number;
      /** 连续过门限多久才算开口。 */
      minSpeechMs: number;
      /** 静多久算一句说完。 */
      minSilenceMs: number;
      /** 单块最长；到点强切。 */
      maxUtteranceMs: number;
      /** 短于这个的片段丢掉。 */
      minUtteranceMs: number;
    };
    /** 切分后自动转成文字。 */
    transcribe: boolean;
    /** 听到的内容：record 只归档；notify 交给内核 debounce 合批后唤醒。 */
    deliver: 'record' | 'notify';
    /** 块级细分：none 不区分；aed 区分音乐与人声（音乐只归档、不转写、不唤醒）。 */
    classify: 'none' | 'aed';
  };
  stt: {
    engine: SttEngine;
    langHint: string;
    /** 识别上下文（DashScope 非 qwen3 与 OpenAI 兼容会带上）。 */
    context: string;
    /** 采样率；0 = 由服务端判断。 */
    sampleRate: number;
    /** 单次请求的音频大小上限（MB）。 */
    maxMb: number;
    sensevoice: { modelDir: string };
    moonshine: { modelDir: string };
    dashscope: { baseUrl: string; model: string; apiKeySecret: string; itn: boolean; keepDialect: boolean };
    openai: { baseUrl: string; model: string; apiKeySecret: string };
  };
}

export const AUDIO_DEFAULTS: AudioConfigSection = {
  enabled: false,
  uvPath: '',
  ffmpegPath: '',
  volume: 80,
  subtitle: {
    enabled: true,
    size: 34,
    color: '#FFFFFF',
    vertical: 'bottom',
    align: 'center',
  },
  speak: {
    engine: 'gpt-sovits',
    textLang: 'auto',
    gptSovits: { tier: 'auto', refAudio: '', refText: '', speed: 1 },
    dashscope: {
      baseUrl: 'https://maas.qianwenaiapi.com',
      model: 'qwen-audio-3.1-tts-flash',
      voice: 'longanhuan_v3.1',
      apiKeySecret: 'AUDIO_API_KEY',
      format: 'wav',
      sampleRate: 24000,
      instruction: '',
      languageHints: '',
      seed: -1,
    },
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      apiKeySecret: 'OPENAI_API_KEY',
      format: 'wav',
      sampleRate: 0,
      languageHints: '',
    },
  },
  convert: {
    engine: 'rvc',
    model: '',
    pitch: 0,
    indexRate: 0.3,
    protect: 0.33,
  },
  sing: {
    engine: 'diffsinger',
    voicebank: '',
    color: '',
    bpm: 96,
    keyShift: 0,
    scale: 'major',
    seed: 0,
    convert: false,
  },
  listen: {
    vad: {
      kind: 'silero',
      threshold: 0.5,
      thresholdDb: -42,
      minSpeechMs: 250,
      minSilenceMs: 400,
      maxUtteranceMs: 15000,
      minUtteranceMs: 400,
    },
    transcribe: true,
    deliver: 'record',
    classify: 'none',
  },
  stt: {
    engine: 'sensevoice',
    langHint: '',
    context: '',
    sampleRate: 0,
    maxMb: 10,
    sensevoice: { modelDir: '' },
    moonshine: { modelDir: '' },
    dashscope: { baseUrl: 'https://dashscope.aliyuncs.com', model: 'qwen3-asr-flash', apiKeySecret: 'AUDIO_API_KEY', itn: false, keepDialect: false },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', apiKeySecret: 'OPENAI_API_KEY' },
  },
};

const K = 'worlds.audio';

/**
 * `worlds.audio` 的配置键声明：面板写回时按这里的类型与取值区间验收。
 * 不挂到框架配置页；每个键都由「说话」「听」「播放」页各管一段。
 */
export const AUDIO_CONFIG_GROUP: ConfigGroup = {
  id: 'world:audio',
  owner: 'world:audio',
  schema: {
    type: 'object',
    title: '声音',
    description: '说话、变声、唱歌三组设置；引擎不同，用到的字段也不同。',
    properties: {
      [`${K}.uvPath`]: {
        type: 'string',
        title: 'uv 路径',
        description: '留空自动识别本机 uv；填了就用这一份。',
        'x-path': { kind: 'file', extensions: ['.exe'] },
        'x-hot': true,
      },
      [`${K}.ffmpegPath`]: {
        type: 'string',
        title: 'ffmpeg 路径',
        description: '留空自动识别本机 ffmpeg；填了就用这一份。',
        'x-path': { kind: 'file', extensions: ['.exe'] },
        'x-hot': true,
      },
      [`${K}.volume`]: {
        type: 'number',
        title: '音量',
        description: '播放队列的默认音量（0–100）。',
        minimum: 0,
        maximum: 100,
        multipleOf: 1,
        'x-hot': true,
      },
      [`${K}.subtitle.enabled`]: {
        type: 'boolean',
        title: '桌面字幕',
        description: '播放合成语音时，在屏幕上显示一条透明背景的字幕；窗口点击穿透，不进任务栏。',
        'x-hot': true,
      },
      [`${K}.subtitle.size`]: {
        type: 'number',
        title: '字幕字号',
        description: '字幕字号（px）；窗口高度随字号变化。',
        minimum: 12,
        maximum: 96,
        multipleOf: 1,
        'x-hot': true,
      },
      [`${K}.subtitle.color`]: {
        type: 'string',
        title: '字幕颜色',
        description: '#RRGGBB，例如 #FFFFFF；文字带黑色投影，浅色字在亮背景上也读得清。',
        'x-hot': true,
      },
      [`${K}.subtitle.vertical`]: {
        type: 'string',
        title: '字幕位置（上下）',
        description: '贴顶、居中，还是贴底。',
        enum: ['top', 'middle', 'bottom'],
        'x-hot': true,
      },
      [`${K}.subtitle.align`]: {
        type: 'string',
        title: '字幕位置（左右）',
        description: '左对齐、居中还是右对齐。',
        enum: ['left', 'center', 'right'],
        'x-hot': true,
      },

      [`${K}.speak.engine`]: {
        type: 'string',
        title: '说话引擎',
        description: '本地 gpt-sovits，或走 HTTP 的 dashscope / openai。切换后只用到对应那一组字段。',
        'x-options': 'audio-speak-engine',
        'x-hot': true,
      },
      [`${K}.speak.textLang`]: {
        type: 'string',
        title: '台词语言',
        description: '交结合成时的语言；auto 逐段判断。',
        'x-options': 'audio-lang',
        'x-hot': true,
      },
      [`${K}.speak.gptSovits.tier`]: {
        type: 'string',
        title: '推理档',
        description: 'auto 按显存选；也可以指定 CPU 或某张显卡。',
        'x-options': 'audio-tier',
        'x-hot': true,
      },
      [`${K}.speak.gptSovits.refAudio`]: {
        type: 'string',
        title: '参考音频',
        description: '3–10 秒的 WAV，音色与它一致。',
        'x-path': { kind: 'file', extensions: ['.wav'] },
        'x-hot': true,
      },
      [`${K}.speak.gptSovits.refText`]: {
        type: 'string',
        title: '参考台本',
        description: '参考音频里说的那句话。',
        'x-hot': true,
      },
      [`${K}.speak.gptSovits.speed`]: {
        type: 'number',
        title: '语速',
        description: '1 为原速。',
        minimum: 0.5,
        maximum: 2,
        multipleOf: 0.05,
        'x-hot': true,
      },
      [`${K}.speak.dashscope.baseUrl`]: {
        type: 'string',
        title: 'DashScope 地址',
        description: '默认 https://maas.qianwenaiapi.com（千问AI平台，官方入口）；经典 DashScope 填 https://dashscope.aliyuncs.com，按 API Key 属于哪边选。',
        'x-hot': true,
      },
      [`${K}.speak.dashscope.format`]: {
        type: 'string',
        title: '音频格式',
        description: 'wav / mp3 / ogg / opus / pcm，随服务而定。',
        'x-options': 'audio-tts-format-dashscope',
        'x-hot': true,
      },
      [`${K}.speak.dashscope.sampleRate`]: {
        type: 'number',
        title: '采样率',
        description: 'Hz；0 不发。',
        minimum: 0,
        maximum: 48000,
        multipleOf: 1000,
        'x-hot': true,
      },
      [`${K}.speak.dashscope.instruction`]: {
        type: 'string',
        title: '默认指令',
        description: '情绪、方言、角色等；工具参数可临时覆盖。',
        'x-hot': true,
      },
      [`${K}.speak.dashscope.languageHints`]: {
        type: 'string',
        title: '语言提示',
        description: '逗号分隔；留空不发。',
        'x-hot': true,
      },
      [`${K}.speak.dashscope.seed`]: {
        type: 'number',
        title: '随机种子',
        description: '0–65535；-1 表示不固定。',
        minimum: -1,
        maximum: 65535,
        multipleOf: 1,
        'x-hot': true,
      },
      [`${K}.speak.openai.format`]: {
        type: 'string',
        title: '音频格式',
        description: 'mp3 / wav / ogg；服务端不认识的值会退回 mp3。',
        'x-options': 'audio-tts-format-openai',
        'x-hot': true,
      },
      [`${K}.speak.openai.sampleRate`]: {
        type: 'number',
        title: '采样率',
        description: 'Hz；0 不发。',
        minimum: 0,
        maximum: 48000,
        multipleOf: 1000,
        'x-hot': true,
      },
      [`${K}.speak.openai.languageHints`]: {
        type: 'string',
        title: '语言提示',
        description: '取第一个并转成 lang（只认 ZH / EN / JA / ES / AR）。',
        'x-hot': true,
      },
      [`${K}.speak.dashscope.model`]: {
        type: 'string',
        title: '模型',
        description: '例如 qwen-tts。',
        'x-hot': true,
      },
      [`${K}.speak.dashscope.voice`]: {
        type: 'string',
        title: '音色',
        description: '例如 Cherry。',
        'x-hot': true,
      },
      [`${K}.speak.dashscope.apiKeySecret`]: {
        type: 'string',
        title: '密钥变量名',
        description: '部署 .env 里的变量名；密钥本身在「说话」页填。',
        'x-hot': true,
      },
      [`${K}.speak.openai.baseUrl`]: {
        type: 'string',
        title: '接口地址',
        description: 'OpenAI 兼容的 base，例如 https://api.openai.com/v1。',
        'x-hot': true,
      },
      [`${K}.speak.openai.model`]: {
        type: 'string',
        title: '模型',
        description: '例如 gpt-4o-mini-tts。',
        'x-hot': true,
      },
      [`${K}.speak.openai.voice`]: {
        type: 'string',
        title: '音色',
        description: '例如 alloy。',
        'x-hot': true,
      },
      [`${K}.speak.openai.apiKeySecret`]: {
        type: 'string',
        title: '密钥变量名',
        description: '部署 .env 里的变量名；密钥本身在「说话」页填。',
        'x-hot': true,
      },

      [`${K}.convert.engine`]: {
        type: 'string',
        title: '变声引擎',
        description: '目前只有本机 RVC。',
        'x-options': 'audio-convert-engine',
        'x-hot': true,
      },
      [`${K}.convert.model`]: {
        type: 'string',
        title: '音色文件',
        description: 'RVC 的 .pth；同目录有同名 .index 时一并使用。',
        'x-path': { kind: 'file', extensions: ['.pth'] },
        'x-hot': true,
      },
      [`${K}.convert.pitch`]: {
        type: 'number',
        title: '变调',
        description: '半音，男声转女声常用 +12。',
        minimum: -24,
        maximum: 24,
        multipleOf: 1,
        'x-hot': true,
      },
      [`${K}.convert.indexRate`]: {
        type: 'number',
        title: '索引率',
        description: '0 不用索引，1 全用。',
        minimum: 0,
        maximum: 1,
        multipleOf: 0.01,
        'x-hot': true,
      },
      [`${K}.convert.protect`]: {
        type: 'number',
        title: '保护清辅音',
        description: '0–0.5，越大越保守。',
        minimum: 0,
        maximum: 0.5,
        multipleOf: 0.01,
        'x-hot': true,
      },

      [`${K}.sing.engine`]: {
        type: 'string',
        title: '唱歌引擎',
        description: '目前只有本机 DiffSinger。',
        'x-options': 'audio-sing-engine',
        'x-hot': true,
      },
      [`${K}.sing.voicebank`]: {
        type: 'string',
        title: '声库',
        description: '声库目录名；留空用依赖页装的那一套。',
        'x-hot': true,
      },
      [`${K}.sing.color`]: {
        type: 'string',
        title: '音色',
        description: '声库里的音色名，例如 Normal / Soft；留空用默认。',
        'x-hot': true,
      },
      [`${K}.sing.bpm`]: {
        type: 'number',
        title: '默认速度（BPM）',
        description: '60–200；每个字按拍折算时值。',
        minimum: 60,
        maximum: 200,
        multipleOf: 1,
        'x-hot': true,
      },
      [`${K}.sing.keyShift`]: {
        type: 'number',
        title: '默认移调（半音）',
        description: '−12–12，正数更高；绮萱是女声，一般 0 到 +4。',
        minimum: -12,
        maximum: 12,
        multipleOf: 1,
        'x-hot': true,
      },
      [`${K}.sing.scale`]: {
        type: 'string',
        title: '默认调式',
        description: 'major 明亮、minor 忧郁；旋律由程序自动生成。',
        'x-options': 'audio-sing-scale',
        'x-hot': true,
      },
      [`${K}.sing.seed`]: {
        type: 'integer',
        title: '旋律种子',
        description: '0 = 按歌词固定；填别的数会换一条旋律。',
        minimum: 0,
        maximum: 99999999,
        'x-hot': true,
      },
      [`${K}.sing.convert`]: {
        type: 'boolean',
        title: '唱完变声',
        description: '唱完再过一遍「变声」页的 RVC 音色；多一趟推理，默认关。',
        'x-hot': true,
      },

      [`${K}.listen.vad.kind`]: {
        type: 'string',
        title: '处理方式',
        description: 'energy 只看音量；silero 是神经 VAD，音乐里更稳。',
        'x-options': 'audio-vad',
        'x-hot': true,
      },
      [`${K}.listen.vad.threshold`]: {
        type: 'number',
        title: 'VAD 阈值',
        description: '0–1，只对 silero 有意义；越高越不容易把人声切进来。',
        minimum: 0,
        maximum: 1,
        multipleOf: 0.01,
        'x-hot': true,
      },
      [`${K}.listen.vad.thresholdDb`]: {
        type: 'number',
        title: '能量门限（dBFS）',
        description: '只对 energy 有意义；-42 左右适合一般环境，越接近 0 越挑剔。',
        minimum: -80,
        maximum: -10,
        multipleOf: 1,
        'x-hot': true,
      },
      [`${K}.listen.vad.minSpeechMs`]: {
        type: 'number',
        title: '最短语音',
        description: '连续多响才算开口（毫秒）；太小会把敲键盘切进来。',
        minimum: 50,
        maximum: 2000,
        multipleOf: 10,
        'x-hot': true,
      },
      [`${K}.listen.vad.minSilenceMs`]: {
        type: 'number',
        title: '最短静音',
        description: '静多久算一句说完（毫秒）。',
        minimum: 100,
        maximum: 5000,
        multipleOf: 50,
        'x-hot': true,
      },
      [`${K}.listen.vad.maxUtteranceMs`]: {
        type: 'number',
        title: '最长一句',
        description: '连续音源到点强切（毫秒）。',
        minimum: 2000,
        maximum: 120000,
        multipleOf: 500,
        'x-hot': true,
      },
      [`${K}.listen.vad.minUtteranceMs`]: {
        type: 'number',
        title: '最短片段',
        description: '短于这个的片段直接丢掉（毫秒）。',
        minimum: 100,
        maximum: 5000,
        multipleOf: 50,
        'x-hot': true,
      },
      [`${K}.listen.transcribe`]: {
        type: 'boolean',
        title: '切分后转成文字',
        description: '每块都走「听」页选的转写引擎；关掉就只存档音频。',
        'x-hot': true,
      },
      [`${K}.listen.deliver`]: {
        type: 'string',
        title: '听到之后',
        description: '只归档不打扰；送达按内核 debounce 合批，几句会在同一次唤醒里一起给到模型。',
        'x-options': 'audio-listen-deliver',
        'x-hot': true,
      },
      [`${K}.listen.classify`]: {
        type: 'string',
        title: '细分方式',
        description: 'none 不区分；aed 用 FireRed AED 区分说话 / 唱歌 / 音乐，音乐块只归档、不转写、不唤醒。',
        'x-options': 'audio-classify',
        'x-hot': true,
      },

      [`${K}.stt.engine`]: {
        type: 'string',
        title: '转文本引擎',
        description: '本地 sherpa 模型，或走 HTTP 的 DashScope / OpenAI 兼容。',
        'x-options': 'audio-stt-engine',
        'x-hot': true,
      },
      [`${K}.stt.langHint`]: {
        type: 'string',
        title: '语言提示',
        description: '可选，例如 zh 或 zh,en；留空自动识别。',
        'x-hot': true,
      },
      [`${K}.stt.context`]: {
        type: 'string',
        title: '识别上下文',
        description: '可选：给识别器一点背景（DashScope 非 qwen3 与 OpenAI 兼容会带上）。',
        'x-hot': true,
      },
      [`${K}.stt.sampleRate`]: {
        type: 'number',
        title: '采样率',
        description: '0 = 由服务端判断；DashScope 非 qwen3 模型会带上。',
        minimum: 0,
        maximum: 48000,
        multipleOf: 1000,
        'x-hot': true,
      },
      [`${K}.stt.maxMb`]: {
        type: 'number',
        title: '单次上限（MB）',
        description: '超过就本地直接拒绝，不发请求。',
        minimum: 1,
        maximum: 50,
        multipleOf: 1,
        'x-hot': true,
      },
      [`${K}.stt.sensevoice.modelDir`]: {
        type: 'string',
        title: 'SenseVoice 目录',
        description: '留空用依赖页装的那一套。',
        'x-path': { kind: 'directory' },
        'x-hot': true,
      },
      [`${K}.stt.moonshine.modelDir`]: {
        type: 'string',
        title: 'Moonshine 目录',
        description: '留空用依赖页装的那一套。',
        'x-path': { kind: 'directory' },
        'x-hot': true,
      },
      [`${K}.stt.dashscope.baseUrl`]: {
        type: 'string',
        title: 'DashScope 地址',
        description: '默认北京地域；新加坡地域填 dashscope-intl.aliyuncs.com，异步转写可能要用工作空间地址。',
        'x-hot': true,
      },
      [`${K}.stt.dashscope.model`]: {
        type: 'string',
        title: '模型',
        description: '例如 qwen3-asr-flash；文件转写填带 -filetrans 的模型名。',
        'x-hot': true,
      },
      [`${K}.stt.dashscope.itn`]: {
        type: 'boolean',
        title: '数字/日期规范化',
        description: '仅 qwen3-asr-*：把口语数字转成阿拉伯数字。',
        'x-hot': true,
      },
      [`${K}.stt.dashscope.keepDialect`]: {
        type: 'boolean',
        title: '保留方言',
        description: '仅 qwen-audio-3.x：方言按原样转写。',
        'x-hot': true,
      },
      [`${K}.stt.dashscope.apiKeySecret`]: {
        type: 'string',
        title: '密钥变量名',
        description: '部署 .env 里的变量名；密钥本身在「听」页填。',
        'x-hot': true,
      },
      [`${K}.stt.openai.baseUrl`]: {
        type: 'string',
        title: '接口地址',
        description: 'OpenAI 兼容的 base。',
        'x-hot': true,
      },
      [`${K}.stt.openai.model`]: {
        type: 'string',
        title: '模型',
        description: '例如 whisper-1。',
        'x-hot': true,
      },
      [`${K}.stt.openai.apiKeySecret`]: {
        type: 'string',
        title: '密钥变量名',
        description: '部署 .env 里的变量名；密钥本身在「听」页填。',
        'x-hot': true,
      },
    },
  },
};
