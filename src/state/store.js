// candidatesState.json load/save. Writes are atomic (write to a temp file, then rename over
// the target) and happen once per candidate action rather than batched at the end of a run —
// a crash mid-run leaves every already-processed candidate's state correctly saved.
// Ported as-is from Paycor-Outreach-Toolkit/src/state/store.js.

const fs = require('fs');
const path = require('path');
const { migrate } = require('./schema');
const { stripBom } = require('../stripBom');

function loadState(stateFilePath) {
  if (!fs.existsSync(stateFilePath)) return {};
  const raw = stripBom(fs.readFileSync(stateFilePath, 'utf8'));
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  const migrated = {};
  for (const [id, record] of Object.entries(parsed)) {
    migrated[id] = migrate(record);
  }
  return migrated;
}

function writeState(stateFilePath, state) {
  const dir = path.dirname(stateFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${stateFilePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, stateFilePath); // atomic on the same volume
}

// The dashboard process and a CLI run process can both read-modify-write the same JSON file;
// without this, one silently drops the other's write.
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 30000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLock(targetPath, fn) {
  const lockPath = `${targetPath}.lock`;
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const start = Date.now();
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lockPath);
      } catch {
        // lock vanished between stat and unlink — just retry
      }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`Timed out waiting for file lock ${lockPath}`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

/**
 * Load the store, apply `updater` to the single candidate record, and write the whole store
 * back out immediately. `updater(existingRecordOrUndefined) -> newRecord`.
 */
function upsertCandidate(stateFilePath, candidateId, updater) {
  return withFileLock(stateFilePath, () => {
    const state = loadState(stateFilePath);
    const next = updater(state[candidateId]);
    state[candidateId] = next;
    writeState(stateFilePath, state);
    return next;
  });
}

// --- Run lock: prevents two scheduled runs (e.g. Task Scheduler double-firing, or a hung
// previous run, or a dashboard click while a cron run is mid-flight) from touching Paycor
// concurrently. ------------------------------------------------------------------------------

const DEFAULT_STALE_LOCK_MS = 2 * 60 * 60 * 1000; // 2 hours — generous for a slow run

function acquireRunLock(lockFilePath, { staleAfterMs = DEFAULT_STALE_LOCK_MS } = {}) {
  if (fs.existsSync(lockFilePath)) {
    const existing = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
    const ageMs = Date.now() - new Date(existing.startedAt).getTime();
    // A run that was stopped (e.g. the dashboard restarted) never released its lock. If that process
    // no longer exists, the lock is dead — take it over instead of blocking every run for hours.
    const holderAlive = (() => {
      if (!Number.isInteger(existing.pid) || existing.pid === process.pid) return true;
      try {
        process.kill(existing.pid, 0); // signal 0 only checks that the process exists
        return true;
      } catch (err) {
        return err.code === 'EPERM'; // exists, but belongs to another user
      }
    })();
    if (ageMs < staleAfterMs && holderAlive) {
      throw new Error(
        `Run lock already held (pid ${existing.pid}, started ${existing.startedAt}, ${Math.round(ageMs / 60000)} min ago). ` +
          `Refusing to start a second run — if the previous run is confirmed dead, delete ${lockFilePath} manually.`,
      );
    }
    // Stale lock — a previous run almost certainly crashed. Proceed, but this is exactly
    // the kind of thing that belongs in the run's NEEDS-ATTENTION report.
  }
  const dir = path.dirname(lockFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFilePath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), 'utf8');
}

function releaseRunLock(lockFilePath) {
  if (fs.existsSync(lockFilePath)) fs.unlinkSync(lockFilePath);
}

module.exports = { loadState, writeState, upsertCandidate, withFileLock, acquireRunLock, releaseRunLock };
