# cortico-world-voice

Owner: `src/definition.ts`

声音整合包：一个 World 承载「听、转写、说话、唱歌、变声、播放」，避免 World 之间互相调 HTTP。
当前进度：骨架 + 依赖管理 + 播放 + 本机识别 + 监听（采集 / VAD / 切块 / 自动转写）+ 变声（RVC）+ 唱歌（DiffSinger）。
能力接入一个就在 `AudioWorld.capabilities()` 里点亮一项。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`：id、label、默认配置段、`create()`、`describe` |
| `src/config.ts` | 配置段类型、默认值与配置键声明（面板写回时按它验收） |
| `src/world.ts` | `World` 实现：挂载事件、`audio_status`、依赖页的 `invoke` 与状态快照 |
| `src/gpu.ts` | `nvidia-smi` 检测、解析与选档（≥ 4 GB 走显卡档） |
| `src/uv.ts` | uv 识别（配置 → PATH → 常见位置 → 自己装的那份）与安装 |
| `src/ffmpeg.ts` | ffmpeg 识别与安装 |
| `src/download.ts` | 断点续传、大小/SHA-256 校验、`tar.exe` 解 zip |
| `src/jobs.ts` | 安装任务的状态机（未装/进行中/就绪/失败）与取消 |
| `src/catalog.ts` | 钉住的上游 commit 与两档权重清单（上游地址、大小、SHA-256） |
| `src/install.ts` | GPT-SoVITS 源码与权重的安装（`.partial` → 校验 → 改名） |
| `src/play.ts` | 播放：文件走 ffmpeg 解码 + 常驻输出；没有 audify/ffmpeg 时退回 PowerShell |
| `src/audio-out.ts` | 常驻 PCM 输出（audify / WASAPI，48 kHz 交错立体声，按帧对齐） |
| `src/decode.ts` | ffmpeg 解码到 PCM 块（不落临时文件） |
| `src/queue.ts` | 播放队列：先来先放、跳过/移除/清空、快照 |
| `src/capture.ts` | 采集：WASAPI 环回 / 按应用 / 麦克风 → 16 kHz 单声道 20ms 帧 |
| `src/vad.ts` | 切分：能量门限与 Silero（每路独立，参数热改，墙上时钟收尾） |
| `src/listen.ts` | 监听引擎：车道对账、切块入库、自动转写、电平与错误 |
| `assets/play.ps1` | 播放脚本（退出码区分解码失败、打不开、超时） |
| `src/tool-text.ts` | 工具说明的部署覆盖（JSON Pointer、版本号防并发写） |
| `src/webui/tools.ts` | 「工具」页：可编辑的工具说明与保存/重置 |
| `src/webui/speak.ts` | 「说话」页：说话/变声/唱歌三块，引擎切换换字段 |
| `src/webui/listen.ts` | 「听」页：音源多选、切分配置、转文本引擎 |
| `src/rvc.ts` | 变声引擎客户端：常驻 RVC 子进程、串行请求、空闲退出 |
| `src/rvc-voices.ts` | 变声音色目录（`audio/rvc/`，`.pth` 与同名 `.index`） |
| `python/rvc_worker.py` | RVC 推理子进程：载入上游代码与资产，按行收转换请求 |
| `src/singer.ts` | 唱歌引擎客户端：第一次唱才起子进程、串行、空闲退出 |
| `src/banks.ts` | DiffSinger 声库扫描（`dsconfig.yaml`、说话人音色） |
| `python/diffsinger_worker.py` | DiffSinger 子进程：歌词→音素→自动旋律→五段 onnx 推理 |
| `src/cloud.ts` | 云端 TTS（DashScope SpeechSynthesizer、OpenAI 兼容 /v1/audio/speech） |
| `src/stt.ts` | 云端转写：DashScope 同步 / 文件转写、OpenAI 兼容 |
| `src/storage.ts` | 数据根 `<dataDir>/audio/` 与旧布局搬迁 |
| `src/transcripts.ts` | 转写记录仓库（`audio/transcripts/`，只存文本与元数据） |
| `src/clips.ts` | 音频输出仓库（`audio/out/`，索引 + 音频文件；说话/变声/唱歌的成品） |
| `src/import-legacy.ts` | 旧 stt / tts / listen 三个 World 的记录一次性并进来 |
| `src/wav.ts` | 从 WAV 头算时长（认不出就回 null） |
| `src/webui/records.ts` | 「记录」页：转写 / 语音两栏 |
| `src/webui/client.ts` | 「依赖」「说话」「听」「工具」四页的面板入口（播放与记录收在二级页签） |
| `src/ENV_PROMPT.md` | 环境提示词模板；默认留空，写清用法后再补 |
| `tests/` | 干装载、事件、状态工具、显卡解析、权重缺失、依赖页挂载 |

## 「说话 → 播放」页

正在播放与排队中的音频，每条带 id、来源、音量、已播秒数；顶部音量滑条立即生效并写回 `worlds.audio.volume`，
可跳过当前、按条移除、清空。工具 `audio_play` 入队，`audio_queue` 查看与操作。

## 工具

- `audio_say`：按当前引擎合成并排队播放；`silent` 不播放，合成完以 `audio.say_done` 事件带回：正文里有本地路径，同时挂一份音频附件（Core 分配的 `log:` 句柄）。失败都走 `audio.say_failed`。
- `audio_transcribe`：后台转写音频文件（本机 SenseVoice 或云端引擎），文字进「记录 → 转写」并以 `audio.transcribed` 事件带回；失败走 `audio.transcribe_failed`。
- `audio_listen`：开始 / 停止 / 查看监听；状态里带每路的电平、块数与最近听到的几句。
- `audio_convert`：把一段音频换成当前变声音色；立刻回执，成功进语音记录并自动播放；`silent` 不播放，完成以 `audio.convert_done` 带回路径与音频附件句柄。失败推 `audio.convert_failed`。
- `audio_sing`：把歌词唱出来（DiffSinger）；立刻回执，成功进语音记录并自动播放；`silent` 不播放，完成以 `audio.sing_done` 带回路径与音频附件句柄。失败推 `audio.sing_failed`。
- `audio_play` / `audio_queue` / `audio_status`：播放队列与状态。播放、变声、转写都接受本地路径或 Core 的 `log:`/`mem:` 附件句柄。

合成、变声与唱歌的成品落在 `<dataDir>/audio/out/`，转写记录在 `<dataDir>/audio/transcripts/`，
转写与语音各自是「目录 + index.json」，面板的「记录」页读它们。听到的声音不再存音频文件，只把正文写进转写记录。

## 记录

「语音」在「说话 → 记录」，「转写」在「听 → 记录」；各自可刷新、清空，动作只动自己那栏：

- **转写**：每次 `audio_transcribe` 的正文、来源路径、模型/语言、时长、大小与时间；可复制文字、复制来源、删除。
- **语音**：每次 `audio_say` 的成品音频、文本、音色/模型、时长、大小与时间；可试听（进播放队列）、复制路径、删除。

旧版把数据直接写在 `data` 根下（`uv/`、`ffmpeg/`、`clips/`、`timbre/`、`rvc/`、`lanes.json`），
启动时统一搬进 `data/audio/`；已撤掉的调用账本搬成 `audio/usage-legacy.jsonl`，只留档不再写。
旧 stt / tts / listen 三个 World 的已有记录在首次启动时复制一份进来
（`audio/imported.json` 记下已完成，旧目录不动）。

## 「说话」页

五块：说话（本机 gpt-sovits / HTTP DashScope / OpenAI 兼容，切换后只显示对应字段）、变声（RVC）、唱歌（DiffSinger）、播放（音量与队列）、记录（合成语音）。
密钥写在部署 `.env`，页面上只填变量名与密钥本身。

变声页：导入 `.pth`（同目录同名 `.index` 一起用）后选一段音频点「转换」，按变调 / 索引率 / 保护清辅音转完自动进播放队列，
成品存进「记录 → 语音」；「最近一次」那一行可以再播一次。推理沿用说话的档位（`speak.gptSovits.tier`），空闲 5 分钟释放显存。

唱歌页：选声库与音色，调速度 / 移调 / 调式 / 旋律种子（0 = 按歌词固定），写下歌词点「唱」。
旋律由程序按调式自动生成，每个字一个音符、标点断句；唱完自动进播放队列并存进「记录 → 语音」。
打开「唱完变声」会用「变声」页选中的 RVC 音色再过一遍。引擎第一次唱才启动，空闲 5 分钟退出。

## 「听」页

勾选即监听：系统声音 / 麦克风 / 指定应用各一路，各自选处理方式（跟随默认、能量门限切分、Silero / FireRed VAD 或流式转文本），
每行有一条实时电平条（10Hz，说话时变亮）。上面的「监听」总开关停下全部采集但保留勾选。
处理参数（阈值、最短语音、收尾静音、单块上限、最短片段）热改；选流式转文本的那一路不显示这些参数。
切出来的句子自动转成文字存进「记录 → 转写」，并写一条 `audio.heard` 事件——默认只归档；打开「通知 Coo」后按内核 debounce 推送（`trigger: 'debounce'`），相邻几句由 WakeBus 合批，在同一次唤醒里一起给到模型。合批窗口与批量上限用框架的 `batching` 设置（`quietGapMs` / `minBatchAgeMs` / `maxBatchAgeMs` / `maxBatchSize`），World 不自己计时。
按应用监听时，每句的转写记录与事件带此刻的窗口标题（例如正在放的歌名；浏览器取到的是标签页标题），
查不到才退回进程名或「应用 PID」。
自己正在播放的音频（`audio_say` / 播放队列）期间切出来的块直接丢掉，不会自己听自己。
整段转写用本机 SenseVoice 或 HTTP DashScope / OpenAI 兼容；「转文本」拆成「流式转文本」与「转文本」两块。
「细分」选「区分音乐与人声」时，VAD 切出来的每块先过 FireRed AED：音乐块只写事件，不转写、不唤醒，也不留音频；
流式来源不切分，也就不细分，页面上不显示这一项。
处理方式选「流式转文本」的那一路不切分：帧直接交给本机 Paraformer 流式引擎，引擎只负责解码；
断句按帧电平判（连续低于能量门限达到最短静音算一句），一句一条记录、正文一并存下。
环回安静时不送帧，补静音的活由 stream-asr 按墙上时钟做；引擎自带的「没解出新字」端点会切碎连续说话，已关闭。
SenseVoice 的情感与音频事件（笑声、掌声、背景音乐等）跟正文一起保留，事件与工具回执里附「情感 开心；事件 笑声」。
依赖页对 SenseVoice 点「获取」会同时下模型（约 240 MB，校验 SHA-256）和建一个独立 Python 环境（`uv venv` + `sherpa-onnx`），之后 `audio_transcribe` 默认直接走本机；ffmpeg 负责把任意音频解成 16 kHz 单声道。
实测（4–6 秒参考音频）：冷启动约 2.6–3.2 秒（含加载模型），之后 0.17–0.30 秒一条；中文与英文字符准确 100%（标点有出入）；29 秒整段一次转完，个别字会滑。

## 「工具」页

每个工具的描述与参数说明都能在页面上改；保存到 `<部署>/worlds/audio/tool-text.json`，
下次会话构建工具表时生效。可筛选、按条恢复默认、整份恢复。

## 「依赖」页

- **显卡**：自动检测型号、显存、驱动，并按显存选推理档；可重新检测。
- **uv**：优先识别本机已有的（配置项 → PATH → 常见安装位置），找不到才下载官方独立包到
  World 数据目录（不写系统 PATH、不改系统环境）。
- **ffmpeg**：同样先识别本机（PATH、WinGet、chocolatey、`C:fmpegin` 等），缺失可下载静态包，
  只留 `ffmpeg.exe` 与 `ffprobe.exe`。
- **GPT-SoVITS 源码**：按上游 commit 下载到 `<部署根>/runtimes/audio/gpt-sovits/<commit>/`。
- **GPT-SoVITS 权重**：按当前推理档下载到 `<部署根>/models/audio/gpt-sovits/`，逐个校验大小与 SHA-256。
- **RVC**：上游源码 + ContentVec / RMVPE 资产（`models/audio/rvc/`），再在项目目录里建自己的 Python 环境（torch 按档位 + 推理依赖）。
- **DiffSinger**：绮萱声库 + 声码器（`models/audio/singer/`），外加唱歌环境（`runtimes/audio/singer/`，只装 `diffsinger-utau`）。
- **VAD / 细分**：Silero VAD、FireRed VAD 流式 ONNX + FireRed AED（`models/audio/vad/`，FireRed 两个模型共约 4.7 MB，共用 `cmvn.ark`）。
- **语音识别**：整段用 SenseVoiceSmall int8（`models/audio/stt/sensevoice/`）；
  流式用 Paraformer 中英流式模型（`models/audio/stt/paraformer/`，约 226 MB，sherpa-onnx OnlineRecognizer）。

## 约定

- id：`audio`；包名 `cortico-world-voice`（npm 上的 `cortico-world-audio` 被别人占用）；配置键 `worlds.audio.*`；
  事件前缀 `audio.`；工具前缀 `audio_`。
- 状态只报可确认的事实：没有接入的能力就说没有，不假装可用。
- 运行时与权重放部署根（`runtimes/`、`models/`），World 私有数据放 `ctx.dataDir/audio`。

## 本地校验

```bash
corepack pnpm install
pnpm typecheck && pnpm test && pnpm build
```

在 Cortico 检出根下：`pnpm check:extension <本目录绝对路径>`。
