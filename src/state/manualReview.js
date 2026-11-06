// manualReview.json — the queue of candidates pulled out of the automatic flow (ambiguous "?"
// replies, unresolved candidate IDs, a backlog-cap trip, failed actions, screening verdicts the
// judgment service wasn't confident about, fluency submissions that couldn't be rated). This is
// the exception queue the dashboard renders — the one place a human touches this system.
// Ported as-is from Paycor-Outreach-Toolkit/src/state/manualReview.js, plus `resolve()`/
// `removeManualReview()` so the dashboard can clear an item once a colleague has handled it.

const fs = require('fs');
const path = require('path');
const { stripBom } = require('../stripBom');
const { withFileLock } = require('./store');

function loadManualReview(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  return raw.trim() ? JSON.parse(raw) : [];
}

function writeManualReview(filePath, entries) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * @param {string} filePath
 * @param {{candidateId: string, name: string, reason: string, detail?: string, kind?: string}} entry
 * @param {string} nowIso
 */
function appendManualReview(filePath, entry, nowIso = new Date().toISOString()) {
  return withFileLock(filePath, () => {
    const entries = loadManualReview(filePath);
    entries.push({ ...entry, addedAt: nowIso, resolvedAt: null });
    writeManualReview(filePath, entries);
    return entries;
  });
}

/**
 * Mark one entry resolved (dashboard "I handled this" click) rather than deleting it outright,
 * so there's still a record of what came through the exception queue and how it was closed.
 * Matches by candidateId + addedAt (together unique; candidateId alone can repeat across runs).
 */
function resolveManualReview(filePath, candidateId, addedAt, note, nowIso = new Date().toISOString()) {
  return withFileLock(filePath, () => {
    const entries = loadManualReview(filePath);
    const entry = entries.find((e) => e.candidateId === candidateId && e.addedAt === addedAt);
    if (!entry) throw new Error(`No manual-review entry found for candidateId=${candidateId} addedAt=${addedAt}`);
    entry.resolvedAt = nowIso;
    entry.resolutionNote = note || null;
    writeManualReview(filePath, entries);
    return entry;
  });
}

function findManualReview(filePath, candidateId, addedAt) {
  return loadManualReview(filePath).find((e) => e.candidateId === candidateId && e.addedAt === addedAt) || null;
}

module.exports = { loadManualReview, writeManualReview, appendManualReview, resolveManualReview, findManualReview };
