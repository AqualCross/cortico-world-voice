## 0.1.16

- 修复 ffmpeg 下载 404：BtbN 的 autobuild 只保留最近几天，原先钉死的 `autobuild-2026-11-01-12-49` 已被上游清理。改用 `latest` 标签下资产名固定的 `ffmpeg-master-latest-win64-gpl.zip`，下载前从同一 release 的 `checksums.sha256` 现取 SHA-256 校验；镜像顺序不变。
- 版本号提到 0.1.16：面板 bundle 的 URL 带版本且按 immutable 缓存，旧版本号会让宿主继续用缓存的 `webui.js`。

## 0.1.15（实验版）

- ABC 音乐加入自动伴奏：`off`（只标注）、`abcjs`（简单低音+和弦）、`band`（compose 式完整编曲：和弦、贝斯、鼓、过门/停顿、swing、人性化、每角色混音）。`band` 支持 pop、rock、ballad、bossa、samba、swing、waltz、funk、lofi、dance、ambient，`energy` 1–5 控制密度，`sections` 可按小节覆盖律动/能量、`stopBars` 让乐队给一下再停。写谱与乐谱版本不变，伴奏只影响渲染出的 MIDI/WAV。默认 `off`。
- 「作曲」和「编曲」页都增加「导出 MIDI」：按当前谱子和编曲设置即时生成并下载，不落 MIDI 文件。
- 作曲页只负责写谱/检查/保存，不再重复放自动伴奏、律动、能量控件；伴奏统一在「编曲」页设置。作曲页的试听/生成作品沿用已保存的编曲设置。
- 音乐页改为一级页签：分离、混音、作曲、编曲、音源、记录。原「乐谱」更名「作曲」，原「乐器」更名「音源」；「作品」并入「记录」，与分离/混音的作品同页、同一卡片格式。作曲记录只保留 WAV：不再保存谱面快照、MIDI/ABC 文件，也不再提供快照、MIDI/ABC 下载、打开文件夹或刷新按钮。编曲页保留选曲、自动伴奏、律动、能量、分段 JSON、试听、生成作品和保存编曲。
- 新增 `audio_open`：用系统默认播放器打开音频文件（不走播放队列）。
- ABC 渲染回执带测量事实：小节、声部音域、超域音、重复/节奏、级进/跳进、和弦冲突音，以及成品 RMS/峰值；`check` 在渲染前就能返回结构事实。和弦冲突音只报长音/强拍音里真正冲突的调外音，调内的 9/11/13 度张力不再误报。
- ABC 支持动机宏：`% motif 名字: ...` 定义，`@名字` / `@名字+1` / `@名字-1` 按调内音级复用和移调。
- ABC 支持按命名块局部修订：`% block: A` … `% end: A`，`audio_abc_music_score action=revise block=A abc=...` 只替换这一段，不再整份重存。
- 检查或渲染失败时保留 ABC 草稿；`audio_abc_music_score` 支持 `drafts` / `draft`，`get` 也会回退到草稿。
- ABC 母带改为分位峰值归一化 + 软膝限幅 + 0.5 秒淡出。
- 版本号提到 0.1.15：面板 bundle 的 URL 带版本且按 immutable 缓存，旧版本号会让宿主继续用缓存的 `webui.js`。

## 0.1.6

- FireRed 监听不再吃满 CPU：VAD 与 AED 的 ONNX 会话改为单线程、顺序执行并关闭空闲自旋。onnxruntime 默认按物理核开线程池、线程空闲时自旋等活，监听有声音时几十个核都在空转（64 线程机器上实测 30.8 核 → 0.04 核），单帧延迟反而略降；AED 60 秒块约 0.4 秒，不受影响。
- 参考音频导入支持任意格式：WAV 校验改成看 RIFF/WAVE 头（改扩展名的假 WAV 会被挡下），其他格式（mp3/flac/m4a/ogg 等）交给 ffmpeg 转成 16 kHz 单声道 WAV；没装 ffmpeg 时提示先装或自行转换。说话页的选择器与拖拽文案同步放宽。
- 云端合成写分阶段日志：按 request / response / download / failed 回报目标 host、字数与各阶段耗时，卡住时能看出停在哪一段；失败时区分自己的超时与队列取消。
- 混音输出从 24 bit 改为 16 bit PCM，避免部分客户端拒收。

## 0.1.5

- 说话改为流式：Edge、本机 GPT-SoVITS 与 OpenAI 兼容接口边合成边交给 ffmpeg 解码播放，不再等整句；播放队列在当前句开播时预取下一条，连续说话不再等合成。缺 ffmpeg 或原生输出时自动退回收齐再播；流式 WAV 落盘前补长度，记录能读出准确时长。
- Edge 连接按音色复用，同一音色连说不再每次重连；新建连接约 1 秒的代价只付一次，之后首音约 0.3 秒。
- 说话首块 PCM 到达时写一条「说话首音」日志（`worlds.audio`），带播放等待与合成耗时。
- 播放支持左右平衡（-100 全左 … 100 全右），「播放」页可调，`audio_play` / `audio_say` 可按条覆盖。

## 0.1.4

- 「说话」默认引擎改为 Edge 朗读（免密钥、免安装，需要联网），默认音色 `zh-CN-XiaoyiNeural`；合成结果是 mp3，附件的类型与文件名跟随实际格式。没配本地 GPT-SoVITS 或云端密钥也能直接出声，失败时提示检查音色名或切换引擎。
- 去掉 uv/ffmpeg 的「常见安装位置」猜测：uv 只认配置与 PATH 上的裸名；ffmpeg 从 PATH 解析成真实路径并写回配置，有 audify 时播放默认走原生 PCM 输出。

## 0.1.3

- 修复 PCM 输出无声：打开流后先启动流；打断或切歌后关闭流，下一次播放会重新打开；每次播放新建输出以跟随当前默认音频设备；按 `openStream` 返回的实际帧长写 PCM，避免帧长不符时播放失败。

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
