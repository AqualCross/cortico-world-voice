## 0.1.2

- 新增「音乐」页，下设「分离」「混音」「ABC」「记录」：Demucs ONNX 人声/伴奏分离（有 NVIDIA 显卡时默认走 CUDA，执行器起不来时回退 CPU）、多轨音量与延迟混音、从 ABC 音乐扩展迁入的乐谱编辑、试听、作品与音源管理，以及汇总分离与混音成品的「记录」页。
- 新增 `audio_separate`、`audio_mix`，迁入 `audio_abc_music_score`、`audio_abc_music_play`、`audio_abc_music_control`；音乐事件使用 `audio.separated`、`audio.mixed`、`audio.abc_played`。
- 变声长音频自动分段：超过 90 秒按 90 秒一片、相邻 2 秒重叠送 RVC，转换后交叉淡化拼回原时长，不再需要手动切片。
- 依赖页给本扩展装过的项目加了「卸载」按钮，确认后停掉占用文件的子进程并删除部署目录里的源码、环境、权重或模型；系统里已有的 uv / ffmpeg、用户导入的音色与声库、已生成的音频都不动。
- 「工具」页为每个工具增加模型可见性开关，按部署保存；`audio_listen` 默认关闭，用户可自行开启，恢复默认后再次关闭。关闭项从工具表移除，保存后提示重载系统前缀。
- 修复依赖安装：uv 的工作目录不存在时不再误报「uv 没装」；HTTP 超时放宽到 60 秒；失败信息去掉 ANSI 与进度残片，并按源保留完整输出；识别环境按实际依赖自检，不再统一 import `sherpa_onnx`。
- 收紧扩展自身的网络与下载：不再改写宿主进程的代理环境变量，代理只按请求用于本扩展的请求；uv 固定 0.13.6、ffmpeg 固定 BtbN 构建，下载后校验大小与 SHA-256 再解压执行。

## 0.1.1

- 事件统一按 `external` 投递；说话、转写、变声和唱歌的后台失败事件统一为 `audio.failed`。
- 删除挂载时的 `audio.started` 事件及其声明。

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
