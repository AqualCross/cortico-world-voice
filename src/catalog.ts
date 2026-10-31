/**
 * 钉住的上游资产：GPT-SoVITS 的源码版本与各档权重。
 * 只写上游（RVC-Boss/GPT-SoVITS、lj1995 的模型仓库、魔搭上的上游镜像）的地址；
 * 目标是本包自己维护的依赖，不依赖其他插件的发布物。
 */
import type { Tier } from './gpu.ts';

/** 上游 commit（推理代码）。升级时同时改这里与 SHORT。 */
export const GPT_SOVITS_COMMIT = 'e91506f1fba265e1841617c3042a1573206a7351';
export const GPT_SOVITS_SHORT = 'e91506f-1';

/** 源码压缩包；镜像在前，GitHub 原站最后。 */
export const PROJECT_SOURCES: readonly string[] = [
  `https://ghfast.top/https://github.com/RVC-Boss/GPT-SoVITS/archive/${GPT_SOVITS_COMMIT}.zip`,
  `https://gh-proxy.com/https://github.com/RVC-Boss/GPT-SoVITS/archive/${GPT_SOVITS_COMMIT}.zip`,
  `https://github.com/RVC-Boss/GPT-SoVITS/archive/${GPT_SOVITS_COMMIT}.zip`,
];

export interface PinnedFile {
  /** 落盘相对路径（相对权重根）。 */
  path: string;
  bytes: number;
  sha256: string;
  sources: readonly string[];
}

const MS_UP = 'https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/pretrained_models';
const HF_MIRROR = 'https://hf-mirror.com/lj1995/GPT-SoVITS/resolve/main';
const HF = 'https://huggingface.co/lj1995/GPT-SoVITS/resolve/main';

/** 上游两个仓库里同一路径的文件：魔搭优先，其次 hf-mirror，最后官方 HF。 */
const upstream = (path: string, bytes: number, sha256: string): PinnedFile => ({
  path, bytes, sha256, sources: [`${MS_UP}/${path}`, `${HF_MIRROR}/${path}`, `${HF}/${path}`],
});

/** V5 权重在上游魔搭还没有，只有 HF 系；镜像优先。 */
const v5 = (path: string, bytes: number, sha256: string): PinnedFile => ({
  path, bytes, sha256, sources: [`${HF_MIRROR}/${path}`, `${HF}/${path}`],
});

/** 两个版本共用的文本与参考音频特征模型。 */
const SHARED: readonly PinnedFile[] = [
  upstream('s1v3.ckpt', 155284856, '87133414860ea14ff6620c483a3db5ed07b44be42e2c3fcdad65523a729a745a'),
  upstream('chinese-hubert-base/config.json', 1449, 'c3e5060a1277e0f078cc6be9da4528a605dba6ece93018981fe2c820e5c7b103'),
  upstream('chinese-hubert-base/preprocessor_config.json', 212, 'dcd684124d06722947939d41ea6ae58dbf10968c60a11a29f23ddc602c64a29b'),
  upstream('chinese-hubert-base/pytorch_model.bin', 188811417, '24164f129c66499d1346e2aa55f183250c223161ec2770c0da3d3b08cf432d3c'),
  upstream('chinese-roberta-wwm-ext-large/config.json', 963, '3d57de2fd7e80d0e5c8ff194f0bbb6baa10df7e43fc262a0cc71298a78b0a3e5'),
  upstream('chinese-roberta-wwm-ext-large/pytorch_model.bin', 651225145, 'e53a693acc59ace251d143d068096ae0d7b79e4b1b503fa84c9dcf576448c1d8'),
  upstream('chinese-roberta-wwm-ext-large/tokenizer.json', 268962, '173796956820ea27bd14f76bf28162607ff4254807e2948253eb5b46f5bb643b'),
  upstream('fast_langdetect/lid.176.bin', 131266198, '7e69ec5451bc261cc7844e49e4792a85d7f09c06789ec800fc4a44aec362764e'),
];

/** 每档用哪个版本、哪两个权重文件（相对权重根）；api_v2 的 tts_infer.yaml 照这个写。 */
export const TIER_SPECS: Readonly<Record<Tier, { version: string; t2sWeights: string; vitsWeights: string }>> = {
  cuda: { version: 'v5turbo', t2sWeights: 's1v3.ckpt', vitsWeights: 'gsv-v5-pretrained/s2Gv5turbo.pth' },
  cpu: { version: 'v2ProPlus', t2sWeights: 's1v3.ckpt', vitsWeights: 'v2Pro/s2Gv2ProPlus.pth' },
};

/**
 * torch 的轮子源：CUDA 档用 cu128，CPU 档用 cpu。
 * 南大镜像与官方站是同一套目录（PyPI 上的 Windows torch 只有 CPU 版，cu128 只在官方轮子源里），
 * 官方站直连只有 0.1 MB/s、走代理也只有 0.2–0.9 MB/s，镜像实测 7–8 MB/s；镜像失效再退回官方。
 * 版本钉死 2.7.1：torchaudio 2.9 起把解码交给 torchcodec（它跟 torch 版本强绑），2.7.1 仍然自带原生解码，
 * 也是上游 Windows 安装清单里测试过的那一对。
 */
const TORCH_MIRROR = 'https://mirror.nju.edu.cn/pytorch/whl';

export const TORCH_SOURCE: Readonly<Record<Tier, { indexes: readonly string[]; packages: readonly string[] }>> = {
  cuda: { indexes: [`${TORCH_MIRROR}/cu128`, 'https://download.pytorch.org/whl/cu128'], packages: ['torch==2.7.1', 'torchaudio==2.7.1'] },
  cpu: { indexes: [`${TORCH_MIRROR}/cpu`, 'https://download.pytorch.org/whl/cpu'], packages: ['torch==2.7.1', 'torchaudio==2.7.1'] },
};

/**
 * 装 requirements 之前先补的一批：上游 requirements.txt 在 Windows 上不完整或不可用。
 * - pyopenjtalk / jieba_fast：PyPI 只有源码，没有 MSVC 就编译不了，用上游 Windows 清单指向的魔搭预编译轮子；
 * - opencc：requirements 里的 `--no-binary=opencc` 会逼它源码编译，先按普通包装上（PyPI 有 win 轮子）；
 * - resampy / soundfile：上游 Windows 清单里有、通用 requirements 没有，缺了 /tts 会直接报 No module。
 */
export const WINDOWS_PREBUILT: readonly string[] = [
  'https://modelscope.cn/models/FlowerCry/gpt-sovits-7z-pacakges/resolve/master/wheels/cu128/pyopenjtalk-0.4.1-cp312-cp312-win_amd64.whl#sha256=54199f8427ad91528e3adb03d3910ad79af109420cac819548b16592ce3960f0',
  'https://modelscope.cn/models/FlowerCry/gpt-sovits-7z-pacakges/resolve/master/wheels/cu128/jieba_fast-0.53-cp312-cp312-win_amd64.whl#sha256=d59bc49c0bf1be2f20d0066ffa53e18bccba39f310bde7e470564d0165dc250b',
  'opencc',
  'resampy',
  'soundfile',
];

/** 每档要用哪一套 SoVITS 权重。 */
export const TIER_WEIGHTS: Readonly<Record<Tier, readonly PinnedFile[]>> = {
  cuda: [
    ...SHARED,
    v5('gsv-v5-pretrained/s2Gv5turbo.pth', 766406144, '287b32a06b7d486f5303ec520468b0728fb01aac8b0f5d86fd5455c9a1d3e022'),
    v5('gsv-v5-pretrained/vocoder.pth', 57761163, 'b7543c83222aa2105bb4efb56845086bc5f2eeba61243d723ffa062052b3221f'),
  ],
  cpu: [
    ...SHARED,
    upstream('v2Pro/s2Gv2ProPlus.pth', 200125741, 'd42a22bbbf65fb2bbdd45ad6a66841156977db45c7aabe0a6992ff378d9c7d3b'),
    upstream('sv/pretrained_eres2netv2w24s4ep4.ckpt', 107528697, '4f5a0bf73c61eb41b174e1bb54e7ee3c83233892be8e0af1f187024e8e581a35'),
  ],
};

// ---------------------------------------------------------------- RVC

/** RVC 上游：推理代码 + 两个资产（ContentVec、F0 提取器）。 */
export const RVC_COMMIT = '81eed5e8f68b6bed1789f682fe78cdd324495afc';
export const RVC_PROJECT_SOURCES: readonly string[] = [
  `https://ghfast.top/https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/archive/${RVC_COMMIT}.zip`,
  `https://gh-proxy.com/https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/archive/${RVC_COMMIT}.zip`,
  `https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/archive/${RVC_COMMIT}.zip`,
];

const HF_UP = 'lj1995/VoiceConversionWebUI/resolve/main';
const rvcAsset = (path: string, remote: string, bytes: number, sha256: string): PinnedFile => ({
  path,
  bytes,
  sha256,
  sources: [`https://hf-mirror.com/${HF_UP}/${remote}`, `https://huggingface.co/${HF_UP}/${remote}`],
});

/** 落到 `<模型根>/audio/rvc/`。音色（.pth/.index）由用户自备。 */
export const RVC_ASSETS: readonly PinnedFile[] = [
  rvcAsset('hubert_base/config.json', 'hubert_base/config.json', 1492, '0346950779dfb7f9316fa74ed846e2b8a22a08eedfdc5387b73f327cb1a4a7cf'),
  rvcAsset('hubert_base/preprocessor_config.json', 'hubert_base/preprocessor_config.json', 225, '7c1976a680fb7acc757cd36fb08eef878fa36c70b4c9d2d595df9c608bbbbf0e'),
  rvcAsset('hubert_base/pytorch_model.bin', 'hubert_base/pytorch_model.bin', 189206711, 'cc8c20f4b90a520757260197a3ff2505705a7adbd20ad9eeaa4e1a9b38442ef5'),
  rvcAsset('rmvpe/rmvpe.pt', 'rmvpe.pt', 181184272, '6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193'),
];

/**
 * 推理用到的依赖。只装变声需要的那几样：上游清单里的 gradio、onnxruntime 等属于它自己的
 * WebUI/训练入口，这里从不起它们。torch 由档位单装，不在这份清单里。
 */
export const RVC_PACKAGES: readonly string[] = [
  'numpy>=1.26.4,<2',
  'soundfile>=0.13.0,<1',
  'librosa>=0.10.2,<0.11',
  'faiss-cpu>=1.13.0,<2',
  'praat-parselmouth>=0.4.5,<1',
  'scipy>=1.13.1,<2',
  'transformers>=4.49.0,<4.50',
  'ffmpeg-python>=0.2.0,<1',
  'av>=15.1.0,<16',
];


// ---------------------------------------------------------------- DiffSinger

/** 绮萱声库（v2.7.0，OpenUTAU 版，ONNX）与社区声码器；解压后落在 `<模型根>/audio/singer/`。 */
export const SINGER_VOICEBANK_NAME = 'Qixuan_v2.7.0_DiffSinger_OpenUtau';
export const SINGER_VOCODER_NAME = 'pc_nsf_hifigan_44.1k_hop512_128bin_2025.02';

const viaGh = (url: string): string[] => [
  `https://ghfast.top/${url}`,
  `https://gh-proxy.com/${url}`,
  url,
];

export const SINGER_VOICEBANK: PinnedFile = {
  path: `${SINGER_VOICEBANK_NAME}.zip`,
  bytes: 420_707_627,
  sha256: 'fe8ee7c95883d327a2b7facbbe832a7a53e1344918dc791ca83fc23b08034110',
  sources: viaGh('https://github.com/yqzhishen/qixuan-diffsinger/releases/download/v2.7.0/Qixuan_v2.7.0_DiffSinger_OpenUtau.zip'),
};

export const SINGER_VOCODER: PinnedFile = {
  path: `${SINGER_VOCODER_NAME}.oudep`,
  bytes: 52_760_610,
  sha256: 'ba7d43142d41f6900c8264b5662ca7125a50feb8760bb8b9615c61a8f5e6902e',
  sources: viaGh('https://github.com/openvpi/vocoders/releases/download/pc-nsf-hifigan-44.1k-hop512-128bin-2025.02/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02.oudep'),
};

/** 装好的判定：声库主配置（递归找）。 */
export const SINGER_MARKER = 'dsconfig.yaml';
export const SINGER_VOCODER_MARKER = 'dsvocoder/vocoder.yaml';

/**
 * 唱歌推理依赖（PyPI，MIT，独立于第三方插件的实现）：载声库、跑五段 onnx 推理、出 wav。
 * 它自带 torch / onnxruntime / librosa / pypinyin，够了。
 */
export const SING_PACKAGES: readonly string[] = ['diffsinger-utau==0.3.8'];

// ---------------------------------------------------------------- 听：VAD 与语音识别模型

/** Silero VAD（MIT，约 0.6 MB）；上游只按 release 文件名给，没有钉大小。 */
/** Silero VAD（MIT，约 0.6 MB）；GitHub 走代理，原站最后。 */
export const SILERO_VAD_SOURCES: readonly string[] = [
  'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
];

/** sherpa-onnx 形式的本地识别模型；魔搭优先，HF 兜底。 */
const sherpa = (path: string, bytes: number, sha256: string, ms: string, hf: string): PinnedFile => ({
  path,
  bytes,
  sha256,
  sources: [`https://modelscope.cn/models/${ms}/resolve/master/${path}`, `https://huggingface.co/${hf}/resolve/main/${path}`],
});

/** FunASR SenseVoiceSmall（int8，Apache-2.0 导出）。 */
export const SENSEVOICE_FILES: readonly PinnedFile[] = [
  sherpa('model.int8.onnx', 239_233_841, 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51', 'pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue', 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'),
  sherpa('tokens.txt', 315_894, 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc', 'pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue', 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'),
];

/** Paraformer 中英流式（int8，sherpa-onnx 导出，MIT）。
 * 镜像接口不返回 sha256，这批只钉大小。 */
const paraformer = (path: string, bytes: number): PinnedFile => ({
  path,
  bytes,
  sha256: '',
  sources: [
    `https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/${path}`,
    `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/${path}`,
  ],
});

export const PARAFORMER_FILES: readonly PinnedFile[] = [
  paraformer('encoder.int8.onnx', 165_462_184),
  paraformer('decoder.int8.onnx', 71_664_561),
  paraformer('tokens.txt', 75_756),
];

/** FireRed VAD：官方仓库里的流式 ONNX 模型 + CMVN（Apache-2.0，约 2.3 MB）。
 * 只钉大小，镜像不返回 sha256。 */
const firered = (path: string, bytes: number): PinnedFile => ({
  path,
  bytes,
  sha256: '',
  sources: [
    `https://gh-proxy.com/https://raw.githubusercontent.com/FireRedTeam/FireRedVAD/main/pretrained_models/onnx_models/${path}`,
    `https://ghfast.top/https://raw.githubusercontent.com/FireRedTeam/FireRedVAD/main/pretrained_models/onnx_models/${path}`,
    `https://raw.githubusercontent.com/FireRedTeam/FireRedVAD/main/pretrained_models/onnx_models/${path}`,
  ],
});

export const FIRERED_VAD_FILES: readonly PinnedFile[] = [
  firered('fireredvad_stream_vad_with_cache.onnx', 2_306_042),
  firered('fireredvad_aed.onnx', 2_390_544),
  firered('cmvn.ark', 1_311),
];
