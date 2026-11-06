const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractProgress, stripResultLines, PROGRESS_MARKER } = require('../src/cliResult');
const { resolvePipeline, REQUIRED_TEMPLATE_KEYS } = require('../src/pipelines');
const { runScreeningSweep } = require('../src/screening/runScreeningSweep');

test('the latest progress line is read for the dashboard and kept out of the technical log', () => {
  const out = `starting\n${PROGRESS_MARKER}{"label":"Screening resumes","done":1,"total":3}\nlog line\n${PROGRESS_MARKER}{"label":"Screening resumes","done":2,"total":3}\n`;
  assert.deepEqual(extractProgress(out), { label: 'Screening resumes', done: 2, total: 3 });
  assert.equal(stripResultLines(out), 'starting\nlog line');
  assert.equal(extractProgress(`${PROGRESS_MARKER}{"label":"Scr`), null); // still arriving
});

test('a pipeline no longer needs a hiring manager email', () => {
  const config = { pipelines: [{ key: 'job-1', jobId: '1', templates: Object.fromEntries(REQUIRED_TEMPLATE_KEYS.map((k) => [k, 'T'])), targetStatuses: { firstContact: 'A', attentionToDetail1: 'B', attentionToDetail2: 'B', fluencyEvaluation: 'C' } }] };
  assert.equal(resolvePipeline(config, 'job-1', {}).managerEmail, null);
});

test('a test run reports progress, says where a good fit would go, and adds nothing to Needs attention', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-progress-'));
  const criteriaDir = path.join(dir, 'criteria');
  fs.mkdirSync(criteriaDir);
  fs.writeFileSync(path.join(criteriaDir, 'job-7.rules.json'), JSON.stringify({ requiredSkills: ['CDL', 'forklift'] }));
  const filler = 'Reliable, punctual and hard working with great customer service every single day. '.repeat(6);
  const resumes = { a: `CDL driver with forklift experience, Jan 2019 - Present. ${filler}`, b: `CDL driver, Jan 2019 - Present. ${filler}`, c: `Line cook, Jan 2019 - Present. ${filler}` };
  const actions = {
    findJobCard: async () => ({ matches: [{ jobId: '7', title: 'Driver', jobSeekerHref: '/x' }] }),
    scrapeJobSeekers: async () => Object.keys(resumes).map((id) => ({ candidateId: id, candidateName: id })),
    readResumeText: async (page, id) => ({ text: resumes[id], method: 'file' }),
  };
  const progress = [];
  const reviewFile = path.join(dir, 'review.json');
  const result = await runScreeningSweep({
    page: {},
    jobQuery: '7',
    screeningCriteriaDir: criteriaDir,
    screeningResultsDir: path.join(dir, 'results'),
    manualReviewFilePath: reviewFile,
    pipeline: { key: 'p', targetStatuses: { resumeScreened: 'Resume Quick Screen' } },
    dryRun: true,
    actions,
    onProgress: (label, done, total) => progress.push(`${label} ${done}/${total}`),
  });
  assert.ok(progress.includes('Screening resumes 0/3') && progress.includes('Screening resumes 3/3'));
  assert.equal(result.screenedStatus, 'Resume Quick Screen');
  assert.deepEqual(result.candidates.map((c) => c.outcome), ['accepted', 'manual_review', 'rejected']);
  assert.equal(result.candidates[1].checks.find((k) => k.name === 'Required').result, 'unsure');
  assert.equal(result.candidates[2].checks.find((k) => k.name === 'Required').result, 'fail');
  assert.equal(fs.existsSync(reviewFile), false); // the unsure one was not queued — it's only a test run
});
