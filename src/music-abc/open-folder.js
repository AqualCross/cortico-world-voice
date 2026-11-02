import childProcess from 'node:child_process';
import { mkdirSync } from 'node:fs';

export async function openFolder(dir) {
  const command = { win32: 'explorer.exe', darwin: 'open', linux: 'xdg-open' }[process.platform];
  if (!command) throw new Error('Opening folders is unavailable on this platform.');
  mkdirSync(dir, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, [dir], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { ok: true, dir };
}
