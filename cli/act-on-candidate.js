#!/usr/bin/env node
// Acts on one screening item from the exception queue — what the dashboard's Accept / Pass buttons
// shell out to. Re-checks the candidate is still a Job Seeker before clicking anything, enrolls an
// accepted candidate in the given pipeline, then marks the queue item resolved.
//
// Usage:
//   node cli/act-on-candidate.js --candidate <id> --added-at <iso> --action accept [--pipeline <key>]
//   node cli/act-on-candidate.js --candidate <id> --added-at <iso> --action pass --reason "Job hopper"

const { paths, loadConfig, loadEnvFile } = require('../src/config');
const { launchEdge, savedUserAgent, closeEdge } = require('../src/edge');
const { acquireRunLock, releaseRunLock } = require('../src/state/store');
const { findManualReview, resolveManualReview } = require('../src/state/manualReview');
const { addCandidates } = require('../src/intake/addCandidates');
const { resolvePipeline } = require('../src/pipelines');
const { actOnScreeningCandidate } = require('../src/screening/runScreeningSweep');
const { isLoginRequired } = require('../src/paycor-actions');
const { printResult } = require('../src/cliResult');

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

function fail(result, message) {
  console.error(message);
  printResult({ kind: 'act', ok: false, ...result, error: message });
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { candidate, action, reason } = args;
  const addedAt = args['added-at'];
  if (!candidate || !addedAt || !['accept', 'pass'].includes(action)) {
    return fail({}, 'Usage: node cli/act-on-candidate.js --candidate <id> --added-at <iso> --action accept|pass [--reason "..."] [--pipeline <key>]');
  }

  const p = paths();
  const entry = findManualReview(p.manualReviewFile, candidate, addedAt);
  if (!entry || entry.kind !== 'screening' || entry.resolvedAt) {
    return fail({ action }, 'This item is no longer open — nothing was done.');
  }
  const base = { action, name: entry.name, candidateId: candidate };

  let pipeline = null;
  try {
    const config = loadConfig(p.configFile);
    const pipelineKey = args.pipeline || entry.pipelineKey;
    pipeline = pipelineKey ? resolvePipeline(config, pipelineKey) : null;
  } catch (err) {
    return fail(base, err.message);
  }

  try {
    acquireRunLock(p.lockFile);
  } catch (err) {
    return fail({ ...base, busy: true }, err.message);
  }

  let browser = null;
  try {
    browser = await launchEdge(p.edgeProfileDir, { sessionFile: p.sessionFile, userAgent: savedUserAgent(p.recipeFile) });
    const page = browser.pages()[0] || (await browser.newPage());
    const screenedStatus = (pipeline && pipeline.targetStatuses && pipeline.targetStatuses.resumeScreened) || null;
    const result = await actOnScreeningCandidate({ page, candidateId: candidate, decision: action, reason, screenedStatus });

    if (!result.ok) {
      if (result.outcome === 'already_moved') {
        resolveManualReview(p.manualReviewFile, candidate, addedAt, `No action — candidate had already left the Job Seeker stage (${result.currentStage}).`);
      }
      fail({ ...base, alreadyMoved: result.outcome === 'already_moved' }, result.error);
      return;
    }

    let note = action === 'accept' ? 'Accepted via dashboard' : `Passed via dashboard (${reason})`;
    if (action === 'accept' && pipeline) {
      const { added } = addCandidates(p.stateFile, [{ id: candidate, name: entry.name }], pipeline.key);
      note += added.length ? `; enrolled in ${pipeline.key}` : '; already tracked in the pipeline';
    }
    resolveManualReview(p.manualReviewFile, candidate, addedAt, note);
    console.log(note);
    printResult({ kind: 'act', ok: true, ...base, note });
  } catch (err) {
    const loginRequired = isLoginRequired(err);
    fail({ ...base, loginRequired }, loginRequired ? err.message : err.stack || err.message);
  } finally {
    await closeEdge(browser, { sessionFile: p.sessionFile });
    releaseRunLock(p.lockFile);
  }
}

if (require.main === module) main();

module.exports = { main };
