import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import def from '../../src/music-abc/index.js';
import { TOOLS } from '../../src/music-abc/world.js';
import { ToolTextStore, toolTextFields } from '../../src/music-abc/tool-text.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'abc-tool-text-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const botDir = join(root, 'deployment'), packageDir = join(root, 'package');
  const options = { botDir, packageDir, dataDir: join(root, 'data') };
  return { root, options, world: def.create(options), path: join(botDir, 'worlds', def.id, 'tool-text.json'), packagePath: join(packageDir, 'worlds', def.id, 'tool-text.json') };
}
const write = (path, tools) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ version: 1, tools })); };
const toolSchema = ({ name, description, parameters }) => ({ name, description, parameters });

test('tool listing reads immutable defaults without creating deployment or data directories', async t => {
  const { options, world } = setup(t), view = await world.invoke('tools', 'list');
  assert.deepEqual(view.tools.map(toolSchema), TOOLS.map(toolSchema));
  assert.ok(view.tools.every(tool => tool.fields.some(field => field.path === '/description')));
  assert.equal(existsSync(options.botDir), false); assert.equal(existsSync(options.dataDir), false);
});

test('saved text is read on the next tool assembly while existing tool snapshots remain unchanged', async t => {
  const { world, options, path } = setup(t), captured = world.tools(), view = await world.invoke('tools', 'list');
  const overrides = { audio_abc_music_play: { '/description': 'Render this tune.', '/parameters/properties/abc/description': 'A complete tune.', '/parameters/properties/title/description': 'Recording title.' } };
  const saved = await world.invoke('tools', 'save', [{ expectedRevision: view.revision, overrides }]);
  assert.equal(saved.tools[1].description, overrides.audio_abc_music_play['/description']);
  assert.equal(captured[1].description, TOOLS[1].description);
  assert.equal(captured[1].parameters.properties.abc.description, TOOLS[1].parameters.properties.abc.description);
  const next = def.create(options).tools();
  assert.equal(next[1].description, overrides.audio_abc_music_play['/description']);
  assert.equal(next[1].parameters.properties.abc.description, overrides.audio_abc_music_play['/parameters/properties/abc/description']);
  assert.equal(next[1].parameters.properties.title.description, overrides.audio_abc_music_play['/parameters/properties/title/description']);
  assert.equal(next[0].parameters.properties.abc.description, TOOLS[0].parameters.properties.abc.description);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, tools: overrides });
  assert.deepEqual(def.describe.tools, TOOLS);
});

test('text edits preserve tool execution, names, constraints and other deployments', async t => {
  const { root, world } = setup(t), view = await world.invoke('tools', 'list');
  await world.invoke('tools', 'save', [{ expectedRevision: view.revision, overrides: { audio_abc_music_score: { '/description': 'Inspect or save a score.', '/parameters/properties/action/description': 'Choose an operation.' } } }]);
  const tools = world.tools();
  assert.deepEqual(tools.map(tool => tool.name), TOOLS.map(tool => tool.name));
  assert.deepEqual(tools[0].parameters.properties.action.enum, TOOLS[0].parameters.properties.action.enum);
  assert.deepEqual(tools[0].parameters.required, TOOLS[0].parameters.required);
  assert.deepEqual(await tools[0].handler({ action: 'list' }), { text: '[]' });
  assert.equal(def.create({ botDir: join(root, 'other'), dataDir: join(root, 'other-data') }).tools()[0].description, TOOLS[0].description);
});

test('package text is inherited and clearing a deployment field restores its inherited value', async t => {
  const { world, path, packagePath } = setup(t);
  write(packagePath, { audio_abc_music_play: { '/description': 'Package description.' } });
  let view = await world.invoke('tools', 'list');
  assert.equal(view.tools[1].description, 'Package description.');
  assert.equal(view.tools[1].fields[0].source, 'package');
  view = await world.invoke('tools', 'save', [{ expectedRevision: view.revision, overrides: { audio_abc_music_play: { '/description': '' } } }]);
  assert.equal(world.tools()[1].description, '');
  assert.equal(view.tools[1].fields[0].source, 'deployment');
  view = await world.invoke('tools', 'save', [{ expectedRevision: view.revision, overrides: { audio_abc_music_play: { '/description': 'Package description.' } } }]);
  assert.equal(existsSync(path), false); assert.equal(view.tools[1].description, 'Package description.');
  assert.equal(JSON.parse(readFileSync(packagePath, 'utf8')).tools.audio_abc_music_play['/description'], 'Package description.');
});

test('stale saves and resets reject changes without losing the newer override', async t => {
  const { world } = setup(t), first = await world.invoke('tools', 'list');
  await world.invoke('tools', 'save', [{ expectedRevision: first.revision, overrides: { audio_abc_music_play: { '/description': 'Newer description.' } } }]);
  await assert.rejects(world.invoke('tools', 'save', [{ expectedRevision: first.revision, overrides: {} }]), /changed/);
  await assert.rejects(world.invoke('tools', 'reset', [{ expectedRevision: first.revision }]), /changed/);
  assert.equal(world.tools()[1].description, 'Newer description.');
});

test('the write boundary rejects structural edits, undeclared tools and nontext values', async t => {
  const { world, path } = setup(t), view = await world.invoke('tools', 'list');
  for (const overrides of [
    { audio_abc_music_play: { '/name': 'renamed' } },
    { audio_abc_music_play: { '/parameters/properties/delivery/enum/0': 'other' } },
    { audio_abc_music_play: { '/parameters/properties/title/maxLength': '1' } },
    { undeclared: { '/description': 'Unknown tool.' } },
    { audio_abc_music_play: { '/description': 12 } },
    { audio_abc_music_play: [] },
  ]) await assert.rejects(world.invoke('tools', 'save', [{ expectedRevision: view.revision, overrides }]));
  assert.equal(existsSync(path), false);
});

test('schema text covers nested arrays, unions and definitions without traversing example data', t => {
  const tool = { name: 'example_act', description: 'Act.', parameters: {
    type: 'object', properties: { 'a/b~c': { type: 'array', items: { oneOf: [{ type: 'string', title: 'Text' }, { type: 'number' }] } } },
    $defs: { item: { type: 'string', description: 'Defined text.' } }, examples: [{ description: 'Example data.' }],
  } };
  const fields = toolTextFields(tool), paths = fields.map(field => field.path);
  assert.ok(paths.includes('/parameters/properties/a~1b~0c/items/oneOf/0/title'));
  assert.ok(paths.includes('/parameters/$defs/item/description'));
  assert.ok(!paths.some(path => path.includes('examples')));
  const { options } = setup(t), store = new ToolTextStore([tool], { ...options, id: def.id }), view = store.read();
  store.save({ expectedRevision: view.revision, overrides: { example_act: { '/parameters/properties/a~1b~0c/items/oneOf/0/title': 'Updated text' } } });
  assert.equal(store.resolve()[0].parameters.properties['a/b~c'].items.oneOf[0].title, 'Updated text');
  assert.equal(tool.parameters.properties['a/b~c'].items.oneOf[0].title, 'Text');
});

test('obsolete overrides are reported and preserved while new default fields remain available', async t => {
  const { world, path } = setup(t);
  write(path, { audio_abc_music_play: { '/parameters/properties/removed/description': 'Old text.' } });
  const view = await world.invoke('tools', 'list');
  assert.deepEqual(view.warnings, [{ layer: 'deployment', tool: 'audio_abc_music_play', path: '/parameters/properties/removed/description' }]);
  assert.deepEqual(view.tools.map(toolSchema), TOOLS.map(toolSchema));
  const overrides = structuredClone(view.overrides); overrides.audio_abc_music_play['/description'] = 'Updated description.';
  await world.invoke('tools', 'save', [{ expectedRevision: view.revision, overrides }]);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tools.audio_abc_music_play['/parameters/properties/removed/description'], 'Old text.');
});

test('malformed override files keep default tools usable and can be explicitly reset', async t => {
  const { world, path } = setup(t);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{broken');
  const view = await world.invoke('tools', 'list');
  assert.deepEqual(world.tools().map(toolSchema), TOOLS.map(toolSchema)); assert.ok(view.warnings[0].error);
  await assert.rejects(world.invoke('tools', 'save', [{ expectedRevision: view.revision, overrides: {} }]), /invalid/);
  assert.equal(readFileSync(path, 'utf8'), '{broken');
  const reset = await world.invoke('tools', 'reset', [{ expectedRevision: view.revision }]);
  assert.equal(existsSync(path), false); assert.deepEqual(reset.warnings, []);
});
