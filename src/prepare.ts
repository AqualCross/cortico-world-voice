/** 一件「获取」= 按顺序跑一串安装任务：已就绪的跳过，失败就停在这里，下次从这儿续。 */
export interface ChainStep {
  status(): { phase: 'absent' | 'working' | 'ready' | 'error' };
  install(): Promise<void>;
}

export interface ChainResult {
  ok: boolean;
  /** 卡住的步骤序号（从 0 起）与原因。 */
  failedAt: number | null;
}

export async function runChain(steps: readonly ChainStep[]): Promise<ChainResult> {
  for (const [index, step] of steps.entries()) {
    const state = step.status();
    if (state.phase === 'ready') continue;
    if (state.phase === 'working') return { ok: false, failedAt: index };
    await step.install();
    if (step.status().phase !== 'ready') return { ok: false, failedAt: index };
  }
  return { ok: true, failedAt: null };
}
