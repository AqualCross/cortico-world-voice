import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreTitle } from '../../src/webui/abc/score-title.js';

test('the playback label uses the primary ABC title', () => {
  const abc = 'X:1\nT:Prelude\nT:前奏\nM:4/4\nK:C\nC4 |]';
  assert.equal(scoreTitle(abc), 'Prelude');
});

test('the playback label is empty without an ABC title', () => {
  const abc = 'X:1\r\nM:4/4\r\nK:C\r\nC4 |]';
  assert.equal(scoreTitle(abc), '');
});
