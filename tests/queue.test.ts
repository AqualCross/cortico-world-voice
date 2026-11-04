import { describe, it, expect } from 'vitest';
import { PlayQueue, clampBalance } from '../src/queue.ts';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 假播放器：每次播放挂起，等测试自己推；abort 时以取消失败退出。 */
function fakePlayer(): { started: string[]; balances: number[]; finish: () => void; play: ConstructorParameters<typeof PlayQueue>[0] } {
  const started: string[] = [];
  const balances: number[] = [];
  const gates: Array<() => void> = [];
  return {
    started,
    balances,
    finish: () => gates.shift()?.(),
    play: ({ path, balance, signal }) => new Promise<void>((resolve, reject) => {
      started.push(path);
      balances.push(balance);
      gates.push(resolve);
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  };
}

describe('播放队列', () => {
  it('先来先放：一次只有一条在播，排队的按顺序', async () => {
    const fake = fakePlayer();
    const queue = new PlayQueue(fake.play, () => 70);
    queue.enqueue({ path: 'D:/a.wav', origin: 'tool' });
    queue.enqueue({ path: 'D:/b.wav', origin: 'tool' });
    await tick();
    const snap = queue.snapshot();
    expect(snap.current?.shown).toBe('a.wav');
    expect(snap.pending.map((p) => p.shown)).toEqual(['b.wav']);
    expect(snap.volume).toBe(70);
    fake.finish();
    await tick();
    expect(fake.started).toEqual(['D:/a.wav', 'D:/b.wav']);
    expect(queue.snapshot().current?.shown).toBe('b.wav');
    fake.finish();
    await tick();
    queue.clear();
    expect(queue.snapshot().current).toBe(null);
  });

  it('跳过当前接着放下一条；清空会停当前并丢掉排队', async () => {
    const fake = fakePlayer();
    const queue = new PlayQueue(fake.play, () => 80);
    queue.enqueue({ path: 'D:/a.wav', origin: 'tool' });
    queue.enqueue({ path: 'D:/b.wav', origin: 'tool' });
    queue.enqueue({ path: 'D:/c.wav', origin: 'tool' });
    await tick();
    expect(queue.skip()).toContain('a.wav');
    await tick();
    expect(fake.started).toEqual(['D:/a.wav', 'D:/b.wav']);
    expect(queue.snapshot().pending.map((p) => p.shown)).toEqual(['c.wav']);
    expect(queue.clear()).toContain('清空排队 1 条');
    await tick();
    expect(queue.snapshot().counts).toEqual({ current: 0, pending: 0 });
  });

  it('按 id 移除排队项；正在播放的不能被移除', async () => {
    const fake = fakePlayer();
    const queue = new PlayQueue(fake.play, () => 80);
    const first = queue.enqueue({ path: 'D:/a.wav', origin: 'tool' });
    const second = queue.enqueue({ path: 'D:/b.wav', origin: 'tool' });
    await tick();
    expect(queue.remove(first.id)).toContain('正在播放');
    expect(queue.remove(second.id)).toContain('已从队列移除');
    expect(queue.snapshot().pending).toHaveLength(0);
    expect(queue.remove('q99')).toContain('没有');
    queue.clear();
  });

  it('播不出来才记失败；取消不算', async () => {
    const queue = new PlayQueue(async () => { throw new Error('解码失败'); }, () => 80);
    queue.enqueue({ path: 'D:/bad.wav', origin: 'tool' });
    await tick();
    await tick();
    expect(queue.snapshot().lastError).toContain('解码失败');
    expect(queue.snapshot().current).toBe(null);
  });

  it('合成出来的那条带上字幕原文与时长；放文件时两样都空', async () => {
    const fake = fakePlayer();
    const queue = new PlayQueue(fake.play, () => 80);
    queue.enqueue({ path: 'D:/a.wav', origin: 'tool', text: '早。', seconds: 1.5 });
    queue.enqueue({ path: 'D:/b.wav', origin: 'ui' });
    await tick();
    const current = queue.snapshot().current;
    expect(current?.text).toBe('早。');
    expect(current?.seconds).toBe(1.5);
    queue.skip();
    await tick();
    expect(queue.snapshot().current?.text).toBe('');
    expect(queue.snapshot().current?.seconds).toBe(null);
    queue.clear();
  });

  it('平衡按配置兜底，条目可单独覆盖并掐到范围内', async () => {
    const fake = fakePlayer();
    const queue = new PlayQueue(fake.play, () => 80, () => -40);
    queue.enqueue({ path: 'D:/a.wav', origin: 'tool' });
    queue.enqueue({ path: 'D:/b.wav', origin: 'tool', balance: 65 });
    queue.enqueue({ path: 'D:/c.wav', origin: 'tool', balance: 250 });
    await tick();
    expect(queue.snapshot().balance).toBe(-40);
    expect(queue.snapshot().current?.balance).toBe(-40);
    fake.finish();
    await tick();
    expect(fake.balances).toEqual([-40, 65]);
    fake.finish();
    await tick();
    expect(fake.balances).toEqual([-40, 65, 100]);
    queue.clear();
    expect(clampBalance(Number.NaN)).toBe(0);
  });

  it('开播和收播都通知字幕层：跳过与播完都会收', async () => {
    const fake = fakePlayer();
    const started: string[] = [];
    const ended: string[] = [];
    const queue = new PlayQueue(fake.play, () => 80, () => 0, {
      onStart: (item) => started.push(`${item.id}:${item.text}`),
      onEnd: (item) => ended.push(item.id),
    });
    queue.enqueue({ path: 'D:/a.wav', origin: 'tool', text: '第一句。', seconds: 2 });
    queue.enqueue({ path: 'D:/b.wav', origin: 'tool' });
    await tick();
    expect(started).toEqual(['q1:第一句。']);
    fake.finish();
    await tick();
    expect(ended).toContain('q1');
    expect(started).toContain('q2:');
    queue.skip();
    await tick();
    expect(ended).toContain('q2');
    queue.clear();
  });
});
