#!/usr/bin/env node
// Runs one resume-screening sweep for a single job. This is what the dashboard's "Screen this
// job" button shells out to, and what Task Scheduler could call directly.
//
// Usage:
//   node cli/screen-job.js --job 146 --pipeline hr-director-101
//   DRY_RUN=true node cli/screen-job.js --job 146     (judge and log, never click Paycor)
//
// --pipeline is the outreach pipeline accepted candidates get enrolled into. Without it, accepted
// candidates are advanced in Paycor but never sent First Contact.

const path = require('path');
const { paths, loadConfig, loadEnvFile } = require('../src/config');
const { launchEdge, savedUserAgent, closeEdge } = require('../src/edge');
const { acquireRunLock, releaseRunLock } = require('../src/state/store');
const { runScreeningSweep } = require('../src/screening/runScreeningSweep');
const { resolvePipeline } = require('../src/pipelines');
const { isLoginRequired } = require('../src/paycor-actions');
const { printResult, printProgress } = require('../src/cliResult');
const { listJobSeekers } = require('../src/paycorCandidates');
const { loadJobsWithoutBrowser } = require('../src/jobLoader');

loadEnvFile();

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.job) {
    console.error('Usage: node cli/screen-job.js --job <jobId-or-title-fragment> [--pipeline <key>]');
    process.exitCode = 1;
    return;
  }

  const dryRun = process.env.DRY_RUN === 'true';
  const p = paths();
  let config;
  let pipeline;
  try {
    config = loadConfig(p.configFile);
    pipeline = args.pipeline ? resolvePipeline(config, args.pipeline) : null;
  } catch (err) {
    console.error(err.message);
    printResult({ kind: 'screen', dryRun, error: err.message });
    process.exitCode = 1;
    return;
  }
  if (!dryRun && !pipeline) {
    console.warn('WARNING: no --pipeline given — accepted candidates will be advanced in Paycor but not enrolled for First Contact.');
  }
  const engine = (config.screening && config.screening.engine) || 'rules';
  if (engine === 'claude' && !process.env.ANTHROPIC_API_KEY) {
    const message = 'Screening is set to use Claude AI, but no API key is saved. Add one in Settings, or switch screening back to rules.';
    console.error(message);
    printResult({ kind: 'screen', dryRun, error: message });
    process.exitCode = 1;
    return;
  }
  console.log(engine === 'claude' ? 'Judging resumes with Claude AI.' : 'Judging resumes with this job\'s screening rules (no AI, nothing leaves this computer).');

  // Same lock as the daily cycle: both drive the same Edge profile and write the same state files.
  try {
    acquireRunLock(p.lockFile);
  } catch (err) {
    console.error(`ABORT: ${err.message}`);
    printResult({ kind: 'screen', dryRun, busy: true, error: err.message });
    process.exitCode = 1;
    return;
  }

  let browser = null;
  try {
    // Find the job through Paycor's own job data when possible, instead of reading the home page.
    const known = await loadJobsWithoutBrowser(p);
    browser = await launchEdge(p.edgeProfileDir, { sessionFile: p.sessionFile, userAgent: savedUserAgent(p.recipeFile) });
    const page = browser.pages()[0] || (await browser.newPage());
    const result = await runScreeningSweep({
      page,
      jobQuery: args.job,
      screeningCriteriaDir: path.join(__dirname, '..', 'screening-criteria'),
      screeningResultsDir: p.screeningResultsDir,
      manualReviewFilePath: p.manualReviewFile,
      stateFilePath: p.stateFile,
      pipeline,
      dryRun,
      maxPassesPerRun: config.screening && config.screening.maxPassesPerRun,
      engine,
      ocrCachePath: path.join(p.root, 'ocr-cache'),
      jobDescriptionsFile: p.jobDescriptionsFile,
      onProgress: printProgress,
      // New applicants from Paycor's data (no grid scrolling), newest first, a batch per run.
      listJobSeekers: (job) => listJobSeekers(p, job.jobId),
      // SCREEN_LIMIT: a smaller batch for a quick Autopilot test cycle (internal; settings are untouched).
      maxCandidatesPerRun: Number(process.env.SCREEN_LIMIT) > 0 ? Number(process.env.SCREEN_LIMIT) : (config.screening && config.screening.maxCandidatesPerRun) ?? 50,
      jobs: known ? known.jobs : null,
    });
    console.log(JSON.stringify(result, null, 2));
    printResult({ kind: 'screen', ...result });
  } catch (err) {
    const loginRequired = isLoginRequired(err);
    console.error(loginRequired ? `STOPPED: ${err.message}` : err.stack || err.message);
    printResult({ kind: 'screen', dryRun, error: err.message, loginRequired });
    process.exitCode = 1;
  } finally {
    await closeEdge(browser, { sessionFile: p.sessionFile });
    releaseRunLock(p.lockFile);
  }
}

if (require.main === module) main();

module.exports = { main };
