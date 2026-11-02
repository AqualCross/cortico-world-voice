import { DEFAULTS, ID, LABEL } from './config.js';
import { AbcMusicWorld, EVENT_TYPE, TOOLS } from './world.js';
export default {
  id: ID, label: LABEL,
  defaults: () => structuredClone(DEFAULTS),
  create: ctx => new AbcMusicWorld(ctx),
  describe: {
    tools: TOOLS,
    events: [{ type: EVENT_TYPE, description: { zh: 'ABC 演奏完成：WAV 附件、曲谱版本与文件路径。', en: 'ABC rendering completed, with a WAV attachment and score revision.' }, trigger: 'debounce' }],
  },
};
