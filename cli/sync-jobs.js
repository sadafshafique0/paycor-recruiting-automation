#!/usr/bin/env node
// "Refresh from Paycor": asks Paycor for the job list directly with the saved login — no window,
// no scrolling. Only if that isn't possible yet (no saved request, or Paycor's response changed)
// does it open the automation window and learn the request again. If Paycor has expired the
// login, it marks this computer as logged out so the dashboard asks for a login.

const { paths, loadEnvFile } = require('../src/config');
const { launchEdge, savedUserAgent, closeEdge } = require('../src/edge');
const { acquireRunLock, releaseRunLock } = require('../src/state/store');
const { isLoginRequired } = require('../src/paycor-actions');
const { loadJobsWithoutBrowser, loadJobsInBrowser } = require('../src/jobLoader');
const { saveJobs, jobListExtras, markDisconnected, writeHomeSnapshot } = require('../src/paycorSession');
const { printResult } = require('../src/cliResult');

loadEnvFile();

async function main() {
  const p = paths();
  try {
    acquireRunLock(p.lockFile);
  } catch (err) {
    console.error(`ABORT: ${err.message}`);
    printResult({ kind: 'sync', ok: false, busy: true, error: err.message });
    process.exitCode = 1;
    return;
  }

  let browser = null;
  try {
    let loaded = await loadJobsWithoutBrowser(p);
    if (loaded) {
      console.log('Read the job list directly from Paycor (no browser window needed).');
    } else {
      console.log('Opening the Paycor window to learn how it loads the job list…');
      browser = await launchEdge(p.edgeProfileDir, { sessionFile: p.sessionFile, userAgent: savedUserAgent(p.recipeFile) });
      const page = browser.pages()[0] || (await browser.newPage());
      loaded = await loadJobsInBrowser(page, browser, p);
      if (loaded.snapshot) writeHomeSnapshot(loaded.snapshot);
    }
    saveJobs(loaded.jobs, jobListExtras(loaded));
    console.log(`Found ${loaded.jobs.length} job(s) (${loaded.scope}).`);
    printResult({ kind: 'sync', ok: true, jobsFound: loaded.jobs.length, totalReported: loaded.totalReported ?? loaded.total ?? null, scope: loaded.scope, scopeNote: loaded.scopeNote, source: loaded.source });
  } catch (err) {
    const loginRequired = isLoginRequired(err);
    if (loginRequired) markDisconnected();
    console.error(loginRequired ? `STOPPED: ${err.message}` : err.stack || err.message);
    printResult({ kind: 'sync', ok: false, error: err.message, loginRequired });
    process.exitCode = 1;
  } finally {
    await closeEdge(browser, { sessionFile: p.sessionFile });
    releaseRunLock(p.lockFile);
  }
}

if (require.main === module) main();

module.exports = { main };
