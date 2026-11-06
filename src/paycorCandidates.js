// New applicants for screening, read from Paycor's own candidate-list data (the request behind the
// candidate grid — see src/intake/paycorIntake.js) with the saved login, no window and no scrolling.
// Replaces reading the on-screen grid, which took ~8 s per page and stopped at 2,000 rows (one job had
// 2,366 new applicants on 2026-10-19). Newest applications first, so a fresh applicant is screened in
// the next run even while an old backlog is worked through in batches.

const { readSession } = require('./edge');
const { companyIdFrom } = require('./paycorTemplates');
const { PaycorAuthError } = require('./paycorData');
const { fetchStageRows, paycorDateToIso } = require('./intake/paycorIntake');

const JOB_SEEKER_STAGE = 1; // Paycor's stage number for "Job Seeker" (every source: Site Applicant, Posting Response, …)

/** Pure: newest application first (date added, then last updated). */
function newestFirst(rows) {
  const t = (v) => Date.parse(paycorDateToIso(v) || 0) || 0;
  return [...rows].sort((a, b) => t(b.dateAdded) - t(a.dateAdded) || t(b.lastUpdated) - t(a.lastUpdated));
}

/**
 * Every new applicant (Job Seeker stage) of one job, newest first, as {candidateId, candidateName}.
 * @param {string|number} jobNumber - the Job ID shown in Paycor (e.g. 118)
 */
async function listJobSeekers(p, jobNumber, { fetchImpl = fetch } = {}) {
  const session = readSession(p.sessionFile);
  const cookies = session && session.cookies;
  if (!Array.isArray(cookies) || !cookies.length) throw new PaycorAuthError('There is no saved Paycor login on this computer.');
  const company = companyIdFrom(cookies);
  if (!company) throw new Error('Could not tell which Paycor company this login belongs to.');
  const rows = await fetchStageRows(jobNumber, JOB_SEEKER_STAGE, cookies, company, fetchImpl);
  return newestFirst(rows).map((r) => ({ candidateId: r.candidateId, candidateName: r.name || null, dateAdded: r.dateAdded }));
}

module.exports = { listJobSeekers, newestFirst, JOB_SEEKER_STAGE };
