/** 面板 bundle：`src/webui/client.ts` → `dist/webui.js`。浏览器侧只允许 `import type` 框架。 */
import * as esbuild from 'esbuild';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = `${root}dist`;
const notices = ['abcjs-MIT.txt', 'sprintf-BSD-3-Clause.txt'].map((name) => readFileSync(new URL(`../licenses/music-abc/${name}`, import.meta.url), 'utf8').trim()).join('\n\n');

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [{ in: `${root}src/webui/client.ts`, out: 'webui' }],
  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  sourcemap: true,
  metafile: true,
  legalComments: 'eof',
  banner: { js: `/*!\n${notices}\n*/` },
});

for (const [path, info] of Object.entries(result.metafile.outputs)) {
  if (path.endsWith('.map')) continue;
  console.log(`${path.replace(/\\/g, '/')}  ${(info.bytes / 1024).toFixed(1)} KB`);
}
