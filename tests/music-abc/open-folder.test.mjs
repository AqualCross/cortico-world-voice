import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import def from '../../src/music-abc/index.js';

test('works folder is created for a new library and returned after the launcher starts', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'abc-folder-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  t.mock.method(childProcess, 'spawn', () => {
    const child = new childProcess.ChildProcess();
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  const world = def.create({ cfg: def.defaults(), dataDir });
  const result = await world.invoke('works', 'openFolder');
  assert.equal(result.ok, true);
  assert.equal(result.dir, join(world.store.dir, 'works'));
  assert.ok(existsSync(result.dir));
  assert.equal(world.store.listWorks().length, 0);
});

test('launcher failure reaches the panel as a rejected action', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'abc-folder-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  t.mock.method(childProcess, 'spawn', () => {
    const child = new childProcess.ChildProcess();
    queueMicrotask(() => child.emit('error', new Error('Folder launcher unavailable')));
    return child;
  });
  const world = def.create({ cfg: def.defaults(), dataDir });
  await assert.rejects(world.invoke('works', 'openFolder'), /Folder launcher unavailable/);
});
