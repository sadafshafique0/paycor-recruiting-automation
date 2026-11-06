// Loads the job list from Paycor.
//
//   loadJobsInBrowser    — used right after login (the window is already open): records the home
//                          page's own data requests, identifies the job list request, and fetches
//                          every job through it. Falls back to reading the page only if the request
//                          can't be identified.
//   loadJobsWithoutBrowser — used by "Refresh from Paycor" and screening: replays the saved request
//                          with the saved login. No window, no scrolling. Returns null (caller opens
//                          the browser) if there's no saved request yet or Paycor's response changed.

const paycorActions = require('./paycor-actions');
const data = require('./paycorData');
const { readSession } = require('./edge');
const { syncJobDescriptions } = require('./jobDescriptions');
const { refreshStages } = require('./paycorStages');

const HOME_URL = 'https://recruitingbypaycor.com/home';
const PAYCOR_COOKIE_RE = /paycor|newtonsoftware/i;

async function loadJobsInBrowser(page, context, p) {
  const capture = data.captureJsonResponses(page);
  let visible = [];
  let switchInfo = {};
  let switchAt = null;
  try {
    await paycorActions.gotoPaycor(page, HOME_URL);
    if (!(await paycorActions.waitForJobList(page))) throw new Error('The Paycor home page did not finish loading its job list.');
    visible = await paycorActions.readRenderedJobCards(page);
    switchAt = Date.now();
    switchInfo = await paycorActions.switchJobFilterToAll(page);
    if (switchInfo.switched) visible = visible.concat(await paycorActions.readRenderedJobCards(page));
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  } finally {
    capture.stop();
  }
  data.writeNetworkLog(p.networkLogFile, capture.captures);

  const header = await paycorActions.readJobsHeader(page);
  const snapshot = {
    header: header.text,
    scope: switchInfo.switched ? switchInfo.label : 'My Jobs',
    scopeNote: switchInfo.note || null,
    cardsHtml: visible.slice(0, 2).map((c) => c.cardHtml),
    filterHtml: switchInfo.filterHtml || null,
    optionsHtml: switchInfo.optionsHtml || null,
  };

  let fallbackReason = 'the job data request could not be identified';
  const found = data.discoverJobsRequest(capture.captures, visible);
  if (found) {
    const recipe = data.toRecipe(found);
    if (switchInfo.switched && found.capture.at >= switchAt) recipe.scope = switchInfo.label;
    const scopeValues = data.learnScopeValues(capture.captures, found.capture.url, switchInfo.switched ? switchAt : null);
    if (Object.keys(scopeValues).length) recipe.scopeValues = scopeValues;
    const cookies = (await context.cookies()).filter((c) => PAYCOR_COOKIE_RE.test(c.domain));
    try {
      const result = await data.fetchMineAndAll(recipe, cookies);
      if (result.jobs.length) {
        data.saveRecipe(p.recipeFile, recipe);
        // Where the data request has no counts, use the ones on the cards already drawn on screen.
        const onScreen = new Map(visible.map((c) => [c.jobId, c]));
        const jobs = result.jobs.map((j) => (j.jobSeekerCount == null && onScreen.has(j.jobId) ? { ...j, jobSeekerCount: onScreen.get(j.jobId).jobSeekerCount, stageCounts: onScreen.get(j.jobId).stageCounts } : j));
        const descriptions = await refreshDescriptions(jobs, cookies, p);
        return { ...result, jobs, descriptions, priorityLabels: learnPriorityLabels(visible), source: 'data', totalReported: header.total, snapshot };
      }
      fallbackReason = 'the job data request returned no jobs';
    } catch (err) {
      if (paycorActions.isLoginRequired(err)) throw err;
      fallbackReason = err.message;
    }
  }

  // Fallback: read the page (patiently). Clearly labelled so nobody mistakes it for the full list.
  const cards = await paycorActions.scrollAndReadJobCards(page);
  const jobs = cards.map(({ cardHtml, priorityLabel, ...job }, i) => ({ ...job, rank: i, mine: null, myRank: null }));
  const scope = switchInfo.switched ? switchInfo.label : 'My Jobs';
  const notes = [switchInfo.switched ? null : `${switchInfo.note || ''} Only "My Jobs" were read.`, `Jobs were read from the page because ${fallbackReason}.`].filter(Boolean);
  return { jobs, scope, scopeNote: notes.join(' ').trim(), hasMyJobs: false, priorityLabels: learnPriorityLabels(cards), source: 'page', totalReported: header.total, snapshot };
}

/** Job descriptions ride along with the job list; a problem there never stops the list loading. */
async function refreshDescriptions(jobs, cookies, p) {
  // The stage/status list (one small request) is kept current the same way, for Settings.
  await refreshStages(p, { cookies }).catch(() => {});
  try {
    return await syncJobDescriptions(jobs, cookies, p.jobDescriptionsFile);
  } catch (err) {
    return { fetched: 0, failed: jobs.length, error: err.message };
  }
}

/** Paycor's names for its priority numbers, read off the badges on the cards: { "4": "Urgent", … }. */
function learnPriorityLabels(cards) {
  const labels = {};
  for (const c of cards) if (c.priority != null && c.priorityLabel && c.priorityLabel.length <= 30) labels[String(c.priority)] = c.priorityLabel;
  return labels;
}

async function loadJobsWithoutBrowser(p) {
  const recipe = data.loadRecipe(p.recipeFile);
  const session = readSession(p.sessionFile);
  if (!recipe || !session || !Array.isArray(session.cookies) || !session.cookies.length) return null;
  try {
    const result = await data.fetchMineAndAll(recipe, session.cookies);
    if (!result.jobs.length) return null;
    const descriptions = await refreshDescriptions(result.jobs, session.cookies, p);
    return { ...result, descriptions, source: 'data' };
  } catch (err) {
    if (paycorActions.isLoginRequired(err)) throw err; // the saved login is gone — the dashboard asks for a new one
    return null; // Paycor's response changed — the caller re-discovers in the browser
  }
}

module.exports = { loadJobsInBrowser, loadJobsWithoutBrowser, learnPriorityLabels };
