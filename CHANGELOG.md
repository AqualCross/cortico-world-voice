## Unreleased

- 删除挂载时的 `audio.started` 事件及其声明；启动时不再推送通知。

## 0.1.0

- 首个版本：把「听、转写、说话、唱歌、变声、播放」收进一个 World，取代原来的 tts / stt / listen / audio-play 四个扩展。
- 本机引擎：GPT-SoVITS（说话）、SenseVoice 与 Paraformer 流式（转写）、DiffSinger 绮萱（唱歌）、RVC（变声）；
  说话/唱歌/变声的子进程按需启动、空闲退出。
- 听：系统环回 / 按应用 / 麦克风，能量门限、Silero、FireRed VAD 切分，FireRed AED 区分说话 / 唱歌 / 音乐；
  听到的话自动转成文字存进「记录 → 转写」，不落音频文件；「通知 Coo」按内核 debounce 合批唤醒。
- 配音输出：说话、变声、唱歌的成品都在 `audio/out/`，面板可试听、复制路径、逐条删除或清空。
- 依赖页一键获取：uv、ffmpeg、GPT-SoVITS 源码与权重、RVC 源码与资产、DiffSinger 声库与声码器、VAD 与识别模型；
  运行时与权重放部署根，数据在 `data/audio/`。
- 导航加了状态灯：听 / 说话 / 变声 / 唱歌各自可确认的状态（悬停说缺什么），开车时另有一个「在听 N 路」徽章；不展示依赖计数、档位这类技术细节。
- 说话 / 变声 / 唱歌都有 `silent`：不播放，完成事件带回本地路径 + Core 分配的音频附件句柄（`audio.say_done` / `audio.convert_done` / `audio.sing_done`）；播放、变声、转写也接受 `log:`/`mem:` 句柄作为输入。
- 工具全部非阻塞：`audio_say` 的 `silent` 与 `audio_transcribe` 也改为立刻回执，结果分别以 `audio.say_done` / `audio.transcribed` 事件带回（失败 `audio.say_failed` / `audio.transcribe_failed`）。
- 工具：`audio_status`、`audio_play`、`audio_say`、`audio_convert`、`audio_sing`、`audio_transcribe`、`audio_listen`、`audio_queue`；
  事件：`audio.started`、`audio.heard`、`audio.say_failed`、`audio.convert_failed`、`audio.sing_failed`。
