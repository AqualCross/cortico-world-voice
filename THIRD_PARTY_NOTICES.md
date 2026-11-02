# Third-party notices

- **audify** (MIT) — the native audio output used by `src/audio-out.ts`; ships
  [RtAudio](https://github.com/thestk/rtaudio) (BSD-3-Clause) internally.
- **diffsinger-utau** (MIT, PyPI) — the DiffSinger/OpenUtau inference library behind
  `python/diffsinger_worker.py`; it brings onnxruntime and torch itself.
- **ffmpeg** — not bundled. The player decodes through a local `ffmpeg.exe`
  (detected, or downloaded by the 依赖 page, BtbN's Windows build).
- Model files downloaded by the 依赖 page keep their upstream licenses:
  GPT-SoVITS (MIT), RVC assets (MIT), DiffSinger 绮萱声库 (see its bundled terms),
  Silero VAD (MIT), FireRedVAD (see upstream), sherpa-onnx SenseVoice/Moonshine exports.
# 音乐

- `src/music-abc/` 与 `src/webui/abc/` 迁自 [cortico-world-music-abc](https://github.com/AqualCross/cortico-world-music-abc)，MIT，Copyright (c) 2026 AqualCross。原许可与依赖许可在 `licenses/music-abc/`，详细来源见其中的 `THIRD_PARTY.md`。
- ABC 使用 abcjs 6.7.2（MIT）与 spessasynth_core 4.3.22（Apache-2.0）；浏览器产物保留 abcjs 与其内嵌 sprintf 的完整声明。GeneralUser GS 不随包附带，仅在用户点击获取后下载；元数据和原许可在 `assets/music-abc/`。
- 分离使用 [demucs-onnx 0.3.4](https://github.com/StemSplit/demucs-onnx)（MIT）与 [StemSplitio/htdemucs-onnx](https://huggingface.co/StemSplitio/htdemucs-onnx) 的 MIT 权重，原始模型来自 [Demucs](https://github.com/facebookresearch/demucs)（MIT）。源码包及模型下载固定版本并校验 SHA-256，源码包自带上游许可。独立 Python 推理环境使用 ONNX Runtime、NumPy、SoundFile 等默认依赖，不安装 PyTorch 或导出依赖；源码、环境与权重在用户点击获取后另行下载，不随 npm 包附带。混音和分离的音频解码使用本机 FFmpeg。
