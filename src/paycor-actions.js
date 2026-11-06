// Paycor page actions, driven via Playwright's page.evaluate / page.* against
// recruitingbypaycor.com. Every function that actually touches Paycor funnels through here —
// this is the one file an audit of "what does this system actually click" has to read.
//
// sendEmailAndAdvance / retryStatusChangeOnly / passCandidate / requestScorecard /
// isReplyNewerThan / isFromCandidate / pickLatestReply / readLatestReply are ported as-is from
// Paycor-Outreach-Toolkit/src/paycor-actions.js — confirmed live 2026-08-09 per that project's
// own README checklist. Everything below the "--- Resume screening ---" marker is new for this
// project and UNVERIFIED against a live Paycor session — it's built from the selectors already
// reverse-engineered in Paycor-full-package/docs/paycor-screen-plan.md and
// Paycor-full-package/.claude/commands/paycor-fluency.md, but nobody has run it against a real
// browser yet. See docs/LIVE-VERIFICATION-CHECKLIST.md before trusting any of it unattended.
//
// Every navigation goes through gotoPaycor(), and every action on a candidate is preceded by
// openCandidateProfile(). The ported in-page functions (sendEmailAndAdvance, passCandidate) act
// on whatever profile is currently open, so this is the only thing stopping a reminder or Pass
// from landing on the previously visited candidate.

const path = require('path');
const { CANDIDATE_ID_RE } = require('./engine/constants');
const { htmlToText, findVocarooLink } = require('./text');
const { stripQuote } = require('./quoteStrip');
const paycorData = require('./paycorData');
const { extractText, ocrScreenshots, wordCount } = require('./screening/resumeText');

const CLIENT_ID = '8a7883d08675eec501867a6a925901d3'; // constant across this Paycor company — see paycor-screen-plan.md
const BASE_URL = 'https://recruitingbypaycor.com';

class LoginRequiredError extends Error {
  constructor(url) {
    super(`Paycor session expired (redirected to ${url}). Log in once in the automation Edge window, then re-run.`);
    this.code = 'LOGIN_REQUIRED';
  }
}

function isLoginRequired(err) {
  return !!err && err.code === 'LOGIN_REQUIRED';
}

function assertNotLoginPage(page) {
  const current = page.url();
  if (/\/login(?:[/?#]|$)/i.test(current)) throw new LoginRequiredError(current);
}

async function gotoPaycor(page, url) {
  await page.goto(url);
  assertNotLoginPage(page);
}

async function openCandidateProfile(page, candidateId) {
  if (!CANDIDATE_ID_RE.test(String(candidateId))) throw new Error(`Refusing to open invalid candidate id "${candidateId}"`);
  await gotoPaycor(page, `${BASE_URL}/candidate/${candidateId}`);
  const landed = page.url();
  if (!landed.includes(`/candidate/${candidateId}`)) {
    throw new Error(`Expected candidate ${candidateId}'s profile but landed on ${landed} — refusing to act on an unverified page`);
  }
}

async function sendEmailAndAdvance(page, templateName, statusText) {
  return page.evaluate(
    async ({ templateName, statusText }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, timeout = 10000, interval = 200) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const r = fn();
          if (r) return r;
          await sleep(interval);
        }
        return null;
      };
      const emailBtn = await waitFor(() => document.querySelector('[aria-label="send email"]'));
      if (!emailBtn) return { error: 'no email btn' };
      emailBtn.click();
      await sleep(500);
      emailBtn.click();
      const input = await waitFor(() => document.querySelector('input[placeholder="Add a Recipient"]'));
      if (!input) return { error: 'no recipient input' };
      input.focus();
      input.click();
      const candBtn = await waitFor(() => document.querySelector('#ns_email_dropdown_group_0 .user-item'));
      if (!candBtn) return { error: 'no candidate suggestion' };
      const candText = candBtn.textContent.trim();
      candBtn.click();
      await sleep(500);
      const tmplToggle = await waitFor(() => document.querySelector('.ns-email-templates'));
      if (!tmplToggle) return { error: 'no template toggle', candText };
      tmplToggle.click();
      const tmplOpt = await waitFor(() => document.querySelector(`[ns-qa="${templateName} Templates"]`));
      if (!tmplOpt) return { error: 'no template option', candText };
      tmplOpt.click();
      const sendBtn = await waitFor(() =>
        Array.from(document.querySelectorAll('button')).find((b) => /send email now/i.test(b.textContent.trim()) && !b.disabled),
      );
      if (!sendBtn) return { error: 'no send button', candText };
      sendBtn.click();
      await sleep(1200);
      const stageBtn = await waitFor(() => document.querySelector('.candidate-stage.current button'), 10000);
      if (!stageBtn) return { error: 'no stage button', candText, sent: true };
      stageBtn.click();
      const optSpan = await waitFor(() =>
        Array.from(document.querySelectorAll('*')).find((el) => el.children.length === 0 && el.textContent.trim() === statusText),
      );
      if (!optSpan) return { error: 'no status option', candText, sent: true };
      optSpan.closest('button').click();
      const visibleSave = await waitFor(() => {
        const saveSpans = Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0 && el.textContent.trim() === 'Save');
        return saveSpans.find((s) => {
          const popup = s.closest('.post-comment-popup');
          return popup && !popup.classList.contains('ng-hide');
        });
      });
      if (!visibleSave) return { error: 'no visible save', candText, sent: true, statusClicked: true };
      visibleSave.closest('p').click();
      await sleep(800);
      return { ok: true, candText };
    },
    { templateName, statusText },
  );
}

/**
 * Retry-only-the-status-change path for when sendEmailAndAdvance() reports sent:true but
 * failed partway through the stage-advance step. Never resend, only retry the status change.
 */
async function retryStatusChangeOnly(page, statusText) {
  return page.evaluate(async (statusText) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, timeout = 10000, interval = 200) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const r = fn();
        if (r) return r;
        await sleep(interval);
      }
      return null;
    };
    const stageBtn = await waitFor(() => document.querySelector('.candidate-stage.current button'), 10000);
    if (!stageBtn) return { error: 'no stage button' };
    stageBtn.click();
    const optSpan = await waitFor(() =>
      Array.from(document.querySelectorAll('*')).find((el) => el.children.length === 0 && el.textContent.trim() === statusText),
    );
    if (!optSpan) return { error: 'no status option' };
    optSpan.closest('button').click();
    const visibleSave = await waitFor(() => {
      const saveSpans = Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0 && el.textContent.trim() === 'Save');
      return saveSpans.find((s) => {
        const popup = s.closest('.post-comment-popup');
        return popup && !popup.classList.contains('ng-hide');
      });
    });
    if (!visibleSave) return { error: 'no visible save', statusClicked: true };
    visibleSave.closest('p').click();
    await sleep(800);
    return { ok: true };
  }, statusText);
}

/** Confirmed live 2026-08-09 — button `[ns-qa="redNoText"]`, reason labels in pipelines.js. */
async function passCandidate(page, reasonLabel) {
  return page.evaluate(async (reasonLabel) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, timeout = 10000, interval = 200) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const r = fn();
        if (r) return r;
        await sleep(interval);
      }
      return null;
    };

    let passClicked = false;
    for (const sel of ['[ns-qa="redNoText"]', '.red-no-text', '[ng-click*="pass"]', '.newton-button.red']) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        passClicked = true;
        break;
      }
    }
    if (!passClicked) {
      for (const el of document.querySelectorAll('*')) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (/pass on candidate/i.test(txt) && el.children.length <= 1) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          passClicked = true;
          break;
        }
      }
    }
    if (!passClicked) return { error: 'no pass button found' };

    const dialog = await waitFor(() => document.querySelector('mat-dialog-container, inactivate-reason-dialog'), 6000);
    if (!dialog) return { error: 'pass dialog did not appear' };
    await sleep(500);

    const radios = [...dialog.querySelectorAll('input[type="radio"]')];
    let radioClicked = null;
    for (const radio of radios) {
      const lbl = document.querySelector(`label[for="${radio.id}"]`);
      const labelText = (lbl ? lbl.innerText : '').trim();
      if (labelText === reasonLabel) {
        radio.click();
        radioClicked = labelText;
        break;
      }
    }
    if (!radioClicked) return { error: `no radio found for reason "${reasonLabel}"`, availableReasons: radios.map((r) => (document.querySelector(`label[for="${r.id}"]`) || {}).innerText) };

    await sleep(500);

    let confirmed = false;
    for (const btn of dialog.querySelectorAll('button')) {
      if (/pass on candidate/i.test((btn.innerText || btn.textContent || '').trim())) {
        btn.click();
        confirmed = true;
        break;
      }
    }
    if (!confirmed) return { error: 'no confirm button found in pass dialog', selectedReason: radioClicked };

    await sleep(1200);
    return { ok: true, selectedReason: radioClicked };
  }, reasonLabel);
}

/** Confirmed live 2026-08-09 as a manual action (see Paycor-Outreach-Toolkit's README). */
async function requestScorecard(page, candidateId, managerEmail) {
  if (!CANDIDATE_ID_RE.test(String(candidateId))) throw new Error(`Refusing to open invalid candidate id "${candidateId}"`);
  await gotoPaycor(page, `${BASE_URL}/candidate/${candidateId}/scorecards`);
  return page.evaluate(
    async (managerEmail) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, timeout = 10000, interval = 200) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const r = fn();
          if (r) return r;
          await sleep(interval);
        }
        return null;
      };

      const openLink = await waitFor(() => document.querySelector('[ns-qa="sendScorecardRequestLink"]'));
      if (!openLink) return { error: 'no send-scorecard-request link found' };
      openLink.click();

      const dialog = await waitFor(() => {
        const candidates = document.querySelectorAll('mat-dialog-container, .md-dialog-container, [role="dialog"]');
        return Array.from(candidates).find((d) => d.textContent.includes('Send Scorecard Request')) || null;
      });
      if (!dialog) return { error: 'scorecard dialog did not open' };
      await sleep(500);

      const input = dialog.querySelector('input[placeholder="Add a Recipient"]');
      if (!input) return { error: 'no recipient input' };
      input.focus();
      input.click();
      input.value = managerEmail;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(800);

      const suggestion = await waitFor(() => dialog.querySelector('.user-item, [class*="recipient"] [class*="item"]'));
      if (suggestion) suggestion.click();
      await sleep(500);

      const sendBtn = await waitFor(() => {
        const btns = Array.from(dialog.querySelectorAll('button'));
        return btns.find((b) => /send email/i.test(b.textContent.trim()) && !b.disabled) || null;
      });
      if (!sendBtn) return { error: 'send button never became enabled — recipient may not have been accepted' };
      sendBtn.click();
      await sleep(1200);

      return { ok: true };
    },
    managerEmail,
  );
}

function isReplyNewerThan(entryTime, sinceIso) {
  if (!entryTime) return false;
  if (!sinceIso) return true;
  return new Date(entryTime).getTime() > new Date(sinceIso).getTime();
}

const ECHO_RELAY_DOMAIN = 'newtonsoftware.com';

function isFromCandidate(fromAddress) {
  return !!fromAddress && !String(fromAddress).toLowerCase().includes(ECHO_RELAY_DOMAIN);
}

function pickLatestReply(entries, sinceIso) {
  const replies = (entries || []).filter((e) => e.isEmail && isFromCandidate(e.fromAddress) && isReplyNewerThan(e.timestamp, sinceIso));
  if (!replies.length) return null;
  replies.sort((a, b) => b.timestamp - a.timestamp);
  return replies[0];
}

/**
 * Reads the candidate profile page's activity/email thread directly off the Angular
 * `candidateHistoryList` scope and returns the newest candidate reply newer than `sinceIso`, or
 * null. This is the whole reason Outlook/Claude-in-Chrome aren't needed anywhere in this
 * project — a candidate's reply to a Paycor-sent email is already logged back onto their own
 * profile by Paycor's send-relay, so detection never leaves the platform.
 *
 * Expects the candidate's profile to already be open (see openCandidateProfile). Throws — never
 * returns "no reply" — when the history list can't be read: a silent candidate gets auto-Passed
 * after the timeout window, so "couldn't look" must never be mistaken for "didn't reply".
 */
async function readLatestReply(page, sinceIso) {
  assertNotLoginPage(page);
  const entries = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const getList = () => {
      if (!window.angular) return null;
      const candidates = [
        document.querySelector('[ng-repeat="comment in candidateHistoryList"]'),
        ...document.querySelectorAll('[ng-controller]'),
      ].filter(Boolean);
      for (const el of candidates) {
        const scope = window.angular.element(el).scope();
        if (scope && Array.isArray(scope.candidateHistoryList)) return scope.candidateHistoryList;
      }
      return null;
    };
    let list = null;
    const start = Date.now();
    while (Date.now() - start < 8000) {
      list = getList();
      if (list) break;
      await sleep(300);
    }
    if (!list) return null;

    return list
      .filter((item) => item.isEmail)
      .map((item) => ({
        id: item.id,
        timestamp: item.timestamp,
        fromAddress: item.fromAddress || '',
        isEmail: true,
        html: item.content || '',
      }));
  });

  if (entries === null) {
    throw new Error(`Could not read the candidate history list on ${page.url()} — not treating this as "no reply"`);
  }

  const picked = pickLatestReply(entries, sinceIso);
  if (!picked) return null;
  return { text: htmlToText(picked.html), html: picked.html, messageId: picked.id };
}

// =================================================================================================
// --- Resume screening (new in this project — UNVERIFIED, see docs/LIVE-VERIFICATION-CHECKLIST.md) ---
// Selectors below are transcribed from Paycor-full-package/docs/paycor-screen-plan.md, which
// documents them as verified live 2026-09-09 for the *reading* side (finding jobs, scraping the
// Job Seeker grid, reading the resume viewer). The *acting* side here (clicking through) reuses
// passCandidate() above unchanged and adds advanceResumeQuickScreen() for the accept path, which
// was flagged in that same plan as "confirm the exact confirm/toast behaviour on the first
// candidate of the first run."
// =================================================================================================

// --- Home page job list: small, patient pieces (the data itself comes from src/paycorData.js) ---

const LOADING_SELECTOR = 'mat-spinner, mat-progress-spinner, .mat-mdc-progress-spinner, mat-progress-bar, .spinner, .loading, [class*="loading-indicator"]';

/** Waits until the Active Jobs list has finished loading: cards (or an empty-state) shown, no spinner. */
async function waitForJobList(page, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    assertNotLoginPage(page);
    const state = await page.evaluate((loadingSel) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const viewport = document.querySelector('cdk-virtual-scroll-viewport.job-cards-viewport');
      const cards = document.querySelectorAll('div.job-card-large').length;
      const loading = Array.from(document.querySelectorAll(loadingSel)).some(visible);
      const empty = /\b0\s+results?\b|no jobs/i.test(document.body.innerText);
      return { viewport: !!viewport, cards, loading, empty };
    }, LOADING_SELECTOR);
    if (state.viewport && !state.loading && (state.cards > 0 || state.empty)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Parses the job cards currently drawn on screen — no scrolling. Confirmed against Paycor's real
 * markup (2026-10-18): each "Candidates Pipeline" row is a label (`.count-link`, a link when the
 * stage has candidates) next to a separate number element (`.count-number`, e.g.
 * `data-se="jobSeekerStageCount"`). The number is NOT inside the label.
 */
async function readRenderedJobCards(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('div.job-card-large'))
      .map((card) => {
        const idEl = card.querySelector('[data-se="jobId"]');
        const titleEl = card.querySelector('a[data-cy="job-title-text"]');
        const jobId = idEl ? (idEl.textContent.match(/Job ID:\s*(\d+)/i) || [])[1] : null;
        if (!jobId || !titleEl) return null;

        const rows = Array.from(card.querySelectorAll('.job-pipeline-counts .count-number')).map((numEl) => {
          const row = numEl.parentElement;
          const labelEl = row ? row.querySelector('.count-link') : null;
          const link = labelEl ? labelEl.querySelector('a[href*="/candidate/search"]') : null;
          return {
            key: numEl.getAttribute('data-se') || '',
            label: (labelEl ? labelEl.textContent : '').replace(/:/g, '').replace(/\s+/g, ' ').trim(),
            count: Number((numEl.textContent.match(/\d+/) || ['0'])[0]),
            href: link ? link.getAttribute('href') : null,
          };
        });
        const seeker = rows.find((r) => r.key === 'jobSeekerStageCount') || rows.find((r) => /job seeker/i.test(r.label));
        const internal = (titleEl.getAttribute('href') || '').match(/job\/([A-Za-z0-9]+)/);
        // Priority badge: text like "Urgent", class like "priority-4" (the number Paycor's data uses).
        const prEl = card.querySelector('[data-se="jobPriority"]');
        const prClass = prEl ? (Array.from(prEl.classList).join(' ').match(/priority-(\d+)/) || [])[1] : null;
        const priorityLabel = prEl ? prEl.textContent.replace(/\s+/g, ' ').trim() || null : null;

        // For the diagnostic snapshot: the card without its pipeline columns, which list candidates by name.
        const clone = card.cloneNode(true);
        clone.querySelectorAll('.stages, .candidates, .candidate, .candidate-name').forEach((el) => el.remove());

        return {
          jobId,
          internalId: internal ? internal[1] : null,
          title: titleEl.textContent.trim(),
          jobSeekerCount: seeker ? seeker.count : null,
          jobSeekerHref: seeker ? seeker.href : null,
          stageCounts: rows.map(({ label, count }) => ({ label, count })),
          priority: prClass ? Number(prClass) : null,
          priorityLabel,
          cardHtml: clone.outerHTML.slice(0, 12000),
        };
      })
      .filter(Boolean),
  );
}

async function readJobsHeader(page) {
  return page.evaluate(() => {
    const m = document.body.innerText.match(/(\d+)\s+results?/i);
    return { text: m ? m[0] : null, total: m ? Number(m[1]) : null };
  });
}

/**
 * Switches the home page job filter from "My Jobs" to all jobs, by visible text (UNVERIFIED —
 * the filter's markup is captured in the snapshot so this can be pinned down). Waits for the list
 * to reload. Never scrolls.
 */
async function switchJobFilterToAll(page) {
  const opened = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const trigger = Array.from(document.querySelectorAll('body *')).find((el) => el.children.length === 0 && /^\s*my jobs\s*$/i.test(el.textContent || '') && visible(el));
    if (!trigger) return { found: false };
    const box = trigger.closest('mat-form-field, mat-select, [role="combobox"], button, .mat-mdc-select') || trigger.parentElement;
    const filterHtml = (box.parentElement || box).outerHTML.slice(0, 6000);
    (trigger.closest('mat-select, [role="combobox"], button, a, [role="tab"], [role="radio"], label') || trigger).click();
    return { found: true, filterHtml };
  });
  if (!opened.found) return { switched: false, note: 'Could not find the "My Jobs" filter on the Paycor home page.' };

  const before = await readJobsHeader(page);
  let picked = null;
  for (let waited = 0; waited < 4000 && !picked; waited += 250) {
    await page.waitForTimeout(250);
    picked = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const optionRe = /^\s*all(\s+active)?\s+jobs\s*$/i;
      const option = Array.from(document.querySelectorAll('mat-option, [role="option"], [role="menuitem"], [role="tab"], [role="radio"], button, li, a, span, div'))
        .filter((el) => optionRe.test(el.textContent || '') && visible(el))
        .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
      const overlay = document.querySelector('.cdk-overlay-container');
      if (!option) return null;
      const label = option.textContent.trim();
      (option.closest('mat-option, [role="option"], [role="menuitem"], button, a, li, [role="tab"], [role="radio"]') || option).click();
      return { label, optionsHtml: overlay ? overlay.innerHTML.slice(0, 6000) : null };
    });
  }
  if (!picked) {
    const optionsHtml = await page.evaluate(() => {
      const overlay = document.querySelector('.cdk-overlay-container');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return overlay ? overlay.innerHTML.slice(0, 6000) : null;
    });
    return { switched: false, note: 'Could not find an "All Jobs" choice in the Paycor job filter.', filterHtml: opened.filterHtml, optionsHtml };
  }

  // Wait for the list to reload with the new filter.
  for (let waited = 0; waited < 15000; waited += 500) {
    await page.waitForTimeout(500);
    const now = await readJobsHeader(page);
    if (now.text !== before.text) break;
  }
  await waitForJobList(page, 20000);
  return { switched: true, label: picked.label, filterHtml: opened.filterHtml, optionsHtml: picked.optionsHtml };
}

/**
 * Fallback only — used when the job data request can't be identified. Scrolls the virtualized
 * list patiently: after each step it waits for Paycor to draw the next cards (or stop loading)
 * before reading them, and confirms the end twice.
 */
async function scrollAndReadJobCards(page) {
  const byId = new Map();
  const take = (cards) => cards.forEach((c) => byId.set(c.jobId, c));
  await page.evaluate(() => {
    const v = document.querySelector('cdk-virtual-scroll-viewport.job-cards-viewport');
    if (v) v.scrollTop = 0;
  });
  await page.waitForTimeout(800);
  take(await readRenderedJobCards(page));

  let stillAtEnd = 0;
  for (let i = 0; i < 300 && stillAtEnd < 2; i++) {
    const moved = await page.evaluate(() => {
      const v = document.querySelector('cdk-virtual-scroll-viewport.job-cards-viewport');
      if (!v) return false;
      const before = v.scrollTop;
      v.scrollTop += Math.max(100, Math.floor(v.clientHeight * 0.6));
      return v.scrollTop !== before;
    });
    const sizeBefore = byId.size;
    for (let waited = 0; waited < 6000; waited += 400) {
      await page.waitForTimeout(400);
      const loading = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).some((el) => el.getBoundingClientRect().height > 0), LOADING_SELECTOR);
      take(await readRenderedJobCards(page));
      if (!loading && (byId.size > sizeBefore || waited >= 1200)) break;
    }
    stillAtEnd = moved ? 0 : stillAtEnd + 1;
  }
  return [...byId.values()];
}

/** The Job Seeker list URL for a job, in the same form the home page's job cards link to. */
function jobSeekerSearchHref(jobId) {
  const q = { searchFields: [{ name: 'company', query: CLIENT_ID }, { name: 'jobId', query: String(jobId) }, { name: 'stage', query: 1 }] };
  return `/candidate/search?q=${encodeURIComponent(JSON.stringify(q))}&page=0`;
}

/**
 * Page-reading version of the job list (fallback). Goes to /home, waits for it to finish loading,
 * switches to all jobs when asked, then reads the cards patiently.
 */
async function listJobs(page, { allJobs = true } = {}) {
  await gotoPaycor(page, `${BASE_URL}/home`);
  if (!(await waitForJobList(page))) return { error: 'The Paycor Active Jobs list did not finish loading.', jobs: [] };
  let scope = 'My Jobs';
  let scopeNote = null;
  let switchInfo = {};
  if (allJobs) {
    switchInfo = await switchJobFilterToAll(page);
    if (switchInfo.switched) scope = switchInfo.label;
    else scopeNote = `${switchInfo.note} Only "My Jobs" were read.`;
  }
  const cards = await scrollAndReadJobCards(page);
  const header = await readJobsHeader(page);
  const jobs = cards.map(({ cardHtml, ...job }) => job);
  const snapshot = { header: header.text, scope, scopeNote, cardsHtml: cards.slice(0, 2).map((c) => c.cardHtml), filterHtml: switchInfo.filterHtml || null, optionsHtml: switchInfo.optionsHtml || null };
  return { jobs, totalReported: header.total, scope, scopeNote, snapshot };
}

async function findJobCard(page, jobQuery, { jobs: knownJobs = null } = {}) {
  let jobs = knownJobs;
  if (!jobs) {
    const listed = await listJobs(page);
    if (listed.error) return { error: listed.error, matches: [] };
    jobs = listed.jobs;
  }
  const q = String(jobQuery).trim().toLowerCase();
  const matches = (/^\d+$/.test(q) ? jobs.filter((j) => String(j.jobId) === q) : jobs.filter((j) => j.title.toLowerCase().includes(q))).map((j) => ({
    ...j,
    // Jobs from the data request have no card link; build the same Job Seeker list link the card uses.
    jobSeekerHref: j.jobSeekerHref || (j.jobSeekerCount === 0 ? null : jobSeekerSearchHref(j.jobId)),
  }));
  return { matches, totalJobsSeen: jobs.length };
}

/**
 * Parses the argument of a grid row's `ng-click="displayPreview(...)"`. Tries strict JSON first
 * (what the plan documents); falls back to pulling fields out by name, so a name like O'Brien
 * can't break the whole row. Pure — exported for tests.
 */
function parseDisplayPreviewArg(ngClick) {
  const argMatch = String(ngClick || '').match(/displayPreview\(([\s\S]*)\)\s*;?\s*$/);
  if (!argMatch) return null;
  try {
    const arg = JSON.parse(argMatch[1]);
    if (arg && arg.candidateId) return { candidateId: String(arg.candidateId), candidateName: arg.candidateName || null };
  } catch {
    // fall through to field extraction
  }
  const id = argMatch[1].match(/["']?candidateId["']?\s*:\s*["']([A-Za-z0-9]+)["']/);
  if (!id) return null;
  const name = argMatch[1].match(/["']?candidateName["']?\s*:\s*(["'])((?:\\.|(?!\1).)*)\1/);
  return { candidateId: id[1], candidateName: name ? name[2] : null };
}

function singleCandidateIdFromHref(href) {
  const pathname = new URL(href, BASE_URL).pathname;
  const match = pathname.match(/^\/candidate\/([A-Za-z0-9]+)\/?$/);
  return match && match[1] !== 'search' ? match[1] : null;
}

/**
 * Scrapes every candidate in a Job Seeker list link (either a direct single-candidate profile
 * href, or a search-results grid href). Always re-appends clientId/pageSize per the plan's note
 * that the grid renders blank without them. The grid is virtualized (only on-screen rows exist
 * in the DOM), so each page is scrolled top to bottom and rows are collected at every step.
 */
async function scrapeJobSeekers(page, jobSeekerHref) {
  const singleId = singleCandidateIdFromHref(jobSeekerHref);
  if (singleId) return [{ candidateId: singleId, candidateName: null }];

  const url = new URL(jobSeekerHref, BASE_URL);
  url.searchParams.set('clientId', CLIENT_ID);
  url.searchParams.set('pageSize', '100');

  const byId = new Map();
  let total = null;
  for (let pageNum = 0; pageNum <= 20; pageNum++) {
    url.searchParams.set('page', String(pageNum));
    await gotoPaycor(page, url.toString());
    const pageResults = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Paycor's grid takes several seconds to fill (5–8 s measured 2026-10-19). Wait until rows or the
      // "1 to 3 of 3 results" footer are actually there — never read a grid that hasn't loaded yet.
      const FOOTER_RE = /(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+results/i;
      const start = Date.now();
      while (Date.now() - start < 30000) {
        if (document.querySelector('[ng-click^="displayPreview"]') || FOOTER_RE.test(document.body.innerText)) break;
        await sleep(400);
      }
      await sleep(800); // let the first rows finish drawing
      const collected = [];
      const collect = () => {
        for (const row of document.querySelectorAll('[ng-click^="displayPreview"]')) collected.push(row.getAttribute('ng-click'));
      };
      const scroller = document.querySelector('.ag-body-viewport, .ag-body-vertical-scroll-viewport');
      collect();
      if (scroller) {
        scroller.scrollTop = 0;
        await sleep(300);
        for (let i = 0; i < 200; i++) {
          collect();
          const before = scroller.scrollTop;
          scroller.scrollTop += Math.max(50, Math.floor(scroller.clientHeight * 0.8));
          await sleep(300);
          if (scroller.scrollTop === before) break;
        }
        collect();
      }
      const footer = document.body.innerText.match(/(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+results/i);
      return { ngClicks: collected, total: footer ? Number(footer[3]) : null };
    });

    const before = byId.size;
    for (const ngClick of pageResults.ngClicks) {
      const parsed = parseDisplayPreviewArg(ngClick);
      if (parsed && !byId.has(parsed.candidateId)) byId.set(parsed.candidateId, parsed);
    }
    if (pageResults.total != null) total = pageResults.total;
    if (byId.size === before) break;
    if (total != null && byId.size >= total) break;
  }

  if (total != null && byId.size < total) {
    throw new Error(`Job Seeker grid reports ${total} candidates but only ${byId.size} could be read — refusing to screen a partial list`);
  }
  return Array.from(byId.values());
}

/**
 * Reads a candidate's resume as a stack of full-page screenshots (never downloaded — FlowPaper
 * renders canvas+images with no text layer, so a vision model reading screenshots is the only
 * option). Returns `{ noResumeOnFile: true }` if `activeResumeGroups` is empty, per the plan.
 * Capped at 15 screenshots — revisit for unusually long multi-page resumes.
 *
 * Returns `{ alreadyMoved: true, currentStage }` without touching anything if the candidate is no
 * longer in the Job Seeker stage (any source: Posting Response, Site Applicant, …) — a stale scraped list or a re-run must
 * never Pass someone who was already advanced.
 */
// Paycor's profile page usually draws the stage bar in 2–4 s but sometimes takes much longer
// (seen 2026-10-19: 2 of 6 profiles missed an 8 s wait). Wait generously, then reload once.
const STAGE_WAIT_MS = 25000;

async function readCurrentStage(page) {
  const read = () =>
    page.evaluate(async (waitMs) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const start = Date.now();
      while (Date.now() - start < waitMs) {
        const el = document.querySelector('.candidate-stage.current');
        if (el && el.textContent.trim()) return el.textContent.replace(/\s+/g, ' ').trim();
        await sleep(300);
      }
      return null;
    }, STAGE_WAIT_MS);
  const first = await read();
  if (first) return first;
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  assertNotLoginPage(page);
  return read();
}

// Every new applicant in the Job Seeker stage is screened, whatever their source. Paycor's Job Seeker
// statuses (stage library, 2026-10-19) — "Other" is left out because Passive Candidate uses it too.
const JOB_SEEKER_STATUSES = ['Posting Response', 'Site Applicant', 'Resume Bank', 'Internal Referral', 'Agency Resume', 'Agency Candidate', 'Gravity Referral'];

/**
 * True while the candidate is still in the Job Seeker stage. The current stage in Paycor's stage bar
 * shows the status ("Site Applicant") next to the stage's icon; the Job Seeker stage's icon is
 * "directions_run" (confirmed live 2026-10-19 — moved candidates show e.g. "assignment"
 * for Compatibility Evaluation).
 */
function isJobSeekerStage(stageText) {
  if (!stageText) return false;
  if (/directions_run/.test(stageText)) return true;
  const text = stageText.replace(/[a-z]+(_[a-z]+)+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return JOB_SEEKER_STATUSES.some((s) => text === s.toLowerCase() || text === `${s} ${s}`.toLowerCase());
}

/**
 * Opens the candidate's profile, confirms they're still a Job Seeker, and opens the Resume tab.
 * Returns `{ alreadyMoved }`, `{ noResumeOnFile }`, `{ error }`, or
 * `{ currentStage, isApplication, groupTitles, attachments: [{href, descriptor}] }`.
 */
async function openResumeTab(page, candidateId) {
  await openCandidateProfile(page, candidateId);

  const currentStage = await readCurrentStage(page);
  if (!currentStage) return { error: 'could not read the candidate\'s current stage' };
  if (!isJobSeekerStage(currentStage)) return { alreadyMoved: true, currentStage };

  const resumeState = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const getScope = () => {
      const el = document.querySelector('[ng-controller="CandidateResumeController"]');
      return el && window.angular ? window.angular.element(el).scope() : null;
    };
    let scope = null;
    const start = Date.now();
    while (Date.now() - start < 8000) {
      scope = getScope();
      if (scope) break;
      await sleep(300);
    }
    if (!scope) return { error: 'no CandidateResumeController scope found' };
    const groups = scope.activeResumeGroups || [];
    const tab = document.querySelector('[ng-click="changeResume(resumeTab)"]');
    if (tab) tab.click();
    const attachments = Array.from(document.querySelectorAll('a[href*="/attachments/"]')).map((a) => {
      const row = a.closest('li, tr, .attachment, .file-item') || (a.parentElement && a.parentElement.parentElement) || a.parentElement;
      return {
        href: a.getAttribute('href'),
        descriptor: [a.getAttribute('title'), a.getAttribute('aria-label'), a.getAttribute('download'), a.textContent, row ? row.textContent : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 300),
      };
    });
    return {
      groupCount: groups.length,
      groupTitles: groups.map((g) => (g && typeof g.title === 'string' ? g.title : '')).filter(Boolean),
      isApplication: !!scope.activeResumeIsApplication,
      attachments,
    };
  });

  if (resumeState.error) return { error: resumeState.error };
  if (!resumeState.groupCount) return { noResumeOnFile: true, currentStage };
  await page.waitForTimeout(1000);
  return { currentStage, isApplication: resumeState.isApplication, groupTitles: resumeState.groupTitles, attachments: resumeState.attachments };
}

/** Screenshots of the resume as Paycor's viewer draws it (used for the AI judge and for OCR). */
async function screenshotOpenResume(page, isApplication) {
  if (isApplication) {
    const buf = await page.locator('.resume-container').screenshot();
    return [buf.toString('base64')];
  }
  await page.locator('.flowpaper_viewer_wrap').waitFor({ state: 'visible', timeout: 15000 });
  const container = page.locator('#pagesContainer_documentViewer');
  const screenshots = [];
  for (let i = 0; i < 15; i++) {
    const buf = await page.locator('.flowpaper_viewer_wrap').screenshot();
    screenshots.push(buf.toString('base64'));
    const atBottom = await container.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
    if (atBottom) break;
    await container.evaluate((el) => {
      el.scrollTop += Math.floor(el.clientHeight * 0.9);
    });
    await page.waitForTimeout(800); // FlowPaper lazy-renders pages on scroll
  }
  return screenshots;
}

async function screenshotResumePages(page, candidateId) {
  const state = await openResumeTab(page, candidateId);
  if (state.error || state.alreadyMoved || state.noResumeOnFile) return state;
  return { screenshots: await screenshotOpenResume(page, state.isApplication) };
}

const NOT_A_RESUME_RE = /typing|typingtest|certificate|\bwpm\b|words per minute|offer letter|\bnda\b|background check|w-?4|i-?9/i;

/** The attachment(s) to read as the resume: the one matching the Resume tab's title, else every
 * attachment that isn't obviously something else (typing test, offer letter…), at most three. Pure. */
function pickResumeAttachments(attachments, groupTitles = []) {
  const unique = [...new Map((attachments || []).filter((a) => a.href).map((a) => [a.href, a])).values()];
  const titled = unique.filter((a) => groupTitles.some((t) => t && a.descriptor.toLowerCase().includes(t.toLowerCase())));
  if (titled.length) return titled.slice(0, 1);
  return unique.filter((a) => !NOT_A_RESUME_RE.test(a.descriptor)).slice(0, 3);
}

/**
 * Reads the candidate's resume as text, for the rule-based screener. The file is downloaded into
 * memory with the saved login (nothing written to disk, nothing shown in a browser) and read
 * offline. If there's no readable text in it (a scanned resume), it falls back to OCR on
 * screenshots of Paycor's resume viewer.
 * @returns {Promise<{text, method: 'file'|'application'|'ocr', words, note?} | {alreadyMoved} | {noResumeOnFile} | {error}>}
 */
async function readResumeText(page, candidateId, { ocrCachePath } = {}) {
  const state = await openResumeTab(page, candidateId);
  if (state.error || state.alreadyMoved || state.noResumeOnFile) return state;

  if (state.isApplication) {
    const text = await page.locator('.resume-container').innerText();
    return { text, method: 'application', words: wordCount(text) };
  }

  let note = null;
  const picks = pickResumeAttachments(state.attachments, state.groupTitles);
  if (picks.length) {
    const cookies = await page.context().cookies();
    const texts = [];
    for (const pick of picks) {
      try {
        const file = await paycorData.fetchPaycorFile(new URL(pick.href, BASE_URL).toString(), cookies);
        const extracted = await extractText(file.buffer, file);
        if (extracted.words) texts.push(extracted.text);
      } catch (err) {
        if (isLoginRequired(err)) throw err;
        note = err.message;
      }
    }
    const text = texts.join('\n\n');
    if (wordCount(text) >= 30) return { text, method: 'file', words: wordCount(text) };
    note = note || 'The resume file has no readable text (probably a scan).';
  } else {
    note = state.attachments.length ? "Couldn't tell which attachment is the resume." : 'No downloadable resume file was found.';
  }

  const screenshots = await screenshotOpenResume(page, false);
  const ocr = await ocrScreenshots(screenshots, ocrCachePath);
  return { text: ocr.text, method: 'ocr', words: ocr.words, note };
}

/** Accept path: click the green "Resume Quick Screen" button, then confirm the stage actually
 * left the Job Seeker stage. UNCONFIRMED exact toast/confirm behavior — screenshot and adapt on the
 * first live candidate, per the plan. Expects the candidate's profile to already be open. */
async function advanceResumeQuickScreen(page) {
  assertNotLoginPage(page);
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('[ns-qa="suggestedWord"], .green-go-text');
    if (!btn || !/resume quick screen/i.test(btn.textContent || '')) return false;
    btn.click();
    return true;
  });
  if (!clicked) return { error: 'no "Resume Quick Screen" button found' };

  const start = Date.now();
  while (Date.now() - start < 10000) {
    await page.waitForTimeout(500);
    const stage = await readCurrentStage(page);
    if (stage && !isJobSeekerStage(stage)) return { ok: true, newStage: stage };
  }
  return { error: 'clicked Resume Quick Screen but the stage never changed' };
}

/**
 * Accept path when the team chose a status for "resume screened" (Settings → Recruiting steps):
 * moves the candidate to that exact Paycor status through the stage menu — the same menu the email
 * steps use (retryStatusChangeOnly) — then confirms they left the Job Seeker stage.
 * Expects the candidate's profile to already be open.
 */
async function moveToStatus(page, statusText) {
  assertNotLoginPage(page);
  const result = await retryStatusChangeOnly(page, statusText);
  if (!result.ok) return { error: `couldn't move to "${statusText}": ${result.error}` };
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const stage = await readCurrentStage(page);
    if (stage && !isJobSeekerStage(stage)) return { ok: true, newStage: stage };
    await page.waitForTimeout(500);
  }
  return { error: `chose "${statusText}" but the candidate's stage never changed` };
}

// =================================================================================================
// --- Fluency auto-scoring (new in this project — UNVERIFIED) ---
// Field order and labels are transcribed from
// Paycor-full-package/.claude/commands/paycor-fluency.md, which notes these were found live via
// `browser_snapshot` matching by label text each session rather than fixed CSS selectors — no
// one has pinned down stable selectors for this scorecard form yet. The label-text search below
// is the best available substitute; expect to fix this up against the real form.
// =================================================================================================

const TYPING_ATTACHMENT_RE = /typing|certificate|\bwpm\b|words per minute/i;

/**
 * Finds the candidate's Vocaroo link and downloads their typing PDF attachment, if one can be
 * identified. Prefers the link in the reply the engine already read (`replyHtml`, hrefs
 * included), and only falls back to scraping the Newsfeed when that's unavailable.
 * Returns `{ vocarooLink, typingPdfPath, typingPdfNote, attachmentCount }`.
 */
async function getFluencySubmission(page, candidateId, downloadDir, { replyHtml = null } = {}) {
  await openCandidateProfile(page, candidateId);

  let vocarooLink = null;
  if (replyHtml) vocarooLink = findVocarooLink(stripQuote(htmlToText(replyHtml))) || findVocarooLink(replyHtml);
  if (!vocarooLink) {
    const newsfeedHtml = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('*')).filter((el) => /reply to echo email/i.test(el.textContent || '') && el.children.length < 5);
      return items.map((el) => el.innerHTML || '').join('\n');
    });
    vocarooLink = findVocarooLink(newsfeedHtml);
  }

  // The attachment link is a download icon with no text of its own, so match on its attributes
  // and the surrounding row (where the filename is shown) instead.
  const descriptors = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.download-icon a[href*="/attachments/"]')).map((a) => {
      const row = a.closest('li, tr, .attachment, .file-item') || (a.parentElement && a.parentElement.parentElement) || a.parentElement;
      return [a.getAttribute('href'), a.getAttribute('title'), a.getAttribute('aria-label'), a.getAttribute('download'), a.textContent, row ? row.textContent : '']
        .filter(Boolean)
        .join(' ');
    }),
  );
  const matches = descriptors.map((d, i) => ({ d, i })).filter(({ d }) => TYPING_ATTACHMENT_RE.test(d));

  let typingPdfPath = null;
  let typingPdfNote = null;
  if (matches.length === 1) {
    const link = page.locator('.download-icon a[href*="/attachments/"]').nth(matches[0].i);
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    typingPdfPath = path.join(downloadDir, path.basename(download.suggestedFilename()));
    await download.saveAs(typingPdfPath);
  } else if (matches.length > 1) {
    typingPdfNote = `${matches.length} attachments look like a typing test — not guessing which one`;
  } else {
    typingPdfNote = descriptors.length ? 'no attachment could be identified as the typing test' : 'no attachments on file';
  }

  return { vocarooLink, typingPdfPath, typingPdfNote, attachmentCount: descriptors.length };
}

/**
 * Locates the "0.0.A English Fluency and Typing" scorecard's fields on the candidate's profile.
 * Never submits yet: the star-rating widgets (Confident Delivery, Accent, Fluency, Typing Speed
 * Skill) have no confirmed way to be set, and the fluency command's own rule is that a scorecard
 * is never submitted incomplete. Once the widget is confirmed live, set every field and submit
 * here — and only when every field in `missing` is empty.
 *
 * Returns `{ alreadyScored: true }`, `{ error }`, or `{ incomplete: true, missing, notSettable }`.
 */
async function fillFluencyScorecard(page, candidateId) {
  await openCandidateProfile(page, candidateId);
  return page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, timeout = 10000, interval = 200) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const r = fn();
        if (r) return r;
        await sleep(interval);
      }
      return null;
    };
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[\s*:]+$/, '').trim().toLowerCase();

    const card = await waitFor(() =>
      Array.from(document.querySelectorAll('*')).find((el) => el.children.length < 3 && /0\.0\.A English Fluency and Typing/i.test(el.textContent || '')),
    );
    if (!card) return { error: 'scorecard "0.0.A English Fluency and Typing" not found on this candidate' };

    // UNVERIFIED heuristic — never overwrite or re-submit an existing scorecard.
    const container = card.closest('[class*="scorecard"], mat-card, .card, section') || card.parentElement;
    if (container && /\b(submitted|completed)\b/i.test(container.textContent || '')) return { alreadyScored: true };

    const labels = Array.from(document.querySelectorAll('label, .form-label, .field-label, legend'));
    const controlFor = (label) => {
      if (label.htmlFor) return document.getElementById(label.htmlFor);
      const box = label.closest('.form-group, .field, .mat-form-field, fieldset') || label.parentElement;
      return box ? box.querySelector('input, textarea, select') : null;
    };
    // Exact matching: a substring match on "score" also hits "Typing Speed Score - Words per Minute".
    const locate = (name, pred) => {
      const hits = labels.filter((l) => pred(norm(l.textContent)));
      if (hits.length !== 1) return `${name}: ${hits.length ? `${hits.length} matching labels` : 'label not found'}`;
      return controlFor(hits[0]) ? null : `${name}: label found but no input next to it`;
    };
    const missing = [
      locate('voice recording link', (t) => t.includes('link to the voice recording')),
      locate('typing WPM', (t) => t.includes('words per minute')),
      locate('additional comments', (t) => t.includes('additional comments')),
      locate('final score', (t) => t === 'score'),
    ].filter(Boolean);

    return { incomplete: true, missing, notSettable: ['Confident Delivery', 'Accent', 'Fluency', 'Typing Speed Skill'] };
  });
}

module.exports = {
  LoginRequiredError,
  isLoginRequired,
  assertNotLoginPage,
  gotoPaycor,
  openCandidateProfile,
  sendEmailAndAdvance,
  retryStatusChangeOnly,
  passCandidate,
  requestScorecard,
  isReplyNewerThan,
  isFromCandidate,
  pickLatestReply,
  readLatestReply,
  waitForJobList,
  readRenderedJobCards,
  readJobsHeader,
  switchJobFilterToAll,
  scrollAndReadJobCards,
  jobSeekerSearchHref,
  listJobs,
  findJobCard,
  parseDisplayPreviewArg,
  singleCandidateIdFromHref,
  scrapeJobSeekers,
  readCurrentStage,
  isJobSeekerStage,
  openResumeTab,
  screenshotOpenResume,
  screenshotResumePages,
  pickResumeAttachments,
  readResumeText,
  advanceResumeQuickScreen,
  moveToStatus,
  getFluencySubmission,
  fillFluencyScorecard,
  CLIENT_ID,
};
