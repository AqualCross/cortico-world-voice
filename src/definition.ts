import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { modelsRoot, runtimesRoot } from 'cortico/paths.ts';
import { AUDIO_DEFAULTS, type AudioConfigSection } from './config.ts';
import { AUDIO_TOOL_DECLS, TOOL_SUMMARIES, AudioWorld } from './world.ts';

export const AUDIO: WorldDefinition<AudioConfigSection> = {
  id: 'audio',
  label: '声音',
  defaults: () => ({ ...AUDIO_DEFAULTS }),
  // `ctx.cfg` 是 `worlds.audio` 的活引用：热改的键现读即生效。
  create: (ctx) => new AudioWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    botDir: ctx.botDir,
    packageDir: ctx.packageDir,
    runtimesRoot,
    modelsRoot,
    persist: (patch) => ctx.persist(patch as never),
    secret: (name) => ctx.secret(name),
    storeSecret: (name, value) => ctx.storeSecret(name, value),
  }),
  describe: {
    tools: describeTools(AUDIO_TOOL_DECLS, TOOL_SUMMARIES),
    events: [
      {
        type: 'audio.heard',
        description: {
          zh: '从某一路声音里切出一块并（可自动）转成文字，正文存进转写记录；事件默认只归档，打开「通知 Coo」时按内核 debounce 投递，几句会在同一次唤醒里一起给到模型。',
          en: 'A chunk was cut from one listening lane and transcribed (when enabled); the text goes to the transcript records. Archived by default; with notify on the event is pushed with trigger=debounce, so the core batches close sentences into one wake-up.',
        },
      },
      {
        type: 'audio.say_done',
        description: { zh: 'silent 合成完成，带回本地路径与音频附件句柄。', en: 'A silent audio_say finished; it carries the local path and the audio as a blob attachment.' },
      },
      {
        type: 'audio.failed',
        description: {
          zh: '后台说话、转写、变声、唱歌、分离或混音失败，正文包含工具名、任务编号与失败原因。',
          en: 'A background speech, transcription, conversion, singing, separation, or mixing task failed; the text includes the tool name, job id, and error.',
        },
      },
      {
        type: 'audio.transcribed',
        description: { zh: '后台转写完成，带回文字。', en: 'A background transcription finished; it carries the text.' },
      },
      {
        type: 'audio.convert_done',
        description: { zh: 'silent 变声完成，带回本地路径与音频附件句柄。', en: 'A silent audio_convert finished; it carries the local path and the audio as a blob attachment.' },
      },
      {
        type: 'audio.sing_done',
        description: { zh: 'silent 唱歌完成，带回本地路径与音频附件句柄。', en: 'A silent audio_sing finished; it carries the local path and the audio as a blob attachment.' },
      },
      { type: 'audio.separated', description: { zh: '歌曲分离完成，带回人声与伴奏路径。', en: 'Song separation finished with paths to vocals and accompaniment.' } },
      { type: 'audio.mixed', description: { zh: '混音完成，带回 WAV 路径。', en: 'Mixing finished with the WAV file path.' } },
      { type: 'audio.abc_played', description: { zh: 'ABC 演奏完成：WAV 附件、曲谱版本与文件路径。', en: 'ABC rendering completed, with a WAV attachment and score revision.' }, trigger: 'debounce' },
    ],
  },
};
