#!/usr/bin/env node
// "Log in to Paycor": opens the automation Edge window on Paycor's own login page and waits (up
// to 5 minutes) for the person to sign in there — username, password and any verification code
// go into Paycor's page, never into this app. Then, while the window is open, it learns Paycor's
// own job-list request and fetches every job through it (src/jobLoader.js), saves the login so
// later runs don't need one, and closes the window.

const { paths, loadEnvFile } = require('../src/config');
const { launchEdge, closeEdge, saveSession, waitForLogin } = require('../src/edge');
const { acquireRunLock, releaseRunLock } = require('../src/state/store');
const { loadJobsInBrowser } = require('../src/jobLoader');
const { markConnected, saveJobs, jobListExtras, writeHomeSnapshot } = require('../src/paycorSession');
const { printResult } = require('../src/cliResult');
const { refreshEmailTemplates } = require('../src/paycorTemplates');

loadEnvFile();

const HOME_URL = 'https://recruitingbypaycor.com/home';

async function isLoggedIn(page) {
  const url = page.url();
  if (!url.includes('recruitingbypaycor.com') || /\/login(?:[/?#]|$)/i.test(url)) return false;
  return (await page.locator('cdk-virtual-scroll-viewport.job-cards-viewport, a[data-cy="job-title-text"]').count()) > 0;
}

async function main() {
  const p = paths();
  try {
    acquireRunLock(p.lockFile);
  } catch (err) {
    console.error(`ABORT: ${err.message}`);
    printResult({ kind: 'login', ok: false, busy: true, error: err.message });
    process.exitCode = 1;
    return;
  }

  let browser = null;
  try {
    browser = await launchEdge(p.edgeProfileDir, { sessionFile: p.sessionFile, visible: true }); // the one visible window: the person signs in on Paycor's own page
    const page = browser.pages()[0] || (await browser.newPage());
    await page.goto(HOME_URL);
    await page.bringToFront();
    console.log('The Paycor login window is open. Sign in there — this waits up to 5 minutes.');

    const ok = await waitForLogin(page, isLoggedIn, {
      onHeartbeat: (ms) => {
        if (ms % 30000 < 3000) console.log(`Still waiting for the Paycor login… (${Math.round(ms / 1000)}s)`);
      },
    });
    if (!ok) {
      console.error('Timed out waiting for the Paycor login.');
      printResult({ kind: 'login', ok: false, error: 'The login window closed or 5 minutes passed before Paycor finished signing in.' });
      process.exitCode = 1;
      return;
    }

    await page.waitForTimeout(2000); // let the session cookies settle
    await saveSession(browser, p.sessionFile);
    markConnected();
    // Cheap (three small read-only requests, no window): keeps Settings' template dropdowns current.
    try {
      const { templates } = await refreshEmailTemplates(p);
      console.log(`Read ${templates.length} email template name(s) from Paycor.`);
    } catch (err) {
      console.log(`Couldn't read the email template list this time (${err.message}) — use "Refresh templates from Paycor" in Settings.`);
    }
    console.log('Logged in to Paycor. Loading your jobs…');

    let loaded;
    try {
      loaded = await loadJobsInBrowser(page, browser, p);
    } catch (err) {
      console.error(err.stack || err.message);
      printResult({ kind: 'login', ok: true, jobsError: err.message });
      return;
    }
    if (loaded.snapshot) writeHomeSnapshot(loaded.snapshot);
    saveJobs(loaded.jobs, jobListExtras(loaded));
    console.log(`Found ${loaded.jobs.length} job(s) (${loaded.scope}, read ${loaded.source === 'data' ? "directly from Paycor's job data" : 'from the page'}).`);
    printResult({ kind: 'login', ok: true, jobsFound: loaded.jobs.length, scope: loaded.scope, scopeNote: loaded.scopeNote, source: loaded.source });
  } catch (err) {
    console.error(err.stack || err.message);
    printResult({ kind: 'login', ok: false, error: err.message });
    process.exitCode = 1;
  } finally {
    await closeEdge(browser, { sessionFile: p.sessionFile });
    releaseRunLock(p.lockFile);
  }
}

if (require.main === module) main();

module.exports = { main, isLoggedIn };
