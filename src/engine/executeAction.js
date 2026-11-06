// Single dispatcher from a trackMachine decision (an ACTION) to the real Paycor-touching call.
// This is the one code path every send/pass/reminder/score goes through — keeping it in one
// place is what makes the history/audit trail in candidatesState.json trustworthy.
//
// Every live action first opens and verifies the target candidate's own profile. The in-page
// send/pass functions act on whatever profile is currently loaded, so without this a timer-driven
// reminder or Pass would land on whichever candidate the reply-checking pass visited last.
//
// dryRun: true short-circuits every Paycor-touching action into a logged no-op.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { ACTION } = require('./constants');
const paycorActions = require('../paycor-actions');
const fluencyScorer = require('../fluency/runFluencyScorer');
const { buildScorecardData } = require('../fluency/scorecardMapping');

const SEND_ACTION_TEMPLATE_KEY = {
  [ACTION.SEND_FIRST_CONTACT]: 'firstContact',
  [ACTION.SEND_FIRST_CONTACT_REMINDER]: 'firstContactReminder',
  [ACTION.SEND_ATTENTION_1]: 'attentionToDetail1',
  [ACTION.SEND_ATTENTION_1_REMINDER]: 'attentionToDetail1Reminder',
  [ACTION.SEND_ATTENTION_2]: 'attentionToDetail2',
  [ACTION.SEND_ATTENTION_2_REMINDER]: 'attentionToDetail2Reminder',
  [ACTION.SEND_FLUENCY]: 'fluencyEvaluation',
  [ACTION.SEND_FLUENCY_REMINDER]: 'fluencyReminder',
};

const SEND_ACTION_STATUS_KEY = {
  [ACTION.SEND_FIRST_CONTACT]: 'firstContact',
  [ACTION.SEND_FIRST_CONTACT_REMINDER]: 'firstContactReminder',
  [ACTION.SEND_ATTENTION_1]: 'attentionToDetail1',
  [ACTION.SEND_ATTENTION_1_REMINDER]: 'attentionToDetail1Reminder',
  [ACTION.SEND_ATTENTION_2]: 'attentionToDetail2',
  [ACTION.SEND_ATTENTION_2_REMINDER]: 'attentionToDetail2Reminder',
  [ACTION.SEND_FLUENCY]: 'fluencyEvaluation',
  [ACTION.SEND_FLUENCY_REMINDER]: 'fluencyReminder',
};

// A reminder's own status is optional (Settings → Recruiting steps); when it isn't set the reminder
// keeps the status of the email it follows up, as before.
const REMINDER_STATUS_FALLBACK = {
  firstContactReminder: 'firstContact',
  attentionToDetail1Reminder: 'attentionToDetail1',
  attentionToDetail2Reminder: 'attentionToDetail2',
  fluencyReminder: 'fluencyEvaluation',
};

function statusFor(pipeline, action) {
  const key = SEND_ACTION_STATUS_KEY[action];
  return pipeline.targetStatuses[key] || pipeline.targetStatuses[REMINDER_STATUS_FALLBACK[key]];
}

const PASS_ACTION_REASON_KEY = {
  [ACTION.PASS_NO_RESPONSE]: 'noResponse',
  [ACTION.PASS_OTHER_QUALIFIED]: 'otherQualified',
};

function describeScores(s) {
  return (
    `Computed scores — Confident Delivery ${s.confidentDelivery}★, Accent ${s.accent}★, Fluency ${s.fluency}★, ` +
    `typing ${s.typingWpm} WPM (${s.typingStars}★), final ${s.finalScore}. Comment: "${s.comment}"`
  );
}

/**
 * @param {import('playwright').Page|null} page - null is only valid when dryRun is true
 * @param {{action: string, pipeline: object, candidateId: string, context?: {replyHtml?: string}}} params
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, dryRun: boolean, action: string, needsManual?: boolean, [k: string]: any}>}
 */
async function executeAction(page, { action, pipeline, candidateId, context = {} }, opts = {}) {
  const dryRun = !!opts.dryRun;

  if (action === ACTION.FLAG_MANUAL_REVIEW || action === ACTION.NONE) {
    return { ok: true, dryRun, action };
  }

  if (action in SEND_ACTION_TEMPLATE_KEY) {
    const templateName = pipeline.templates[SEND_ACTION_TEMPLATE_KEY[action]];
    const statusText = statusFor(pipeline, action);
    if (dryRun) return { ok: true, dryRun: true, action, templateName, statusText };

    await paycorActions.openCandidateProfile(page, candidateId);
    let result = await paycorActions.sendEmailAndAdvance(page, templateName, statusText);
    if (result.error && result.sent) {
      // Email already went out — never resend, only retry the status-change portion.
      result = await paycorActions.retryStatusChangeOnly(page, statusText);
      result.sent = true;
    }
    return { ok: !!result.ok, dryRun: false, action, templateName, statusText, raw: result };
  }

  if (action in PASS_ACTION_REASON_KEY) {
    const reasonLabel = pipeline.passReasons[PASS_ACTION_REASON_KEY[action]];
    if (dryRun) return { ok: true, dryRun: true, action, reasonLabel };

    await paycorActions.openCandidateProfile(page, candidateId);
    const result = await paycorActions.passCandidate(page, reasonLabel);
    return { ok: !!result.ok, dryRun: false, action, reasonLabel, raw: result };
  }

  if (action === ACTION.REQUEST_SCORECARD) {
    // Manual-fallback only — never chosen by trackMachine.
    if (dryRun) return { ok: true, dryRun: true, action, managerEmail: pipeline.managerEmail };
    if (!pipeline.managerEmail) return { ok: true, dryRun: false, action, needsManual: true, reason: 'No hiring manager email is set for this pipeline' };
    const result = await paycorActions.requestScorecard(page, candidateId, pipeline.managerEmail);
    return { ok: !!result.ok, dryRun: false, action, managerEmail: pipeline.managerEmail, raw: result };
  }

  if (action === ACTION.AUTO_SCORE_FLUENCY) {
    if (dryRun) return { ok: true, dryRun: true, action };

    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-fluency-'));
    try {
      const submission = await paycorActions.getFluencySubmission(page, candidateId, downloadDir, { replyHtml: context.replyHtml });

      if (!submission.vocarooLink) {
        return { ok: true, dryRun: false, action, needsManual: true, reason: 'No Vocaroo link found in the candidate\'s reply or Newsfeed' };
      }

      let analyzeOutput;
      try {
        analyzeOutput = await fluencyScorer.runAnalyze(submission.vocarooLink, submission.typingPdfPath);
      } catch (err) {
        // A tooling failure (Python/venv/ffmpeg missing) is a setup problem, not a per-candidate
        // verdict — surface it as a run error rather than burying it in manual review.
        return { ok: false, dryRun: false, action, error: `Fluency analyzer failed: ${err.message}` };
      }

      const scoreData = buildScorecardData(analyzeOutput, submission.vocarooLink);
      if (scoreData.needsManual) {
        return { ok: true, dryRun: false, action, needsManual: true, reason: scoreData.needsManualReason, raw: { analyzeOutput } };
      }

      const typingNote = submission.typingPdfNote ? ` Typing PDF: ${submission.typingPdfNote}.` : '';
      const form = await paycorActions.fillFluencyScorecard(page, candidateId);

      if (form.alreadyScored) {
        return { ok: true, dryRun: false, action, needsManual: true, reason: 'A fluency scorecard already exists for this candidate — not overwritten.' };
      }
      if (form.error) {
        return { ok: true, dryRun: false, action, needsManual: true, reason: `${form.error}. ${describeScores(scoreData)}${typingNote}`, scoreData };
      }
      if (form.incomplete) {
        const problems = [...form.missing, ...form.notSettable.map((f) => `${f}: star widget can't be set automatically yet`)];
        return {
          ok: true,
          dryRun: false,
          action,
          needsManual: true,
          reason: `Enter this scorecard by hand (${problems.join('; ')}). ${describeScores(scoreData)}${typingNote}`,
          scoreData,
        };
      }

      return { ok: false, dryRun: false, action, error: `Unexpected scorecard result: ${JSON.stringify(form)}` };
    } finally {
      fs.rmSync(downloadDir, { recursive: true, force: true });
    }
  }

  throw new Error(`executeAction: no handler for action "${action}"`);
}

module.exports = { executeAction, SEND_ACTION_TEMPLATE_KEY, SEND_ACTION_STATUS_KEY, PASS_ACTION_REASON_KEY };
