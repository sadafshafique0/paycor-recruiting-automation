// Resolves a pipeline key (e.g. "hr-director-101") to the exact template names, target
// statuses, manager contact, and Paycor "Pass" reason labels for that job/pipeline.
//
// Where the values come from (highest wins):
//   1. the pipeline's own value in the personal config.json — an optional per-job override;
//   2. the team's shared recruiting steps (team-process.json in the app folder, src/teamProcess.js) —
//      the same for every colleague, so nobody has to rebuild the steps;
//   3. for Pass reasons only, Paycor's standard labels (DEFAULT_PASS_REASONS).
// A blank value means "not set here" and falls through to the next level. Older configs that spell
// out every value per pipeline keep working unchanged — their own values simply win.
//
// Exact label text matters since paycor-actions.js matches by exact string — the Settings page
// offers Paycor's own template names in a dropdown for that reason.

const { SCREENING_PASS_REASONS } = require('./engine/constants');

const DEFAULT_PASS_REASONS = {
  noResponse: 'No response from the candidate',
  otherQualified: 'Other candidates more qualified / better fit',
};

const REQUIRED_TEMPLATE_KEYS = [
  'firstContact',
  'firstContactReminder',
  'attentionToDetail1',
  'attentionToDetail1Reminder',
  'attentionToDetail2', // plain follow-up — confirm live whether this is a saved template or an ad hoc email
  'attentionToDetail2Reminder',
  'fluencyEvaluation',
  'fluencyReminder',
];

// Optional: the status a new applicant moves to once their resume passes screening. Empty = click
// Paycor's green "Resume Quick Screen" button (the original behaviour).
// Each reminder can also have its own status; empty = keep the status of the email it follows up.
const OPTIONAL_TARGET_STATUS_KEYS = ['resumeScreened', 'firstContactReminder', 'attentionToDetail1Reminder', 'attentionToDetail2Reminder', 'fluencyReminder'];

// The screening step, shown first in Settings → Recruiting steps (it sends no email).
const SCREENING_STEP = Object.freeze({ statusKey: 'resumeScreened', label: 'New applicant resume screening', when: "When a new applicant's resume fits the job" });

const REQUIRED_TARGET_STATUS_KEYS = [
  'firstContact',
  'attentionToDetail1',
  'attentionToDetail2',
  'fluencyEvaluation',
];

// The recruiting steps that send an email, in the order a candidate meets them (mirrors
// src/engine/trackMachine.js). `templateKey` / `statusKey` are the keys in templates /
// targetStatuses. A reminder's status is optional: empty falls back to `statusFallbackKey`.
const PROCESS_STEPS = Object.freeze([
  { templateKey: 'firstContact', statusKey: 'firstContact', label: 'First contact email', when: 'Sent to every new candidate in the pipeline' },
  { templateKey: 'firstContactReminder', statusKey: 'firstContactReminder', statusFallbackKey: 'firstContact', label: 'First contact reminder', when: "If they haven't replied after a few days" },
  { templateKey: 'attentionToDetail1', statusKey: 'attentionToDetail1', label: 'Re-check details email (1st try)', when: 'If their reply misses the attention-to-detail check' },
  { templateKey: 'attentionToDetail1Reminder', statusKey: 'attentionToDetail1Reminder', statusFallbackKey: 'attentionToDetail1', label: 'Re-check details reminder (1st try)', when: "If they haven't replied to the re-check" },
  { templateKey: 'attentionToDetail2', statusKey: 'attentionToDetail2', label: 'Re-check details email (2nd try)', when: 'If the second reply still misses the check' },
  { templateKey: 'attentionToDetail2Reminder', statusKey: 'attentionToDetail2Reminder', statusFallbackKey: 'attentionToDetail2', label: 'Re-check details reminder (2nd try)', when: "If they haven't replied to the second re-check" },
  { templateKey: 'fluencyEvaluation', statusKey: 'fluencyEvaluation', label: 'Fluency & typing test email', when: 'When a reply passes the check' },
  { templateKey: 'fluencyReminder', statusKey: 'fluencyReminder', statusFallbackKey: 'fluencyEvaluation', label: 'Fluency & typing test reminder', when: "If they haven't sent the test after a few days" },
]);

const PASS_REASON_STEPS = Object.freeze([
  { key: 'noResponse', label: 'When a candidate never replies' },
  { key: 'otherQualified', label: 'After two failed re-checks' },
]);

const isSet = (v) => v != null && String(v).trim() !== '';

/** Merges value maps left to right; later non-blank values win, blank ones are ignored. */
function mergeValues(...maps) {
  const out = {};
  for (const map of maps) {
    for (const [k, v] of Object.entries(map || {})) if (isSet(v)) out[k] = v;
  }
  return out;
}

/**
 * @param {object} config - personal config ({ pipelines: [...] })
 * @param {string} pipelineKey
 * @param {object|null} [teamProcess] - shared steps ({ templates, targetStatuses, passReasons }); defaults to config.teamProcess
 */
function resolvePipeline(config, pipelineKey, teamProcess = config && config.teamProcess) {
  const pipeline = (config.pipelines || []).find((p) => p.key === pipelineKey);
  if (!pipeline) {
    const known = (config.pipelines || []).map((p) => p.key).join(', ') || '(none configured)';
    throw new Error(`Unknown pipeline "${pipelineKey}". Known pipelines: ${known}`);
  }
  const team = teamProcess || {};
  const templates = mergeValues(team.templates, pipeline.templates);
  const targetStatuses = mergeValues(team.targetStatuses, pipeline.targetStatuses);

  const missingTemplates = REQUIRED_TEMPLATE_KEYS.filter((k) => !templates[k]);
  if (missingTemplates.length) {
    throw new Error(`Pipeline "${pipelineKey}" is missing templates: ${missingTemplates.join(', ')}`);
  }

  const missingStatuses = REQUIRED_TARGET_STATUS_KEYS.filter((k) => !targetStatuses[k]);
  if (missingStatuses.length) {
    throw new Error(`Pipeline "${pipelineKey}" is missing targetStatuses: ${missingStatuses.join(', ')}`);
  }

  // managerEmail is optional: scorecards are never sent to a person automatically (manual fallback only).

  return {
    key: pipeline.key,
    jobId: pipeline.jobId,
    company: pipeline.company,
    sourceStatus: pipeline.sourceStatus,
    templates,
    targetStatuses,
    managerEmail: pipeline.managerEmail || null,
    passReasons: mergeValues(DEFAULT_PASS_REASONS, team.passReasons, pipeline.passReasons),
    // Resume-screening criteria file for this job — see screening-criteria/README.md.
    // Falls back to `screening-criteria/job-<jobId>.md` when not set explicitly.
    screeningCriteriaFile: pipeline.screeningCriteriaFile || null,
  };
}

module.exports = {
  resolvePipeline,
  mergeValues,
  DEFAULT_PASS_REASONS,
  REQUIRED_TEMPLATE_KEYS,
  REQUIRED_TARGET_STATUS_KEYS,
  OPTIONAL_TARGET_STATUS_KEYS,
  SCREENING_STEP,
  PROCESS_STEPS,
  PASS_REASON_STEPS,
  SCREENING_PASS_REASONS,
};
