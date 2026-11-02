/** 一件安装任务的进度、取消与状态机；与具体装什么无关。 */
export interface JobState {
  phase: 'absent' | 'working' | 'ready' | 'error';
  /** 已处理字节与总量；总量未知时为 0。 */
  done: number;
  total: number;
  /** 正在做的事，或失败原因。 */
  detail: string | null;
}

export abstract class Job {
  protected state: JobState = { phase: 'absent', done: 0, total: 0, detail: null };
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;

  /** 这一项现在算不算装好了（以磁盘为准）。 */
  protected abstract present(): boolean;
  protected abstract work(signal: AbortSignal): Promise<void>;

  status(): JobState {
    if (this.running) return { ...this.state };
    if (this.present()) return { phase: 'ready', done: 0, total: 0, detail: null };
    return { ...this.state, phase: this.state.phase === 'error' ? 'error' : 'absent' };
  }

  busy(): boolean {
    return this.running !== null;
  }

  /** 卸载后清回未装，连上一次的失败原因一起清掉；正在跑的任务不能重置。 */
  reset(): void {
    if (this.running) throw new Error('任务进行中，先取消再卸载。');
    this.state = { phase: 'absent', done: 0, total: 0, detail: null };
  }

  install(): Promise<void> {
    if (this.running) return this.running;
    this.abort = new AbortController();
    this.state = { phase: 'working', done: 0, total: 0, detail: null };
    this.running = this.work(this.abort.signal)
      .then(() => {
        this.state = { phase: 'ready', done: this.state.total, total: this.state.total, detail: null };
      })
      .catch((err: unknown) => {
        this.state = {
          ...this.state,
          phase: 'error',
          detail: this.abort?.signal.aborted ? '已取消' : err instanceof Error ? err.message : String(err),
        };
      })
      .finally(() => {
        this.running = null;
        this.abort = null;
      });
    return this.running;
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** 子类写进度的口子。 */
  /** 逐字节进度：记下此刻累计，回调把「这个文件写到多少」换算成总进度（重试后会从新值重来）。 */
  protected progressCounter(): (written: number) => void {
    const base = this.state.done;
    return (written) => { this.state.done = base + written; };
  }

  protected report(detail: string): void {
    this.state.detail = detail;
  }
}
