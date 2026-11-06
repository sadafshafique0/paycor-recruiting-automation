const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendManualReview, loadManualReview, resolveManualReview } = require('../src/state/manualReview');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apw-mr-')), 'manualReview.json');
}

test('appendManualReview starts unresolved', () => {
  const file = tmpFile();
  appendManualReview(file, { candidateId: 'c1', name: 'Jane', reason: 'test' }, '2026-01-01T00:00:00.000Z');
  const entries = loadManualReview(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].resolvedAt, null);
});

test('resolveManualReview marks the matching entry resolved and leaves others untouched', () => {
  const file = tmpFile();
  appendManualReview(file, { candidateId: 'c1', name: 'Jane', reason: 'a' }, '2026-01-01T00:00:00.000Z');
  appendManualReview(file, { candidateId: 'c2', name: 'Joe', reason: 'b' }, '2026-01-02T00:00:00.000Z');

  resolveManualReview(file, 'c1', '2026-01-01T00:00:00.000Z', 'handled by Alex', '2026-01-03T00:00:00.000Z');

  const entries = loadManualReview(file);
  const c1 = entries.find((e) => e.candidateId === 'c1');
  const c2 = entries.find((e) => e.candidateId === 'c2');
  assert.equal(c1.resolvedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(c1.resolutionNote, 'handled by Alex');
  assert.equal(c2.resolvedAt, null);
});

test('resolveManualReview throws on an unknown candidateId/addedAt pair rather than silently no-op', () => {
  const file = tmpFile();
  appendManualReview(file, { candidateId: 'c1', name: 'Jane', reason: 'a' }, '2026-01-01T00:00:00.000Z');
  assert.throws(() => resolveManualReview(file, 'c1', '1999-01-01T00:00:00.000Z'), /No manual-review entry found/);
});
