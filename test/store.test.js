const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadState, writeState, upsertCandidate, acquireRunLock, releaseRunLock } = require('../src/state/store');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apw-store-')), name);
}

test('loadState on a missing file returns {}', () => {
  assert.deepEqual(loadState(tmpFile('state.json')), {});
});

test('loadState parses a file saved with a UTF-8 BOM (Notepad/PowerShell)', () => {
  const file = tmpFile('state.json');
  fs.writeFileSync(file, '﻿' + JSON.stringify({ abc: { schemaVersion: 1, track: 'NEW' } }));
  const state = loadState(file);
  assert.equal(state.abc.track, 'NEW');
});

test('writeState then loadState round-trips', () => {
  const file = tmpFile('state.json');
  writeState(file, { x: { schemaVersion: 1, track: 'NEW' } });
  assert.deepEqual(loadState(file), { x: { schemaVersion: 1, track: 'NEW' } });
});

test('upsertCandidate applies the updater and persists it', () => {
  const file = tmpFile('state.json');
  upsertCandidate(file, 'c1', () => ({ schemaVersion: 1, track: 'NEW' }));
  upsertCandidate(file, 'c1', (existing) => ({ ...existing, track: 'FIRST_CONTACT' }));
  assert.equal(loadState(file).c1.track, 'FIRST_CONTACT');
});

test('run lock: second acquire fails while the first is fresh', () => {
  const lockFile = tmpFile('run.lock');
  acquireRunLock(lockFile);
  assert.throws(() => acquireRunLock(lockFile), /Run lock already held/);
  releaseRunLock(lockFile);
  assert.doesNotThrow(() => acquireRunLock(lockFile));
  releaseRunLock(lockFile);
});

test('a stale lock (older than staleAfterMs) is not blocking', () => {
  const lockFile = tmpFile('run.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }));
  assert.doesNotThrow(() => acquireRunLock(lockFile, { staleAfterMs: 60 * 1000 }));
  releaseRunLock(lockFile);
});

test('a fresh lock left by a run that no longer exists is taken over', () => {
  const lockFile = tmpFile('run.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, startedAt: new Date().toISOString() })); // no such process
  assert.doesNotThrow(() => acquireRunLock(lockFile));
  releaseRunLock(lockFile);
});
