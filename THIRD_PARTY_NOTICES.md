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
