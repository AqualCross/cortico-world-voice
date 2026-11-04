import { describe, it, expect } from 'vitest';
import { EdgeError, EdgeSpeaker, synthesizeEdge, synthesizeEdgeStream, type EdgeModule } from '../src/edge.ts';

interface Recorded {
  meta: Array<[string, string]>;
  streams: Array<[string, string, string]>;
  closed: number;
}

function fakeModule(stream: () => AsyncIterable<Uint8Array>, recorded: Recorded): EdgeModule {
  return {
    OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3' },
    MsEdgeTTS: class {
      async setMetadata(voice: string, format: string): Promise<void> {
        recorded.meta.push([voice, format]);
      }
      toStream(text: string, options: { rate: string; pitch: string }) {
        recorded.streams.push([text, options.rate, options.pitch]);
        return { audioStream: stream() };
      }
      close(): void {
        recorded.closed += 1;
      }
    } as unknown as EdgeModule['MsEdgeTTS'],
  };
}

const bytesOf = (...chunks: number[][]) => chunks.map((chunk) => Uint8Array.from(chunk));

describe('Edge 在线朗读', () => {
  it('按音色与语速/音调合成，拼出完整 mp3 字节', async () => {
    const recorded: Recorded = { meta: [], streams: [], closed: 0 };
    const mod = fakeModule(() => (async function* () {
      yield* bytesOf([0xff, 0xf3], [0x64, 0xc4]);
    })(), recorded);

    const bytes = await synthesizeEdge({ text: ' 你好呀 ', voice: 'zh-CN-XiaoyiNeural', rate: 10, pitch: -5, load: () => mod });

    expect(bytes).toEqual(Buffer.from([0xff, 0xf3, 0x64, 0xc4]));
    expect(recorded.meta).toEqual([['zh-CN-XiaoyiNeural', 'audio-24khz-48kbitrate-mono-mp3']]);
    expect(recorded.streams).toEqual([['你好呀', '+10%', '-5Hz']]);
    expect(recorded.closed).toBe(1);
  });

  it('流式：先到先给，不等整句；流结束时关掉连接', async () => {
    const recorded: Recorded = { meta: [], streams: [], closed: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mod = fakeModule(() => (async function* () {
      yield Uint8Array.from([1, 2]);
      await gate;
      yield Uint8Array.from([3]);
    })(), recorded);

    const stream = await synthesizeEdgeStream({ text: '你好', voice: 'zh-CN-XiaoyiNeural', load: () => mod });
    const iterator = stream.chunks[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(Buffer.from([1, 2]));
    expect(recorded.closed).toBe(0);
    release();
    expect((await iterator.next()).value).toEqual(Buffer.from([3]));
    expect((await iterator.next()).done).toBe(true);
    expect(recorded.closed).toBe(1);
  });

  it('同一音色连说复用同一条连接；关掉后下次重连', async () => {
    const recorded: Recorded = { meta: [], streams: [], closed: 0 };
    let built = 0;
    const mod: EdgeModule = {
      OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3' },
      MsEdgeTTS: class {
        constructor() { built += 1; }
        async setMetadata(voice: string, format: string): Promise<void> {
          recorded.meta.push([voice, format]);
        }
        toStream(text: string, options: { rate: string; pitch: string }) {
          recorded.streams.push([text, options.rate, options.pitch]);
          return { audioStream: (async function* () { yield Uint8Array.from([1]); })() };
        }
        close(): void {
          recorded.closed += 1;
        }
      } as unknown as EdgeModule['MsEdgeTTS'],
    };
    const speaker = new EdgeSpeaker({ load: () => mod, idleMs: 60_000 });
    const drain = async (text: string): Promise<void> => {
      const stream = await speaker.stream({ text, voice: 'zh-CN-XiaoyiNeural' });
      for await (const _chunk of stream.chunks) { /* 收完 */ }
    };
    await drain('一');
    await drain('二');
    expect(built).toBe(1);
    expect(recorded.closed).toBe(0);
    speaker.close();
    expect(recorded.closed).toBe(1);
    await drain('三');
    expect(built).toBe(2);
    speaker.close();
  });

  it('没有语速/音调时补 +0% / +0Hz', async () => {
    const recorded: Recorded = { meta: [], streams: [], closed: 0 };
    const mod = fakeModule(() => (async function* () {
      yield Uint8Array.from([1]);
    })(), recorded);

    await synthesizeEdge({ text: 'hi', voice: 'zh-CN-XiaoxiaoNeural', load: () => mod });

    expect(recorded.streams).toEqual([['hi', '+0%', '+0Hz']]);
  });

  it('没有音频时提示音色可能不在 Edge 列表里，并关掉连接', async () => {
    const recorded: Recorded = { meta: [], streams: [], closed: 0 };
    const mod = fakeModule(() => (async function* () {})(), recorded);

    const err = await synthesizeEdge({ text: '你好', voice: 'zh-CN-XiaoshuangNeural', load: () => mod }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EdgeError);
    expect((err as Error).message).toContain('zh-CN-XiaoshuangNeural');
    expect((err as Error).message).toContain('不在 Edge 的列表里');
    expect(recorded.closed).toBe(1);
  });

  it('连接提前关闭时翻成「检查音色名」，不把英文堆栈丢给用户', async () => {
    const recorded: Recorded = { meta: [], streams: [], closed: 0 };
    const mod = fakeModule(() => (async function* () {
      throw new Error('Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated.');
    })(), recorded);

    const err = await synthesizeEdge({ text: '你好', voice: 'bad-voice', load: () => mod }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EdgeError);
    expect((err as Error).message).toContain('bad-voice');
    expect((err as Error).message).not.toContain('turn.end');
    expect(recorded.closed).toBe(1);
  });

  it('空文字和空音色直接报错，不去连网', async () => {
    const recorded: Recorded = { meta: [], streams: [], closed: 0 };
    const mod = fakeModule(() => (async function* () {
      yield Uint8Array.from([1]);
    })(), recorded);

    await expect(synthesizeEdge({ text: '  ', voice: 'v', load: () => mod })).rejects.toBeInstanceOf(EdgeError);
    await expect(synthesizeEdge({ text: 'hi', voice: ' ', load: () => mod })).rejects.toBeInstanceOf(EdgeError);
    expect(recorded.meta).toEqual([]);
  });
});
