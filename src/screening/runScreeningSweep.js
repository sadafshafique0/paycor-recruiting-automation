// Orchestrates one full resume-screening run for a single job: find it, find its Job Seeker
// applicants, judge each resume against the job's criteria file, and act — advance a good fit to
// Resume Quick Screen (and enroll them in the outreach pipeline), Pass a poor fit with the
// matching reason, or leave it untouched and queue it for a human. Mirrors Paycor-full-package's
// /paycor-screen rules: one job per run, never screens without criteria, never Passes a candidate
// with no resume on file or one who has already left the Job Seeker stage.
//
// Two ways to judge a resume (config.json → screening.engine):
//   'rules'  (default) — the job's screening rules (job-<id>.rules.json) applied to the resume's
//            text: free, offline, the same on every computer. See ./rules.js.
//   'claude' — the Claude API reads screenshots against the job description (job-<id>.md). Optional.

const fs = require('fs');
const { jobDescriptionFor } = require('../jobDescriptions');
const path = require('path');
const defaultActions = require('../paycor-actions');
const { judgeResume } = require('./resumeJudge');
const { evaluateResume, normalizeRules } = require('./rules');
const { appendManualReview } = require('../state/manualReview');
const { addCandidates } = require('../intake/addCandidates');
const { SCREENING_VERDICT, SCREENING_PASS_REASONS } = require('../engine/constants');

const DEFAULT_MAX_SCREENING_PASSES_PER_RUN = 25;

function criteriaPathFor(jobId, pipeline, screeningCriteriaDir) {
  if (pipeline && pipeline.screeningCriteriaFile) return pipeline.screeningCriteriaFile;
  return path.join(screeningCriteriaDir, `job-${jobId}.md`);
}

function rulesPathFor(jobId, screeningCriteriaDir) {
  return path.join(screeningCriteriaDir, `job-${jobId}.rules.json`);
}

const rulesJudge = (resume, rules) => evaluateResume(resume.text, rules, { method: resume.method });

/**
 * Re-opens the candidate, confirms they're still a Job Seeker, then accepts or Passes and checks
 * the click actually worked. Shared by the sweep and the dashboard's Accept/Pass buttons.
 * Accepting moves the candidate to `screenedStatus` when the team chose one (the "resume screened"
 * step), otherwise clicks Paycor's own "Resume Quick Screen" button.
 * @returns {Promise<{ok: boolean, outcome?: string, error?: string, currentStage?: string}>}
 */
async function actOnScreeningCandidate({ page, candidateId, decision, reason, screenedStatus = null, actions = defaultActions }) {
  if (decision === 'pass' && !SCREENING_PASS_REASONS.includes(reason)) {
    return { ok: false, error: `"${reason}" is not one of the fixed screening Pass reasons` };
  }
  await actions.openCandidateProfile(page, candidateId);
  const currentStage = await actions.readCurrentStage(page);
  if (!actions.isJobSeekerStage(currentStage)) {
    return { ok: false, outcome: 'already_moved', currentStage, error: `candidate is no longer a Job Seeker (stage: ${currentStage || 'unknown'})` };
  }
  let result;
  if (decision === 'pass') result = await actions.passCandidate(page, reason);
  else if (!screenedStatus || /^resume quick screen$/i.test(screenedStatus.trim())) {
    // "Resume Quick Screen" of the job's own pipeline: Paycor's green next-step button does exactly
    // that. Only if the button isn't there is the status picked from the stage menu instead.
    result = await actions.advanceResumeQuickScreen(page);
    if (!result.ok && screenedStatus && /no "Resume Quick Screen" button/.test(result.error || '')) result = await actions.moveToStatus(page, screenedStatus);
  } else result = await actions.moveToStatus(page, screenedStatus);
  return result.ok ? { ok: true } : { ok: false, error: result.error || JSON.stringify(result) };
}

/**
 * @param {object} deps
 * @param {import('playwright').Page} deps.page
 * @param {string} deps.jobQuery - numeric Job ID or title fragment
 * @param {string} deps.screeningCriteriaDir
 * @param {string} deps.screeningResultsDir
 * @param {string} deps.manualReviewFilePath
 * @param {string} [deps.stateFilePath] - needed to enroll accepted candidates into outreach
 * @param {object|null} [deps.pipeline] - resolved pipeline accepted candidates are enrolled into
 * @param {boolean} [deps.dryRun] - judge and log, but never click anything in Paycor
 * @param {number} [deps.maxPassesPerRun]
 * @param {'rules'|'claude'} [deps.engine]
 * @param {string} [deps.ocrCachePath] - where Tesseract keeps its language file (rules engine, scanned resumes)
 * @param {Function} [deps.judge] - injectable for tests
 * @param {object} [deps.actions] - injectable for tests
 */
async function runScreeningSweep(deps) {
  const {
    page,
    jobQuery,
    screeningCriteriaDir,
    screeningResultsDir,
    manualReviewFilePath,
    stateFilePath = null,
    pipeline = null,
    dryRun = false,
    maxPassesPerRun = DEFAULT_MAX_SCREENING_PASSES_PER_RUN,
    engine = 'rules',
    ocrCachePath = null,
    actions = defaultActions,
    onProgress = () => {}, // (label, done, total) — shown live on the dashboard
    listJobSeekers = null, // (job) => new applicants from Paycor's data, newest first (src/paycorCandidates.js); else the grid is read
    maxCandidatesPerRun = null, // screen at most this many (newest first); the rest wait for the next run
    jobDescriptionsFile = null, // descriptions copied from Paycor (src/jobDescriptions.js) — used when no job-<id>.md was saved
    jobs = null, // job list already fetched from Paycor's data (src/jobLoader.js) — avoids reading the home page
  } = deps;
  const judge = deps.judge || (engine === 'claude' ? judgeResume : rulesJudge);

  const { matches, totalJobsSeen, error } = await actions.findJobCard(page, jobQuery, { jobs });
  if (error) return { status: 'error', detail: error };
  if (matches.length === 0) return { status: 'job_not_found', jobQuery, totalJobsSeen };
  if (matches.length > 1) return { status: 'ambiguous_job', jobQuery, matches: matches.map((m) => ({ jobId: m.jobId, title: m.title })) };
  const job = matches[0];

  if (!job.jobSeekerHref) return { status: 'no_new_applicants', jobId: job.jobId, title: job.title };

  let criteria;
  if (engine === 'claude') {
    const criteriaPath = criteriaPathFor(job.jobId, pipeline, screeningCriteriaDir);
    const fromPaycor = jobDescriptionsFile ? jobDescriptionFor(jobDescriptionsFile, job.jobId) : null;
    if (fs.existsSync(criteriaPath)) criteria = fs.readFileSync(criteriaPath, 'utf8');
    else if (fromPaycor && fromPaycor.text) criteria = fromPaycor.text;
    else return { status: 'missing_criteria', engine, jobId: job.jobId, title: job.title, expectedPath: criteriaPath };
  } else {
    const rulesPath = rulesPathFor(job.jobId, screeningCriteriaDir);
    if (!fs.existsSync(rulesPath)) return { status: 'missing_criteria', engine, jobId: job.jobId, title: job.title, expectedPath: rulesPath };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    } catch {
      return { status: 'invalid_rules', engine, jobId: job.jobId, title: job.title, problems: ['The saved rules file could not be read. Save the rules again.'] };
    }
    const { rules, problems } = normalizeRules(raw);
    if (problems.length) return { status: 'invalid_rules', engine, jobId: job.jobId, title: job.title, problems };
    criteria = rules;
  }

  onProgress('Finding the new applicants in Paycor', 0, 0);
  const waiting = listJobSeekers ? await listJobSeekers(job) : await actions.scrapeJobSeekers(page, job.jobSeekerHref);
  const candidates = maxCandidatesPerRun ? waiting.slice(0, maxCandidatesPerRun) : waiting;

  const nowIso = new Date().toISOString();
  const run = { startedAt: nowIso, jobId: job.jobId, title: job.title, dryRun, pipelineKey: pipeline ? pipeline.key : null, candidates: [] };
  const logPath = path.join(screeningResultsDir, `${nowIso.slice(0, 10)}.json`);
  const writeLog = () => {
    if (!fs.existsSync(screeningResultsDir)) fs.mkdirSync(screeningResultsDir, { recursive: true });
    const existing = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : { runs: [] };
    const idx = existing.runs.findIndex((r) => r.startedAt === run.startedAt && r.jobId === run.jobId);
    if (idx === -1) existing.runs.push(run);
    else existing.runs[idx] = run;
    fs.writeFileSync(logPath, JSON.stringify(existing, null, 2), 'utf8');
  };
  writeLog();

  const ctx = { page, criteria, engine, ocrCachePath, manualReviewFilePath, stateFilePath, pipeline, dryRun, nowIso, judge, actions, maxPassesPerRun, passesThisRun: 0 };
  onProgress('Screening resumes', 0, candidates.length);
  let stoppedAtPassCap = false;
  for (const cand of candidates) {
    // Once this run has made its automatic Passes, stop — the rest wait for the next run rather than
    // piling up in Needs attention (and a run of wrong rules can never pass more than the limit).
    if (!dryRun && ctx.passesThisRun >= maxPassesPerRun) {
      stoppedAtPassCap = true;
      break;
    }
    const outcome = await screenOneCandidate(ctx, cand.candidateId, cand.candidateName);
    run.candidates.push(outcome);
    onProgress('Screening resumes', run.candidates.length, candidates.length);
    writeLog(); // after every candidate, so an interrupted run still records who was acted on
  }

  const count = (pred) => run.candidates.filter(pred).length;
  return {
    status: 'completed',
    engine,
    jobId: job.jobId,
    title: job.title,
    dryRun,
    totalCandidates: run.candidates.length,
    advanced: count((r) => r.action === 'advanced'),
    enrolled: count((r) => r.enrolled),
    passed: count((r) => r.action === 'passed'),
    skippedNoResume: count((r) => r.outcome === 'no_resume_on_file'),
    skippedAlreadyMoved: count((r) => r.outcome === 'already_moved'),
    manualReview: count((r) => r.outcome === 'manual_review'),
    errors: count((r) => r.outcome === 'error'),
    passCapReached: ctx.passesThisRun >= maxPassesPerRun,
    stoppedAtPassCap,
    totalWaiting: waiting.length, // new applicants in Paycor when the run started
    leftForNextRun: waiting.length - run.candidates.length,
    // Where a good fit goes — the team's "resume screened" status (Settings → Recruiting steps).
    screenedStatus: (pipeline && pipeline.targetStatuses && pipeline.targetStatuses.resumeScreened) || 'Resume Quick Screen',
    logPath,
    candidates: run.candidates.map((r) => ({
      candidateId: r.candidateId,
      name: r.name,
      outcome: r.outcome,
      action: r.action,
      enrolled: !!r.enrolled,
      reason: r.verdict ? r.verdict.reason : null,
      evidence: r.verdict ? r.verdict.evidence : null,
      checks: r.verdict && Array.isArray(r.verdict.checks) ? r.verdict.checks : null, // each rule: pass / fail / unsure / info
      readBy: r.readBy || null,
      detail: r.detail || null,
    })),
  };
}

async function screenOneCandidate(ctx, candidateId, candidateName) {
  const { page, criteria, engine, ocrCachePath, manualReviewFilePath, stateFilePath, pipeline, dryRun, nowIso, judge, actions } = ctx;
  const name = candidateName || candidateId;
  const queue = (reason, verdict) =>
    appendManualReview(
      manualReviewFilePath,
      {
        candidateId,
        name,
        kind: 'screening',
        pipelineKey: pipeline ? pipeline.key : null,
        suggestedVerdict: verdict ? verdict.verdict : null,
        suggestedReason: verdict ? verdict.reason : null,
        reason,
      },
      nowIso,
    );

  try {
    const resume = engine === 'claude' ? await actions.screenshotResumePages(page, candidateId) : await actions.readResumeText(page, candidateId, { ocrCachePath });
    if (resume.error) return { candidateId, name, outcome: 'error', detail: resume.error, action: 'none' };
    if (resume.alreadyMoved) return { candidateId, name, outcome: 'already_moved', detail: resume.currentStage, action: 'none' };
    if (resume.noResumeOnFile) return { candidateId, name, outcome: 'no_resume_on_file', action: 'none' }; // reported, never Passed

    const judged = engine === 'claude' ? await judge(resume.screenshots, criteria) : await judge(resume, criteria);
    const verdict = resume.note ? { ...judged, evidence: `${resume.note} ${judged.evidence || ''}`.trim() } : judged;
    const readBy = engine === 'claude' ? 'Claude AI' : { file: 'resume file', application: 'application form', ocr: 'scan (OCR)' }[resume.method] || null;

    if (verdict.flagLowConfidence) {
      // A test run changes nothing — not even the Needs attention list.
      if (dryRun) return { candidateId, name, outcome: 'manual_review', verdict, readBy, action: 'none (dry run)' };
      queue(`Screening verdict needs review (${verdict.verdict}, confidence ${verdict.confidence}): ${verdict.evidence}`, verdict);
      return { candidateId, name, outcome: 'manual_review', verdict, readBy, action: 'none' };
    }

    if (verdict.verdict === SCREENING_VERDICT.REJECT && ctx.passesThisRun >= ctx.maxPassesPerRun) {
      queue(`Would have been Passed (${verdict.reason}) but this run already hit the cap of ${ctx.maxPassesPerRun} automatic Passes: ${verdict.evidence}`, verdict);
      return { candidateId, name, outcome: 'manual_review', verdict, readBy, action: 'none', detail: 'pass cap reached' };
    }

    if (dryRun) {
      return { candidateId, name, outcome: verdict.verdict === SCREENING_VERDICT.ACCEPT ? 'accepted' : 'rejected', verdict, readBy, action: 'none (dry run)' };
    }

    const decision = verdict.verdict === SCREENING_VERDICT.ACCEPT ? 'accept' : 'pass';
    const screenedStatus = (pipeline && pipeline.targetStatuses && pipeline.targetStatuses.resumeScreened) || null;
    const acted = await actOnScreeningCandidate({ page, candidateId, decision, reason: verdict.reason, screenedStatus, actions });
    if (!acted.ok) {
      if (acted.outcome === 'already_moved') return { candidateId, name, outcome: 'already_moved', detail: acted.currentStage, verdict, readBy, action: 'none' };
      queue(`Tried to ${decision} but it failed: ${acted.error}`, verdict);
      return { candidateId, name, outcome: 'error', detail: acted.error, verdict, readBy, action: 'none' };
    }

    if (decision === 'pass') {
      ctx.passesThisRun++;
      return { candidateId, name, outcome: 'rejected', verdict, readBy, action: 'passed' };
    }

    let enrolled = false;
    if (pipeline && stateFilePath) {
      const { added } = addCandidates(stateFilePath, [{ id: candidateId, name: candidateName }], pipeline.key);
      enrolled = added.includes(candidateId);
    }
    return { candidateId, name, outcome: 'accepted', verdict, readBy, action: 'advanced', enrolled };
  } catch (err) {
    if (actions.isLoginRequired(err)) throw err; // an expired session stops the whole sweep
    return { candidateId, name, outcome: 'error', detail: err.message, action: 'none' };
  }
}

module.exports = { runScreeningSweep, screenOneCandidate, actOnScreeningCandidate, criteriaPathFor, DEFAULT_MAX_SCREENING_PASSES_PER_RUN };
