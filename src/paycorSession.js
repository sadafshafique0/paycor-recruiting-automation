// Tracks whether this computer's automation Edge profile is logged in to Paycor, and caches the
// job list read from Paycor at login / refresh. Both files live in %LOCALAPPDATA% next to the
// rest of the personal data. Passwords are never seen or stored here: the person logs in on
// Paycor's own login page in the automation window; the session lives in that browser profile.

const fs = require('fs');
const path = require('path');
const { paths } = require('./config');
const { stripBom } = require('./stripBom');

function readJson(file) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readConnection() {
  const c = readJson(paths().connectionFile);
  return { connected: !!(c && c.connected), lastConnectedAt: (c && c.lastConnectedAt) || null, disconnectedAt: (c && c.disconnectedAt) || null };
}

function markConnected() {
  writeJson(paths().connectionFile, { connected: true, lastConnectedAt: new Date().toISOString() });
}

/** Called whenever any run lands on Paycor's login page — the dashboard then asks for a login. */
function markDisconnected() {
  const prev = readConnection();
  writeJson(paths().connectionFile, { connected: false, lastConnectedAt: prev.lastConnectedAt, disconnectedAt: new Date().toISOString() });
}

function saveJobs(jobs, extra = {}) {
  // Priority names ("Urgent", …) are only visible on Paycor's cards, so a windowless refresh keeps
  // the ones learned at the last login.
  const priorityLabels = { ...(readJobs().priorityLabels || {}), ...(extra.priorityLabels || {}) };
  writeJson(paths().jobsFile, { syncedAt: new Date().toISOString(), jobs, ...extra, priorityLabels });
}

/** The fields of a loaded job list that are saved alongside the jobs. */
function jobListExtras(loaded) {
  return {
    totalReported: loaded.totalReported ?? loaded.total ?? null,
    scope: loaded.scope,
    scopeNote: loaded.scopeNote,
    source: loaded.source,
    hasMyJobs: !!loaded.hasMyJobs,
    priorityLabels: loaded.priorityLabels || {},
  };
}

function readJobs() {
  return readJson(paths().jobsFile) || { syncedAt: null, jobs: [] };
}

/**
 * Saves the raw markup of the first job cards and the job-list filter from the Paycor home page,
 * for fixing the job-list reader against Paycor's real layout. The cards' pipeline columns, which
 * list candidates by name, are removed before saving (see readRenderedJobCards).
 */
function writeHomeSnapshot(snapshot) {
  const file = paths().homeSnapshotFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const parts = [
    `<!-- Paycor home snapshot ${new Date().toISOString()} | header: ${String(snapshot.header || '').replace(/--/g, '')} | scope: ${String(snapshot.scope || '').replace(/--/g, '')} | note: ${String(snapshot.scopeNote || '').replace(/--/g, '')} -->`,
    '<!-- job-list filter -->',
    snapshot.filterHtml || '(not found)',
    '<!-- filter options (overlay after clicking it) -->',
    snapshot.optionsHtml || '(not captured)',
    ...(snapshot.cardsHtml || []).map((html, i) => `<!-- job card ${i + 1} -->\n${html}`),
  ];
  fs.writeFileSync(file, parts.join('\n\n'), 'utf8');
}

/** Forget this computer's Paycor login: the automation browser profile, the status and the job cache. */
function logOut() {
  const p = paths();
  // The saved request can carry Paycor's per-login tokens in its headers, so it goes too.
  for (const target of [p.edgeProfileDir, p.connectionFile, p.jobsFile, p.sessionFile, p.recipeFile]) fs.rmSync(target, { recursive: true, force: true });
}

module.exports = { readConnection, markConnected, markDisconnected, saveJobs, jobListExtras, readJobs, writeHomeSnapshot, logOut };
