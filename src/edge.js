// Persistent-profile Edge launch.
//
// IMPORTANT: `edgeProfileDir` must point directly at a profile subfolder (e.g. a dedicated
// automation profile directory), NOT at Edge's "User Data" root — Chromium refuses remote
// debugging on its actual default data directory.
//
// Session survival: Paycor's login cookie (NSESSIONID) is a session cookie, and Chromium deletes
// session cookies every time the browser starts, even in a persistent profile. So the login would
// only ever last for one run. closeEdge() saves Paycor's cookies (and the page's sessionStorage)
// to `sessionFile` at the end of every run that is still logged in, and launchEdge() puts them
// back before the first navigation. Saved only in the person's own %LOCALAPPDATA%, alongside the
// browser profile that already holds Paycor's persistent cookies.
//
// Lazily requires playwright so dry runs and the dashboard work without it installed.

const fs = require('fs');
const path = require('path');

const PAYCOR_ORIGIN = 'https://recruitingbypaycor.com';
const PAYCOR_COOKIE_RE = /paycor|newtonsoftware/i;

function readSession(sessionFile) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } catch {
    return null;
  }
}

/** The user agent the person's own (visible) Edge sent to Paycor at login, or null. */
function savedUserAgent(recipeFile) {
  try {
    const ua = JSON.parse(fs.readFileSync(recipeFile, 'utf8')).headers['user-agent'];
    return typeof ua === 'string' && /^Mozilla\/5\.0 /.test(ua) && !/headless/i.test(ua) && ua.length < 400 ? ua : null;
  } catch {
    return null;
  }
}

/**
 * Starts the automation Edge profile. Hidden (headless) by default — every step of the process runs
 * in the background and the dashboard shows the progress. Only the Paycor login passes
 * `visible: true`, because the person types their password on Paycor's own page.
 * `userAgent`: the one the person's normal Edge sent at login (saved with the job request), so the
 * hidden browser identifies itself to Paycor the same way.
 */
async function launchEdge(edgeProfileDir, { sessionFile = null, visible = false, userAgent = null } = {}) {
  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext(edgeProfileDir, {
    channel: 'msedge',
    headless: !visible,
    ...(visible ? { args: ['--start-maximized'] } : { viewport: { width: 1600, height: 1000 }, ...(userAgent ? { userAgent } : {}) }),
  });

  const saved = sessionFile ? readSession(sessionFile) : null;
  if (saved) {
    if (Array.isArray(saved.cookies) && saved.cookies.length) {
      try {
        await context.addCookies(saved.cookies);
      } catch {
        // A malformed saved cookie must never stop the run — worst case Paycor asks for a login.
      }
    }
    if (saved.sessionStorage && Object.keys(saved.sessionStorage).length) {
      await context.addInitScript(
        ({ origin, items }) => {
          if (location.origin !== origin) return;
          for (const [k, v] of Object.entries(items)) {
            if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
          }
        },
        { origin: PAYCOR_ORIGIN, items: saved.sessionStorage },
      );
    }
  }
  return context;
}

function loggedInPaycorPage(context) {
  return context.pages().find((p) => {
    const url = p.url();
    return url.startsWith(PAYCOR_ORIGIN) && !/\/login(?:[/?#]|$)/i.test(url);
  });
}

/** Saves Paycor's cookies + sessionStorage, but only from a page that is actually logged in. */
async function saveSession(context, sessionFile) {
  const page = loggedInPaycorPage(context);
  if (!page) return false;
  const cookies = (await context.cookies()).filter((c) => PAYCOR_COOKIE_RE.test(c.domain));
  if (!cookies.length) return false;
  let storage = {};
  try {
    storage = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
  } catch {
    // page mid-navigation — cookies are the important part
  }
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const tmp = `${sessionFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), cookies, sessionStorage: storage }), 'utf8');
  fs.renameSync(tmp, sessionFile);
  return true;
}

async function closeEdge(context, { sessionFile = null } = {}) {
  if (!context) return;
  if (sessionFile) {
    try {
      await saveSession(context, sessionFile);
    } catch {
      // never let saving the session stop the browser from closing
    }
  }
  await context.close().catch(() => {});
}

/**
 * Poll (never block on stdin) until `isLoggedIn(page)` returns true, or give up after
 * `timeoutMs`. An unattended run has no one to answer a prompt.
 */
async function waitForLogin(page, isLoggedIn, { timeoutMs = 5 * 60 * 1000, intervalMs = 3000, onHeartbeat } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isLoggedIn(page)) return true;
    if (onHeartbeat) onHeartbeat(Date.now() - start);
    await page.waitForTimeout(intervalMs);
  }
  return false;
}

module.exports = { launchEdge, savedUserAgent, closeEdge, saveSession, readSession, waitForLogin, PAYCOR_ORIGIN };
