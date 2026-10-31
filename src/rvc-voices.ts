/** RVC 音色：`<dataDir>/rvc/` 下的 `.pth`（可选同名 `.index`），导入即复制。 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export class RvcVoices {
  constructor(readonly dir: string) {}

  list(): string[] {
    try {
      return readdirSync(this.dir).filter((name) => name.toLowerCase().endsWith('.pth')).sort();
    } catch {
      return [];
    }
  }

  /** 复制 .pth；同目录有同名 .index 一起复制。 */
  importFile(src: string): string {
    if (extname(src).toLowerCase() !== '.pth') throw new Error('RVC 音色要是 .pth 文件。');
    mkdirSync(this.dir, { recursive: true });
    const name = basename(src);
    copyFileSync(src, join(this.dir, name));
    const index = `${src.slice(0, -extname(src).length)}.index`;
    if (existsSync(index)) copyFileSync(index, join(this.dir, `${name.slice(0, -extname(name).length)}.index`));
    return name;
  }

  pathOf(file: string): string {
    return join(this.dir, file);
  }
}
