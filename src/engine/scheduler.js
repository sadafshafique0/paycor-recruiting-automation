// The daily orchestrator. Order matters: replies are checked BEFORE timers, so a reply that
// arrived overnight always pre-empts a timer-driven reminder/pass for that same candidate
// today. New-candidate intake runs last and is never timer-gated.
//
// Every dependency that touches a real system (Paycor, the clock) is injected, so this whole
// orchestration — including the backlog safety cap, missed-day behavior, and the
// needs-manual-review fluency path — is unit-testable with fakes.
//
// Adapted from Paycor-Outreach-Toolkit/src/engine/scheduler.js: applyDecision() now also checks
// executeAction's `result.needsManual` flag (set by AUTO_SCORE_FLUENCY when a submission
// couldn't be rated — no usable recording) and reroutes to the manual-review queue even though
// the trackMachine decision itself was "success" — trackMachine can't know in advance whether a
// candidate's specific recording will be ratable; that's an execution-time fact.

const { TRACK, ACTION, TERMINAL_TRACKS } = require('./constants');
const { nextAction } = require('./trackMachine');
const { evaluateTimer } = require('./timers');
const { classifyReply } = require('../classifier');
const { resolvePipeline } = require('../pipelines');
const { loadState, upsertCandidate } = require('../state/store');
const { appendManualReview } = require('../state/manualReview');

const DEFAULT_MAX_PASSES_PER_RUN = 10;

function isLoginRequired(err) {
  return !!err && err.code === 'LOGIN_REQUIRED';
}

/**
 * @param {object} deps
 * @param {string} deps.stateFilePath
 * @param {string} deps.manualReviewFilePath
 * @param {object} deps.config - loaded config.json (pipelines array etc.)
 * @param {Date|string} deps.now
 * @param {(candidate: object) => Promise<{text: string, messageId: string}|null>} deps.fetchReply
 * @param {(page, params: {action, pipeline, candidateId}, opts: {dryRun}) => Promise<{ok: boolean, needsManual?: boolean}>} deps.executeAction
 * @param {*} [deps.page] - Playwright page, passed through to executeAction; unused when dryRun
 * @param {boolean} [deps.dryRun]
 * @param {number} [deps.maxPassesPerRun]
 * @param {{reminderAfterDays: number, timeoutAfterReminderDays: number}} [deps.timerConfig]
 */
async function runDailyCycle(deps) {
  const {
    stateFilePath,
    manualReviewFilePath,
    config,
    now,
    fetchReply,
    executeAction,
    page = null,
    dryRun = false,
    maxPassesPerRun = DEFAULT_MAX_PASSES_PER_RUN,
    timerConfig,
    onProgress = () => {}, // (label, done, total) — shown live on the dashboard
    // Real runs: one last look at the candidate's Paycor profile before a reminder or a pass, in case a
    // reply arrived that the notifications didn't show (e.g. a reply to an email a colleague sent).
    confirmNoReply = null,
    pipelineKey = null, // run for one pipeline only (the dashboard's pipeline dropdown); null = all
  } = deps;

  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const summary = {
    repliesProcessed: 0,
    remindersSent: 0,
    passed: 0,
    scorecardsAutoScored: 0,
    newCandidatesStarted: 0,
    manualReviewAdded: 0,
    errors: [],
    backlogCapTripped: false,
    // Dry runs write nothing — not state, not the manual-review queue — and list what they would
    // have done here instead. Persisting a dry-run "First Contact" would mark a candidate as
    // contacted when no email went out, and a later live run would remind and then Pass them.
    planned: [],
  };

  const state = loadState(stateFilePath);
  // Test runs: candidates just found in Paycor (not saved) and ones a person moved in Paycor (not saved).
  for (const rec of deps.extraCandidates || []) if (!state[rec.id]) state[rec.id] = rec;
  for (const id of deps.stoppedIds || []) if (state[id]) state[id] = { ...state[id], status: 'terminal' };
  const inScope = Object.values(state).filter((c) => !pipelineKey || c.pipelineKey === pipelineKey);
  const handledThisRun = new Set();
  // Candidates whose replies couldn't be checked this run. They must also skip the timer phase:
  // otherwise "couldn't look" turns into "didn't reply" and a timeout Pass.
  const uncheckedThisRun = new Set();

  async function handleReply(candidate, reply) {
    handledThisRun.add(candidate.id);
    summary.repliesProcessed++;
    const outcome = classifyReply(reply.text, { track: candidate.track, attempt: candidate.attempt }).outcome;
    const decision = nextAction(candidate, { type: 'REPLY_RECEIVED', outcome });
    await applyDecision({
      candidate,
      decision,
      config,
      stateFilePath,
      manualReviewFilePath,
      executeAction,
      page,
      dryRun,
      nowIso,
      summary,
      event: { type: 'REPLY_RECEIVED', outcome, messageId: reply.messageId, replyHtml: reply.html, reason: `reply${reply.via ? ` (${reply.via})` : ''}: ${outcome}` },
    });
  }

  // --- Phase 1: replies (always pre-empts timers) ------------------------------------------
  const awaiting = inScope.filter((c) => c.status === 'active' && c.awaitingReplySince);
  let checked = 0;
  onProgress('Checking replies', 0, awaiting.length);
  for (const candidate of inScope) {
    if (candidate.status !== 'active' || !candidate.awaitingReplySince) continue;
    onProgress('Checking replies', checked++, awaiting.length);

    let reply;
    try {
      reply = await fetchReply(candidate);
    } catch (err) {
      if (isLoginRequired(err)) throw err;
      summary.errors.push({ candidateId: candidate.id, phase: 'fetchReply', message: err.message });
      uncheckedThisRun.add(candidate.id);
      continue;
    }
    if (!reply) continue;
    if (candidate.processedMessageIds.includes(reply.messageId)) continue;
    await handleReply(candidate, reply);
  }

  // --- Phase 2: timers (only candidates not already handled by a reply this run) -----------
  const timerQueue = [];
  for (const candidate of inScope) {
    if (handledThisRun.has(candidate.id)) continue;
    if (uncheckedThisRun.has(candidate.id)) continue;
    if (candidate.status !== 'active') continue;

    const event = evaluateTimer(candidate, nowIso, timerConfig);
    if (!event) continue;

    // Never remind or pass someone who has in fact replied: check their profile first.
    if (confirmNoReply) {
      let reply;
      try {
        reply = await confirmNoReply(candidate);
      } catch (err) {
        if (isLoginRequired(err)) throw err;
        summary.errors.push({ candidateId: candidate.id, phase: 'confirmNoReply', message: err.message });
        continue; // couldn't look → do nothing today
      }
      if (reply && !candidate.processedMessageIds.includes(reply.messageId)) {
        await handleReply(candidate, reply);
        continue;
      }
    }

    const decision = nextAction(candidate, event);
    timerQueue.push({ candidate, decision, event });
  }

  onProgress('Checking replies', awaiting.length, awaiting.length);
  const passActions = timerQueue.filter((q) => q.decision.action === ACTION.PASS_NO_RESPONSE);
  const otherTimerActions = timerQueue.filter((q) => q.decision.action !== ACTION.PASS_NO_RESPONSE);

  // Progress for the second half: every email, reminder and pass this run will do.
  const newOnes = inScope.filter((c) => c.track === TRACK.NEW);
  const actionTotal = (passActions.length > maxPassesPerRun ? 0 : passActions.length) + otherTimerActions.length + newOnes.length;
  let actionsDone = 0;
  const stepDone = () => onProgress('Sending emails, reminders and passes', ++actionsDone, actionTotal);
  onProgress('Sending emails, reminders and passes', 0, actionTotal);

  if (passActions.length > maxPassesPerRun) {
    summary.backlogCapTripped = true;
    for (const { candidate, decision } of passActions) {
      summary.manualReviewAdded++;
      if (dryRun) {
        summary.planned.push({ candidateId: candidate.id, name: candidate.name, pipelineKey: candidate.pipelineKey, action: 'QUEUE_FOR_REVIEW', detail: `backlog cap (${decision.passReason})` });
        continue;
      }
      appendManualReview(
        manualReviewFilePath,
        {
          candidateId: candidate.id,
          name: candidate.name,
          reason: 'backlog-cap',
          detail: `Would have been passed (${decision.passReason}) but ${passActions.length} passes queued in one run exceeds maxPassesPerRun=${maxPassesPerRun}`,
        },
        nowIso,
      );
    }
  } else {
    for (const { candidate, decision, event } of passActions) {
      await applyDecision({ candidate, decision, config, stateFilePath, manualReviewFilePath, executeAction, page, dryRun, nowIso, summary, event });
      stepDone();
    }
  }

  for (const { candidate, decision, event } of otherTimerActions) {
    await applyDecision({ candidate, decision, config, stateFilePath, manualReviewFilePath, executeAction, page, dryRun, nowIso, summary, event });
    stepDone();
  }

  // --- Phase 3: new candidate intake (never timer-gated) ------------------------------------
  for (const candidate of newOnes) {
    const decision = nextAction(candidate, { type: 'NEW_CANDIDATE' });
    await applyDecision({
      candidate,
      decision,
      config,
      stateFilePath,
      manualReviewFilePath,
      executeAction,
      page,
      dryRun,
      nowIso,
      summary,
      event: { type: 'NEW_CANDIDATE', reason: 'new candidate intake' },
    });
    summary.newCandidatesStarted++;
    stepDone();
  }

  return summary;
}

function flagManualReview(stateFilePath, manualReviewFilePath, candidate, nowIso, reason, summary, dryRun) {
  summary.manualReviewAdded++;
  if (dryRun) {
    summary.planned.push({ candidateId: candidate.id, name: candidate.name, pipelineKey: candidate.pipelineKey, action: 'QUEUE_FOR_REVIEW', detail: reason });
    return;
  }
  upsertCandidate(stateFilePath, candidate.id, (existing) => ({
    ...existing,
    track: TRACK.MANUAL_REVIEW,
    status: 'terminal',
    updatedAt: nowIso,
    history: [...existing.history, { at: nowIso, event: 'FLAGGED_MANUAL_REVIEW', detail: reason }],
  }));
  appendManualReview(manualReviewFilePath, { candidateId: candidate.id, name: candidate.name, reason }, nowIso);
}

function recordError(stateFilePath, candidate, nowIso, message, dryRun) {
  if (dryRun) return;
  upsertCandidate(stateFilePath, candidate.id, (existing) => ({
    ...existing,
    errorState: { message, at: nowIso, retryCount: (existing.errorState?.retryCount || 0) + 1 },
    updatedAt: nowIso,
    // Never advance track/attempt on failure — retried next run from the same state.
  }));
}

async function applyDecision({ candidate, decision, config, stateFilePath, manualReviewFilePath, executeAction, page, dryRun, nowIso, summary, event }) {
  if (decision.action === ACTION.NONE) {
    if (decision.error) summary.errors.push({ candidateId: candidate.id, phase: 'decision', message: decision.error });
    return;
  }

  if (decision.action === ACTION.FLAG_MANUAL_REVIEW) {
    flagManualReview(stateFilePath, manualReviewFilePath, candidate, nowIso, event.reason, summary, dryRun);
    return;
  }

  let pipeline;
  try {
    pipeline = resolvePipeline(config, candidate.pipelineKey);
  } catch (err) {
    summary.errors.push({ candidateId: candidate.id, phase: 'resolvePipeline', message: err.message });
    recordError(stateFilePath, candidate, nowIso, err.message, dryRun);
    return;
  }

  let result;
  try {
    result = await executeAction(page, { action: decision.action, pipeline, candidateId: candidate.id, context: { replyHtml: event.replyHtml } }, { dryRun });
  } catch (err) {
    if (isLoginRequired(err)) throw err; // an expired session aborts the whole run
    result = { ok: false, action: decision.action, error: err.message };
  }

  if (!result.ok) {
    const message = JSON.stringify(result.raw || result.error || result);
    summary.errors.push({ candidateId: candidate.id, phase: 'executeAction', action: decision.action, message });
    recordError(stateFilePath, candidate, nowIso, `${decision.action} failed: ${message}`, dryRun);
    return;
  }

  // Execution-time discovery that this candidate can't be auto-handled (e.g. an unratable
  // fluency submission) — reroute to manual review even though trackMachine's decision assumed
  // success. See this file's header comment.
  if (result.needsManual) {
    flagManualReview(stateFilePath, manualReviewFilePath, candidate, nowIso, result.reason || 'flagged needsManual by executeAction', summary, dryRun);
    return;
  }

  const isTerminal = TERMINAL_TRACKS.includes(decision.nextTrack);
  const isSend = decision.action.startsWith('SEND_');
  const isPass = decision.action === ACTION.PASS_NO_RESPONSE || decision.action === ACTION.PASS_OTHER_QUALIFIED;
  const isAutoScore = decision.action === ACTION.AUTO_SCORE_FLUENCY;

  if (isPass) summary.passed++;
  if (isAutoScore) summary.scorecardsAutoScored++;
  if (decision.action.includes('REMINDER')) summary.remindersSent++;

  if (dryRun) {
    summary.planned.push({ candidateId: candidate.id, name: candidate.name, pipelineKey: candidate.pipelineKey, action: decision.action, nextTrack: decision.nextTrack, detail: event.reason });
    return;
  }

  upsertCandidate(stateFilePath, candidate.id, (existing) => ({
    ...existing,
    track: decision.nextTrack,
    attempt: decision.attempt !== undefined ? decision.attempt : existing.attempt,
    status: isTerminal ? 'terminal' : 'active',
    passReason: decision.passReason || existing.passReason,
    fluencyScore: isAutoScore && result.scoreData ? result.scoreData.finalScore : existing.fluencyScore,
    lastEmailTemplate: isSend ? result.templateName : existing.lastEmailTemplate,
    lastEmailSentAt: isSend ? nowIso : existing.lastEmailSentAt,
    awaitingReplySince: isSend ? nowIso : isTerminal ? null : existing.awaitingReplySince,
    reminderSentAt: isSend && decision.action.includes('REMINDER') ? nowIso : isSend ? null : existing.reminderSentAt,
    repliedAt: event.type === 'REPLY_RECEIVED' ? nowIso : existing.repliedAt,
    processedMessageIds: event.messageId ? [...existing.processedMessageIds, event.messageId] : existing.processedMessageIds,
    updatedAt: nowIso,
    history: [...existing.history, { at: nowIso, event: decision.action, detail: event.reason }],
  }));
}

module.exports = { runDailyCycle };
