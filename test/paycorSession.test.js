const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-session-'));
const session = require('../src/paycorSession');
const { paths } = require('../src/config');

test('a fresh computer is not connected and has no jobs', () => {
  assert.equal(session.readConnection().connected, false);
  assert.deepEqual(session.readJobs(), { syncedAt: null, jobs: [] });
});

test('connect → disconnect keeps the last-connected time, so the dashboard can say "session ended"', () => {
  session.markConnected();
  const connected = session.readConnection();
  assert.equal(connected.connected, true);
  session.markDisconnected();
  const after = session.readConnection();
  assert.equal(after.connected, false);
  assert.equal(after.lastConnectedAt, connected.lastConnectedAt);
  assert.ok(after.disconnectedAt);
});

test('jobs are cached with the time they were read', () => {
  session.saveJobs([{ jobId: '146', title: 'Diesel Mechanic', jobSeekerCount: 3 }], { totalReported: 1 });
  const cache = session.readJobs();
  assert.equal(cache.jobs[0].title, 'Diesel Mechanic');
  assert.equal(cache.totalReported, 1);
  assert.ok(cache.syncedAt);
});

test('logging out removes the saved browser login, the status and the job cache', () => {
  fs.mkdirSync(path.join(paths().edgeProfileDir, 'Default'), { recursive: true });
  session.markConnected();
  session.logOut();
  assert.equal(fs.existsSync(paths().edgeProfileDir), false);
  assert.equal(session.readConnection().connected, false);
  assert.deepEqual(session.readJobs().jobs, []);
});
