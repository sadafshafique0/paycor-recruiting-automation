// Outreach intake straight from Paycor — no candidate IDs typed in by hand.
//
// At the start of every outreach run, each pipeline job's candidates are read from Paycor's own
// candidate-list request (GET /rest/candidates?q={jobId, stage} — the data behind Paycor's
// candidate grid, confirmed 2026-10-19: candidateId, stage, status code, lastUpdated) with the saved
// login, no browser window. Each candidate's current status says where they are in the recruiting
// steps (Settings → Recruiting steps):
//
//   "Resume Quick Screen" (the resume-screened status)  → new: the first contact email is due
//   the first contact status                             → waiting for a reply since Last Updated
//   the re-check / fluency statuses                      → waiting on that step since Last Updated
//   a reminder's own status (when one is set)            → reminder sent on Last Updated
//
// Candidates already tracked keep the engine's own record. A tracked candidate whose Paycor status is
// no longer one of the pipeline's statuses (someone moved them in Paycor) is stopped, so the app never
// emails a candidate a person has already handled.
//
// Read-only towards Paycor. Candidate names are kept in the outreach state, as before.

const { callPaycor, PaycorAuthError } = require('../paycorData');
const { readSession } = require('../edge');
const { companyIdFrom } = require('../paycorTemplates');
const { readStageCache, refreshStages } = require('../paycorStages');
const { resolvePipeline } = require('../pipelines');
const { loadState, writeState, withFileLock } = require('../state/store');
const { newCandidateRecord } = require('../state/schema');
const { TRACK, CANDIDATE_ID_RE } = require('../engine/constants');

const BASE = 'https://recruitingbypaycor.com';
const PAGE_SIZE = 100;

// Status key → where the candidate is. The first key that names a status wins when several steps
// share one status (e.g. both re-check emails use "Attention to Detail Review" → 1st re-check).
// Reminder keys only count when the team gave that reminder its own status.
const STEP_TRACKS = [
  { key: 'resumeScreened', track: TRACK.NEW, attempt: 0 },
  { key: 'firstContact', track: TRACK.FIRST_CONTACT, attempt: 0 },
  { key: 'firstContactReminder', track: TRACK.FIRST_CONTACT_REMINDED, attempt: 0, reminder: true },
  { key: 'attentionToDetail1', track: TRACK.ATTENTION_1, attempt: 1 },
  { key: 'attentionToDetail1Reminder', track: TRACK.ATTENTION_1_REMINDED, attempt: 1, reminder: true },
  { key: 'attentionToDetail2', track: TRACK.ATTENTION_2, attempt: 2 },
  { key: 'attentionToDetail2Reminder', track: TRACK.ATTENTION_2_REMINDED, attempt: 2, reminder: true },
  { key: 'fluencyEvaluation', track: TRACK.FLUENCY, attempt: 0 },
  { key: 'fluencyReminder', track: TRACK.FLUENCY_REMINDED, attempt: 0, reminder: true },
];

/** Status name → step, for one resolved pipeline. */
function statusSteps(pipeline) {
  const statuses = { resumeScreened: 'Resume Quick Screen', ...(pipeline.targetStatuses || {}) };
  const map = new Map();
  for (const step of STEP_TRACKS) {
    const title = statuses[step.key];
    if (title && !map.has(title)) map.set(title, step);
  }
  return map;
}

/** Paycor's "10/16/2026" → ISO (midday UTC, so the calendar day never shifts). */
function paycorDateToIso(value) {
  const m = String(value || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 12)).toISOString();
}

// Every candidate in a pipeline status is picked up, however long ago Paycor last updated them
// (2026-10-19). One safety limit stays: at most maxNew first-contact emails per run, newest
// first across all jobs — the rest are listed and come on the next runs.
const DEFAULT_PICKUP_DAYS = null; // no age limit
const DEFAULT_MAX_NEW_PER_RUN = 50;

/**
 * Pure: what intake should do, given each pipeline's candidates read from Paycor.
 * @param {Array<{pipeline, rows: Array<{candidateId, name, stage, status, lastUpdated}>|null}>} perPipeline
 *   rows = null when that job couldn't be read (nothing is stopped for it then)
 * @param {Array} stages - Paycor's stage list (src/paycorStages.js), with status numbers
 * @param {object} state - current outreach state (id → record)
 * @returns {{add: object[], stop: Array<{id, pipelineKey}>, perPipeline: Array, tooOld: number, overNewLimit: number}}
 */
function planIntake(perPipeline, stages, state, nowIso, { pickUpWithinDays = DEFAULT_PICKUP_DAYS, maxNew = DEFAULT_MAX_NEW_PER_RUN } = {}) {
  const oldest = pickUpWithinDays ? Date.parse(nowIso) - pickUpWithinDays * 86400000 : -Infinity;
  const statusTitle = (stageNo, statusNo) => {
    const stage = stages.find((s) => String(s.number) === String(stageNo));
    const status = stage && stage.statuses.find((x) => String(x.number) === String(statusNo));
    return status ? status.title : null;
  };
  const stop = [];
  const summary = [];
  const eligible = []; // not yet tracked, recent enough
  let tooOld = 0;
  for (const { pipeline, rows } of perPipeline) {
    const steps = statusSteps(pipeline);
    const counts = { pipelineKey: pipeline.key, jobId: pipeline.jobId, found: 0, added: 0, alreadyTracked: 0, stopped: 0, tooOld: 0, readError: rows ? null : 'not read' };
    const inPipeline = new Set(); // candidates currently in one of this pipeline's statuses
    for (const row of rows || []) {
      const title = statusTitle(row.stage, row.status);
      if (!title || !steps.has(title) || !CANDIDATE_ID_RE.test(String(row.candidateId || ''))) continue;
      inPipeline.add(row.candidateId);
      counts.found++;
      if (state[row.candidateId]) {
        counts.alreadyTracked++;
        continue;
      }
      const since = paycorDateToIso(row.lastUpdated) || nowIso;
      if (Date.parse(since) < oldest) {
        counts.tooOld++;
        tooOld++;
        continue;
      }
      eligible.push({ pipeline, row, title, step: steps.get(title), since, counts });
    }
    // Stop tracked candidates of this pipeline that a person moved out of its statuses in Paycor.
    if (rows) {
      for (const rec of Object.values(state)) {
        if (rec.pipelineKey !== pipeline.key || rec.status !== 'active' || inPipeline.has(rec.id)) continue;
        stop.push({ id: rec.id, pipelineKey: pipeline.key });
        counts.stopped++;
      }
    }
    summary.push(counts);
  }

  // Candidates already part-way through are always picked up; new ones up to the limit, newest first.
  eligible.sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
  const add = [];
  const deferred = []; // new ones over the per-run limit — shown, contacted on a later run
  let newCount = 0;
  let overNewLimit = 0;
  const seen = new Set();
  for (const e of eligible) {
    if (seen.has(e.row.candidateId)) continue; // in two pipelines' lists — the first (newest) wins
    if (e.step.track === TRACK.NEW && newCount >= maxNew) {
      overNewLimit++;
      deferred.push({ candidateId: e.row.candidateId, name: e.row.name || '(unknown name)', pipelineKey: e.pipeline.key, lastUpdated: e.row.lastUpdated });
      continue;
    }
    if (e.step.track === TRACK.NEW) newCount++;
    seen.add(e.row.candidateId);
    const record = newCandidateRecord({ id: e.row.candidateId, name: e.row.name || '(unknown name)', pipelineKey: e.pipeline.key }, nowIso);
    record.track = e.step.track;
    record.attempt = e.step.attempt;
    if (e.step.track !== TRACK.NEW) {
      record.awaitingReplySince = e.since; // the step's email went out when Paycor last updated them
      if (e.step.reminder) record.reminderSentAt = e.since;
    }
    record.history = [{ at: nowIso, event: 'FOUND_IN_PAYCOR', detail: `status "${e.title}" (last updated ${e.row.lastUpdated}), pipeline=${e.pipeline.key}` }];
    add.push(record);
    e.counts.added++;
  }
  return { add, stop, deferred, perPipeline: summary, tooOld, overNewLimit, pickUpWithinDays, maxNew };
}

async function fetchStageRows(jobNumber, stageNumber, cookies, company, fetchImpl) {
  const rows = [];
  for (let page = 0; page < 50; page++) {
    const q = JSON.stringify({ searchFields: [{ name: 'company', query: company }, { name: 'jobId', query: String(jobNumber) }, { name: 'stage', query: stageNumber }] });
    const url = `${BASE}/rest/candidates?accept=application%2Fjson&h=true&page=${page}&pageSize=${PAGE_SIZE}&q=${encodeURIComponent(q)}`;
    const json = await callPaycor(url, { method: 'GET', headers: { accept: 'application/json', 'client-id': company }, redirect: 'manual' }, cookies, fetchImpl);
    const items = json && Array.isArray(json.items) ? json.items : null;
    if (!items) throw new Error("Paycor's candidate list no longer has the expected layout.");
    for (const it of items) rows.push({ candidateId: it.candidateId, name: it.name, stage: it.stage, status: it.status, lastUpdated: it.lastUpdated, dateAdded: it.dateAdded });
    if (items.length < PAGE_SIZE || (json.totalSize != null && rows.length >= json.totalSize)) break;
  }
  return rows;
}

/**
 * Reads every pipeline job's candidates from Paycor and brings the outreach state up to date.
 * Live: adds the newly found candidates and stops the ones moved in Paycor (written to the state file).
 * Dry run: writes nothing and returns the records to use in memory.
 * @returns {Promise<{add, stop, perPipeline, errors: string[]}>}
 */
async function syncOutreachFromPaycor(p, config, { dryRun = false, fetchImpl = fetch, onProgress = () => {}, now = new Date(), pipelineKey = null } = {}) {
  const limits = {
    pickUpWithinDays: DEFAULT_PICKUP_DAYS, // every candidate, however old the last update
    maxNew: (config.outreach && config.outreach.maxNewPerRun) ?? DEFAULT_MAX_NEW_PER_RUN,
  };
  const nowIso = now.toISOString();
  const session = readSession(p.sessionFile);
  const cookies = session && session.cookies;
  if (!Array.isArray(cookies) || !cookies.length) throw new PaycorAuthError('There is no saved Paycor login on this computer.');
  const company = companyIdFrom(cookies);
  if (!company) throw new Error('Could not tell which Paycor company this login belongs to.');
  // The status codes in candidate lists are only readable with the status numbers — re-read the stage
  // list if the saved copy doesn't have them (or is missing).
  let { stages } = readStageCache(p.stagesFile);
  if (!stages.length || !stages.every((s) => s.statuses.every((x) => Number.isFinite(x.number)))) {
    ({ stages } = await refreshStages(p, { cookies, fetchImpl }));
  }
  if (!stages.length) throw new Error("Paycor's stage list could not be read.");

  const errors = [];
  const perPipeline = [];
  const pipelines = (config.pipelines || []).filter((x) => /^\d+$/.test(String(x.jobId || '')) && (!pipelineKey || x.key === pipelineKey));
  for (const [i, raw] of pipelines.entries()) {
    onProgress('Reading candidates from Paycor', i, pipelines.length);
    let pipeline;
    try {
      pipeline = resolvePipeline(config, raw.key);
    } catch (err) {
      errors.push(`${raw.key}: ${err.message}`);
      continue;
    }
    const titles = new Set(statusSteps(pipeline).keys());
    const stageNumbers = stages.filter((s) => s.statuses.some((x) => titles.has(x.title))).map((s) => s.number);
    try {
      const rows = [];
      for (const stageNumber of stageNumbers) rows.push(...(await fetchStageRows(pipeline.jobId, stageNumber, cookies, company, fetchImpl)));
      perPipeline.push({ pipeline, rows });
    } catch (err) {
      if (err.code === 'LOGIN_REQUIRED') throw err;
      errors.push(`Job ${pipeline.jobId}: ${err.message}`);
      perPipeline.push({ pipeline, rows: null });
    }
  }
  onProgress('Reading candidates from Paycor', pipelines.length, pipelines.length);

  if (dryRun) {
    const plan = planIntake(perPipeline, stages, loadState(p.stateFile), nowIso, limits);
    return { ...plan, errors };
  }
  return withFileLock(p.stateFile, () => {
    const state = loadState(p.stateFile);
    const plan = planIntake(perPipeline, stages, state, nowIso, limits);
    for (const rec of plan.add) state[rec.id] = rec;
    for (const s of plan.stop) {
      const rec = state[s.id];
      state[s.id] = { ...rec, status: 'terminal', updatedAt: nowIso, history: [...rec.history, { at: nowIso, event: 'LEFT_PIPELINE_IN_PAYCOR', detail: 'moved out of the pipeline\'s statuses in Paycor — outreach stopped' }] };
    }
    writeState(p.stateFile, state);
    return { ...plan, errors };
  });
}

module.exports = { syncOutreachFromPaycor, planIntake, statusSteps, paycorDateToIso, fetchStageRows, STEP_TRACKS, DEFAULT_PICKUP_DAYS, DEFAULT_MAX_NEW_PER_RUN };
