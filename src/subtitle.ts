/**
 * 桌面字幕：常驻一个 PowerShell + WPF 的透明置顶窗（assets/subtitle.ps1），跟着播放队列走。
 * 窗口点击穿透、不进任务栏；只收 stdin 的 JSON 行，进程挂了下次 show 再起一个。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OVERLAY_PS1 = fileURLToPath(new URL('../assets/subtitle.ps1', import.meta.url));

/** 按句切：标点留在句子里；没有句读时整段算一句。 */
const SENTENCE = /[^。！？!?…；;\n]+[。！？!?…；;\n]*/g;

export interface SubtitleLine {
  text: string;
  /** 这句从第几毫秒开始。 */
  at: number;
}

export interface SubtitleStyle {
  enabled: boolean;
  /** 字号（px）。 */
  size: number;
  /** 文字颜色，#RRGGBB。 */
  color: string;
  vertical: 'top' | 'middle' | 'bottom';
  align: 'left' | 'center' | 'right';
}

/** 句子里非空白字数当权重，按比例分摊时长；时长不明就整段一句。 */
export function subtitleTimeline(text: string, seconds?: number | null): SubtitleLine[] {
  const whole = String(text ?? '').trim();
  if (!whole) return [];
  if (!seconds || seconds <= 0) return [{ text: whole, at: 0 }];
  const pieces = (whole.match(SENTENCE) ?? []).map((piece) => piece.trim()).filter(Boolean);
  if (pieces.length < 2) return [{ text: whole, at: 0 }];
  const weight = (piece: string): number => piece.replace(/\s+/g, '').length || 1;
  const total = pieces.reduce((sum, piece) => sum + weight(piece), 0);
  let done = 0;
  return pieces.map((piece) => {
    const line = { text: piece, at: Math.round((done / total) * seconds * 1000) };
    done += weight(piece);
    return line;
  });
}

export class SubtitleOverlay {
  private child: ChildProcess | null = null;
  private disposed = false;

  show(text: string, seconds: number | null | undefined, style: SubtitleStyle, opts: { hideAfterMs?: number } = {}): void {
    if (!style.enabled) {
      this.hide();
      return;
    }
    const lines = subtitleTimeline(text, seconds);
    if (!lines.length) {
      this.hide();
      return;
    }
    this.send({
      op: 'show',
      lines,
      size: style.size,
      color: style.color,
      vertical: style.vertical,
      align: style.align,
      hideAfter: opts.hideAfterMs ?? 0,
    });
  }

  hide(): void {
    this.send({ op: 'hide' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin?.write(`${JSON.stringify({ op: 'quit' })}\n`);
    } catch {
      child.kill();
      return;
    }
    const timer = setTimeout(() => child.kill(), 1500);
    timer.unref?.();
  }

  private send(message: Record<string, unknown>): void {
    if (this.disposed) return;
    const child = this.ensure();
    if (!child?.stdin) return;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      this.child = null;
    }
  }

  private ensure(): ChildProcess | null {
    if (this.child) return this.child;
    if (process.platform !== 'win32') return null;
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OVERLAY_PS1], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const drop = (): void => {
        if (this.child === child) this.child = null;
      };
      child.on('exit', drop);
      child.on('error', drop);
      child.stdin?.on('error', drop);
      child.stderr?.resume();
      child.stdout?.resume();
      this.child = child;
      return child;
    } catch {
      return null;
    }
  }
}
