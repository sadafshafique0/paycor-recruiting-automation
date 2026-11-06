#!/usr/bin/env node
// Windows Task Scheduler entry point (and what the dashboard's "Run now" button shells out
// to). Runs one full daily cycle: acquire the run lock, launch the dedicated Edge profile,
// replies-then-timers-then-new-candidates via scheduler.js, write the run log +
// NEEDS-ATTENTION.txt, release the lock.
//
// DRY_RUN=true env var runs the full cycle against real state/timers/replies but every
// Paycor-touching action is a logged no-op — use this for at least one full 6-day cycle before
// trusting live sends (see docs/LIVE-VERIFICATION-CHECKLIST.md).
//
// Adapted from Paycor-Outreach-Toolkit/cli/run-daily.js.

const fs = require('fs');
const path = require('path');

const { paths, loadConfig, loadEnvFile } = require('../src/config');
const { acquireRunLock, releaseRunLock, loadState } = require('../src/state/store');
const { launchEdge, savedUserAgent, closeEdge, readSession } = require('../src/edge');
const { runDailyCycle } = require('../src/engine/scheduler');
const { syncOutreachFromPaycor } = require('../src/intake/paycorIntake');
const { readJobs } = require('../src/paycorSession');
const { fetchReplyNotifications, replyFinder } = require('../src/paycorNotifications');
const { companyIdFrom } = require('../src/paycorTemplates');
const { executeAction } = require('../src/engine/executeAction');
const paycorActions = require('../src/paycor-actions');
const { printResult, printProgress } = require('../src/cliResult');

loadEnvFile();

/**
 * Reply-reading lives entirely on Paycor's own candidate-profile page (no Outlook, no
 * Claude-in-Chrome involved) — see paycor-actions.js's readLatestReply header comment.
 */
function fetchReplyFromPaycor(page) {
  return async (candidate) => {
    await paycorActions.openCandidateProfile(page, candidate.id);
    return paycorActions.readLatestReply(page, candidate.awaitingReplySince);
  };
}

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';
  const p = paths();
  if (!fs.existsSync(p.logsDir)) fs.mkdirSync(p.logsDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(p.logsDir, `run-${today}.log`);
  const log = (line) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    console.log(stamped);
    fs.appendFileSync(logFile, stamped + '\n');
  };

  log(`=== Autonomous Paycor Workflow daily run ${dryRun ? '(DRY RUN)' : '(LIVE)'} ===`);

  try {
    acquireRunLock(p.lockFile);
  } catch (err) {
    log(`ABORT: ${err.message}`);
    printResult({ kind: 'daily', dryRun, busy: true, error: err.message });
    process.exitCode = 1;
    return;
  }

  const needsAttention = [];
  let browser = null;
  let result = { kind: 'daily', dryRun };

  try {
    const config = loadConfig(p.configFile);

    let page = null;
    if (!dryRun) {
      browser = await launchEdge(p.edgeProfileDir, { sessionFile: p.sessionFile, userAgent: savedUserAgent(p.recipeFile) });
      page = browser.pages()[0] || (await browser.newPage());
    }

    // Pick up this job's candidates from Paycor by status and last update (src/intake/paycorIntake.js).
    // A test run only reads; a real run saves them into the outreach state before working on anyone.
    // One pipeline only, when chosen on the dashboard (OUTREACH_PIPELINE); otherwise all of them.
    const pipelineKey = process.env.OUTREACH_PIPELINE || null;
    if (pipelineKey && !config.pipelines.some((x) => x.key === pipelineKey)) throw new Error(`Unknown pipeline "${pipelineKey}"`);
    const intake = await syncOutreachFromPaycor(p, config, { dryRun, onProgress: printProgress, pipelineKey });
    log(`Intake from Paycor: ${intake.add.length} picked up, ${intake.stop.length} stopped (moved in Paycor), ${intake.tooOld} not updated in ${intake.pickUpWithinDays} days, ${intake.overNewLimit} new ones left for the next run${intake.errors.length ? `; problems: ${intake.errors.join(" | ")}` : ""}`);

    // Replies come from the person's Paycor notifications (email and text replies) — no browser needed,
    // so test runs see them too. A real run also checks the profile before any reminder or pass.
    const state = loadState(p.stateFile);
    const waiting = [...Object.values(state), ...intake.add].filter((c) => c.status === 'active' && c.awaitingReplySince && (!pipelineKey || c.pipelineKey === pipelineKey));
    const sinceMs = waiting.length ? Math.min(...waiting.map((c) => Date.parse(c.awaitingReplySince) || Date.now())) : Date.now();
    const session = readSession(p.sessionFile);
    const replies = waiting.length ? await fetchReplyNotifications(session.cookies, companyIdFrom(session.cookies), { sinceMs }) : [];
    log(`Reply notifications since ${new Date(sinceMs).toISOString()}: ${replies.length}`);
    const internalIds = new Map((readJobs().jobs || []).map((j) => [String(j.jobId), j.internalId]));
    const jobOf = new Map(config.pipelines.map((x) => [x.key, internalIds.get(String(x.jobId)) || null]));
    const fetchReply = replyFinder(replies, (key) => jobOf.get(key) || null);
    const confirmNoReply = dryRun ? null : fetchReplyFromPaycor(page);

    const summary = await runDailyCycle({
      onProgress: printProgress,
      stateFilePath: p.stateFile,
      manualReviewFilePath: p.manualReviewFile,
      config,
      now: new Date(),
      fetchReply,
      executeAction,
      page,
      dryRun,
      // A test run saved nothing, so the picked-up candidates are used in memory only.
      confirmNoReply,
      pipelineKey,
      extraCandidates: dryRun ? intake.add : [],
      stoppedIds: dryRun ? intake.stop.map((s) => s.id) : [],
    });

    log(`Summary: ${JSON.stringify(summary, null, 2)}`);
    const pickedUp = {};
    for (const rec of intake.add) pickedUp[rec.track] = (pickedUp[rec.track] || 0) + 1;
    // Each pipeline's job, so the result can say which job every candidate is from.
    const titles = new Map((readJobs().jobs || []).map((j) => [String(j.jobId), j.title]));
    const pipelines = Object.fromEntries(config.pipelines.map((x) => [x.key, { jobId: x.jobId, title: titles.get(String(x.jobId)) || null }]));
    result = { ...result, summary, pipelineKey, pipelines, intake: { pickedUp, total: intake.add.length, stopped: intake.stop.length, overNewLimit: intake.overNewLimit, maxNew: intake.maxNew, deferred: intake.deferred, errors: intake.errors } };

    if (summary.errors.length) needsAttention.push(`${summary.errors.length} error(s) — see ${logFile}`);
    if (summary.manualReviewAdded) needsAttention.push(`${summary.manualReviewAdded} candidate(s) added to manual review — see ${p.manualReviewFile}`);
    if (summary.backlogCapTripped) needsAttention.push('Backlog safety cap tripped — a large batch of passes was queued for manual approval instead of auto-executed.');
  } catch (err) {
    log(`FATAL: ${err.stack || err.message}`);
    const loginRequired = paycorActions.isLoginRequired(err);
    needsAttention.push(
      loginRequired
        ? `Paycor login expired — the run stopped before acting on anyone else. ${err.message}`
        : `Run failed with a fatal error: ${err.message}`,
    );
    result = { ...result, error: err.message, loginRequired };
    process.exitCode = 1;
  } finally {
    await closeEdge(browser, { sessionFile: p.sessionFile });
    releaseRunLock(p.lockFile);
  }

  printResult(result);

  // A test run never touches the "needs attention" note — that belongs to real runs.
  if (dryRun) return;
  if (needsAttention.length) {
    fs.writeFileSync(p.needsAttentionFile, `Run on ${today} needs your attention:\n\n` + needsAttention.map((l) => `- ${l}`).join('\n') + '\n');
    log(`Wrote ${p.needsAttentionFile} — ${needsAttention.length} item(s) need attention.`);
  } else if (fs.existsSync(p.needsAttentionFile)) {
    fs.unlinkSync(p.needsAttentionFile);
  }
}

if (require.main === module) main();

module.exports = { main };
