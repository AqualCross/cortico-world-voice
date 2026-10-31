/**
 * SenseVoice 的输出不只有文字：原文是 `<|语言|><|情感|><|音频事件|><|itn 标记|>正文`。
 * 这里把四段标记拆出来，正文单独留，情感与事件换成中文标签。
 */

export interface SenseVoiceParsed {
  /** 去掉标记后的正文。 */
  text: string;
  /** 语言代码（`zh` / `en` / `ja` / `ko` / `yue`）；没有标记时为空。 */
  language: string;
  /** 情感（原文标记，如 `HAPPY`）；没有则为空。 */
  emotion: string;
  /** 音频事件（原文标记，如 `Laughter`、`BGM`）。 */
  events: string[];
  /** 是否做了文本规范化（`itn` / `woitn`）；没有标记时为 null。 */
  itn: boolean | null;
}

/** 情感标记 → 中文。 */
export const EMOTION_LABELS: Readonly<Record<string, string>> = {
  HAPPY: '开心',
  SAD: '难过',
  ANGRY: '生气',
  NEUTRAL: '平静',
  FEARFUL: '害怕',
  DISGUSTED: '厌恶',
  SURPRISED: '惊讶',
};

/** 音频事件标记 → 中文。 */
export const EVENT_LABELS: Readonly<Record<string, string>> = {
  Speech: '说话声',
  Applause: '掌声',
  BGM: '背景音乐',
  Laughter: '笑声',
  Cry: '哭声',
  Sneeze: '喷嚏',
  Breath: '呼吸声',
  Cough: '咳嗽',
};

/** SenseVoice 认得的标记；别的一律当正文，免得把普通文本里的尖括号吃掉。 */
const LANGUAGES = new Set(['zh', 'en', 'ja', 'ko', 'yue', 'nospeech']);

const knownTag = (tag: string): boolean =>
  LANGUAGES.has(tag) || tag in EMOTION_LABELS || tag in EVENT_LABELS || tag === 'itn' || tag === 'woitn';

/** 拆 SenseVoice 原文；标记不全时按拿得到的字段填，正文不丢。 */
export function parseSenseVoice(raw: string): SenseVoiceParsed {
  const tags: string[] = [];
  const text = raw.replace(/<\|([^|]*)\|>/g, (all, tag: string) => {
    const name = tag.trim();
    if (!knownTag(name)) return all;
    tags.push(name);
    return '';
  }).trim();
  const positional = tags.filter((tag) => tag && tag !== 'itn' && tag !== 'woitn');
  const itn = tags.includes('itn') ? true : tags.includes('woitn') ? false : null;
  return {
    text,
    language: positional[0] ?? '',
    emotion: positional[1] ?? '',
    events: positional.slice(2).filter((tag) => tag in EVENT_LABELS || /^[A-Za-z]+$/.test(tag)),
    itn,
  };
}

/** 给事件正文或工具回执用的附加信息，如「情感 开心；事件 笑声、背景音乐」。 */
export function senseVoiceNote(parsed: SenseVoiceParsed): string {
  const parts: string[] = [];
  const emotion = EMOTION_LABELS[parsed.emotion];
  if (emotion && parsed.emotion !== 'NEUTRAL') parts.push(`情感 ${emotion}`);
  const events = parsed.events.map((tag) => EVENT_LABELS[tag] ?? tag).filter((label) => label !== '说话声');
  if (events.length) parts.push(`事件 ${events.join('、')}`);
  return parts.join('；');
}

/** sherpa-onnx 把语言、情感、事件单独给，值里还带着 `<|…|>`；去掉壳再归类。 */
export function parsedFromFields(fields: { text?: string; lang?: string; emotion?: string; event?: string }): SenseVoiceParsed {
  const clean = (value?: string): string => {
    const text = (value ?? '').trim();
    return text.startsWith('<|') && text.endsWith('|>') ? text.slice(2, -2).trim() : text;
  };
  const event = clean(fields.event);
  const emotion = clean(fields.emotion);
  return {
    text: (fields.text ?? '').trim(),
    language: clean(fields.lang),
    emotion: emotion === 'EMO_UNKNOWN' ? '' : emotion,
    events: event && event !== 'Event_Unknown' ? [event] : [],
    itn: null,
  };
}
