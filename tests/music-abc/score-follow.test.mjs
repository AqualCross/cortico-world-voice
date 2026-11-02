import test from 'node:test';
import assert from 'node:assert/strict';
import { eventAt, followScore } from '../../src/webui/abc/score-follow.js';

const events = [
  { type: 'event', milliseconds: 0, left: 50, top: 20, width: 15, height: 60 },
  { type: 'event', milliseconds: 500, left: 90, top: 20, width: 15, height: 60 },
  { type: 'event', milliseconds: 1000, left: 50, top: 20, width: 15, height: 60 },
  { type: 'end', milliseconds: 1500 },
];

test('audio time locates repeated notes, backward seeks and the audio tail', () => {
  assert.equal(eventAt(events, 0), events[0]);
  assert.equal(eventAt(events, .7), events[1]);
  assert.equal(eventAt(events, 1), events[2]);
  assert.equal(eventAt(events, .1), events[0]);
  assert.equal(eventAt(events, 1.5), null);
  assert.equal(eventAt(events, 2), null);
  assert.equal(eventAt([], 0), null);
});

test('cursor follows seeks, retains paused position and clears inactive or ended audio', () => {
  const previous = globalThis.document;
  const attrs = {}, cursor = { style: {}, setAttribute(key, value) { attrs[key] = value; } };
  globalThis.document = { createElementNS() { return cursor; } };
  try {
    const audio = { currentTime: 0, ended: false, paused: false };
    const follower = followScore({ querySelector() { return { append() {} }; } }, { setTiming() { return events; } }, audio);
    follower.update(true);
    assert.equal(attrs.x, 47);
    audio.currentTime = .5; audio.paused = true;
    follower.update(true);
    assert.equal(attrs.x, 87);
    assert.equal(cursor.style.display, '');
    audio.currentTime = 1;
    follower.update(true);
    assert.equal(attrs.x, 47);
    follower.update(false);
    assert.equal(cursor.style.display, 'none');
    audio.ended = true;
    follower.update(true);
    assert.equal(cursor.style.display, 'none');
  } finally { globalThis.document = previous; }
});

test('playback frames within one note leave the SVG unchanged', () => {
  const previous = globalThis.document;
  let mutations = 0;
  const cursor = { style: {}, setAttribute() { mutations++; } };
  globalThis.document = { createElementNS() { return cursor; } };
  try {
    const audio = { currentTime: 0, ended: false };
    const follower = followScore({ querySelector() { return { append() {} }; } }, { setTiming() { return events; } }, audio);
    follower.update(true);
    const initial = mutations;
    for (let frame = 1; frame < 30; frame++) { audio.currentTime = frame / 60; follower.update(true); }
    assert.equal(mutations, initial);
    audio.currentTime = .5; follower.update(true);
    assert.ok(mutations > initial);
  } finally { globalThis.document = previous; }
});
