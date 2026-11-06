'use strict';
// Recruiting Assistant dashboard. No framework and no build step, so it runs as-is from the local
// server. Every value that came from Paycor, a candidate, or the model goes through esc() before
// it touches innerHTML — candidate names and reply text are attacker-controllable.

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

const ID_RE = /^[A-Za-z0-9]{1,64}$/;
function paycorLink(id, label = 'Open in Paycor') {
  if (!ID_RE.test(String(id || ''))) return '';
  return `<a href="https://recruitingbypaycor.com/candidate/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
}

function hashQuery() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}

// ---------------------------------------------------------------------------------------------
// Icons (inline, stroke = currentColor so they follow the theme)
// ---------------------------------------------------------------------------------------------

const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  flag: '<path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4.2a4 4 0 0 1 0 7.6"/><path d="M22 21a6 6 0 0 0-4-5.6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
};
function icon(name) {
  return `<span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg></span>`;
}

// ---------------------------------------------------------------------------------------------
// Plain-language labels
// ---------------------------------------------------------------------------------------------

const TRACK_LABELS = {
  NEW: 'Waiting for first email',
  FIRST_CONTACT: 'First email sent',
  FIRST_CONTACT_REMINDED: 'Reminder sent',
  ATTENTION_1: 'Asked to re-check details',
  ATTENTION_1_REMINDED: 'Re-check reminder sent',
  ATTENTION_2: 'Asked to re-check details (2nd try)',
  ATTENTION_2_REMINDED: 'Re-check reminder sent (2nd try)',
  FLUENCY: 'Fluency & typing test sent',
  FLUENCY_REMINDED: 'Fluency test reminder sent',
  SCORECARD_SUBMITTED: 'Scored',
  MANUAL_REVIEW: 'Needs your review',
  PASSED: 'Passed',
  ERROR: 'Error',
};
const TRACK_TONE = { MANUAL_REVIEW: 'warn', ERROR: 'bad', SCORECARD_SUBMITTED: 'good', PASSED: '', NEW: '' };

const STAGE_GROUPS = [
  { key: 'waiting', label: 'Waiting for first email', tracks: ['NEW'] },
  { key: 'emailed', label: 'Emailed, awaiting reply', tracks: ['FIRST_CONTACT', 'FIRST_CONTACT_REMINDED', 'ATTENTION_1', 'ATTENTION_1_REMINDED', 'ATTENTION_2', 'ATTENTION_2_REMINDED'] },
  { key: 'fluency', label: 'Fluency test sent', tracks: ['FLUENCY', 'FLUENCY_REMINDED'] },
  { key: 'scored', label: 'Scored', tracks: ['SCORECARD_SUBMITTED'] },
  { key: 'passed', label: 'Passed', tracks: ['PASSED'] },
  { key: 'review', label: 'Needs your review', tracks: ['MANUAL_REVIEW'] },
];

const ACTION_LABELS = {
  SEND_FIRST_CONTACT: 'Send the first contact email',
  SEND_FIRST_CONTACT_REMINDER: 'Send a first contact reminder',
  SEND_ATTENTION_1: 'Ask them to re-check their details',
  SEND_ATTENTION_1_REMINDER: 'Send a re-check reminder',
  SEND_ATTENTION_2: 'Ask them to re-check their details (2nd try)',
  SEND_ATTENTION_2_REMINDER: 'Send a re-check reminder (2nd try)',
  SEND_FLUENCY: 'Send the fluency & typing test',
  SEND_FLUENCY_REMINDER: 'Send a fluency test reminder',
  PASS_NO_RESPONSE: 'Pass on them (never replied)',
  PASS_OTHER_QUALIFIED: 'Pass on them (other candidates better qualified)',
  AUTO_SCORE_FLUENCY: 'Score their fluency test',
  QUEUE_FOR_REVIEW: 'Put them in Needs attention',
};

const KIND_NAMES = { daily: 'Daily outreach', screen: 'Screening', act: 'Candidate action', login: 'Paycor login', sync: 'Job refresh' };

const TEMPLATE_LABELS = {
  firstContact: 'First contact email',
  firstContactReminder: 'First contact reminder',
  attentionToDetail1: 'Re-check details email (1st try)',
  attentionToDetail1Reminder: 'Re-check details reminder (1st try)',
  attentionToDetail2: 'Re-check details email (2nd try)',
  attentionToDetail2Reminder: 'Re-check details reminder (2nd try)',
  fluencyEvaluation: 'Fluency & typing test email',
  fluencyReminder: 'Fluency & typing test reminder',
};
const STATUS_LABELS = {
  resumeScreened: 'After the resume is screened (a good fit)',
  firstContactReminder: 'After the first contact reminder',
  attentionToDetail1Reminder: 'After the re-check reminder (1st try)',
  attentionToDetail2Reminder: 'After the re-check reminder (2nd try)',
  fluencyReminder: 'After the fluency & typing test reminder',
  firstContact: 'After the first contact email',
  attentionToDetail1: 'After the re-check email (1st try)',
  attentionToDetail2: 'After the re-check email (2nd try)',
  fluencyEvaluation: 'After the fluency & typing test email',
};
const PASS_LABELS = {
  noResponse: 'When a candidate never replies',
  otherQualified: 'After two failed re-checks',
};

// ---------------------------------------------------------------------------------------------
// Shared state, runs and polling
// ---------------------------------------------------------------------------------------------

const store = { health: null, latestJobs: {}, candidatesById: {}, watching: null, settingsDraft: null, attentionTab: 'open' };

async function refreshHealth() {
  try {
    store.health = await api('GET', '/api/health');
  } catch {
    return;
  }
  const h = store.health;
  // New job data arrived (automatic refresh) — redraw pages that show it, unless the person is typing.
  if (store.jobsSyncedAt !== undefined && h.jobsSyncedAt !== store.jobsSyncedAt && !gate.shown && ['home', 'jobs'].includes(currentRoute())) {
    const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (!typing) setTimeout(render, 0);
  }
  store.jobsSyncedAt = h.jobsSyncedAt;
  $('#account').hidden = !h.paycorConnected;
  $('#account-status').innerHTML = `${icon('checkCircle')}Logged in to Paycor`;
  if (!h.paycorConnected && !gate.shown) {
    showGate(h.paycorLastConnectedAt ? 'Your Paycor session has ended. Log in again to continue.' : null);
  }
  const badge = $('#nav-attention');
  badge.textContent = h.openReviewCount;
  badge.hidden = !h.openReviewCount;
  const indicator = $('#run-indicator');
  indicator.hidden = !h.activeJob;
  if (h.activeJob) {
    $('#run-indicator-text').textContent = `${KIND_NAMES[h.activeJob.kind] || 'A run'} in progress…`;
    if (store.watching !== h.activeJob.id) watchJob(h.activeJob.id);
  }
  $$('[data-needs-idle]').forEach((b) => (b.disabled = !!h.activeJob));
}

async function refreshLatestJobs() {
  try {
    store.latestJobs = await api('GET', '/api/jobs/latest');
  } catch {
    // keep what we had
  }
}

function watchJob(jobId) {
  store.watching = jobId;
  const tick = async () => {
    if (store.watching !== jobId) return;
    let job;
    try {
      job = await api('GET', `/api/jobs/${jobId}`);
    } catch {
      return;
    }
    store.latestJobs[job.kind] = job;
    updateRunPanels();
    if (gate.shown) renderGate();
    if (job.status === 'running') {
      setTimeout(tick, 1500);
      return;
    }
    store.watching = null;
    if (job.kind === 'login' && job.result && job.result.ok) {
      hideGate();
      toast(job.result.jobsFound != null ? `Logged in — ${job.result.jobsFound} job${job.result.jobsFound === 1 ? '' : 's'} loaded from Paycor.` : 'Logged in to Paycor.');
      await refreshHealth();
      if (location.hash === '#/jobs') render();
      else location.hash = '#/jobs'; // the hashchange handler renders it
      return;
    }
    if (job.kind !== 'login') toast(job.status === 'done' ? `${KIND_NAMES[job.kind]} finished.` : `${KIND_NAMES[job.kind]} stopped — see the result for details.`);
    await refreshHealth();
    if (!gate.shown && ['home', 'attention', 'candidates', 'jobs'].includes(currentRoute())) render();
  };
  tick();
}

async function startJob(url, body, kind) {
  try {
    const { jobId } = await api('POST', url, body);
    store.latestJobs[kind] = { id: jobId, kind, status: 'running', dryRun: !!(body && body.dryRun), startedAt: new Date().toISOString() };
    updateRunPanels();
    await refreshHealth();
    watchJob(jobId);
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------------------------------------
// Run results in plain language
// ---------------------------------------------------------------------------------------------

function banner(tone, title, body = '', extra = '') {
  const ic = { good: 'checkCircle', warn: 'alert', bad: 'xCircle' }[tone];
  return `<div class="banner ${tone}">${icon(ic)}<div><strong>${esc(title)}</strong>${body ? `<div>${body}</div>` : ''}${extra}</div></div>`;
}

function tiles(items) {
  return `<div class="kpis">${items
    .map((t) => `<div class="tile"><div class="tile-label">${esc(t.label)}</div><div class="tile-value">${esc(t.value)}</div></div>`)
    .join('')}</div>`;
}

const connectButton = `<div class="button-row"><button class="primary" data-action="connect" data-needs-idle>${icon('plug')}Log in to Paycor</button></div>`;

function nameFor(id) {
  const c = store.candidatesById[id];
  return c && c.name && c.name !== '(unknown name)' ? c.name : id;
}

function describeResult(job) {
  const r = job.result;
  if (!r) {
    return banner('bad', 'The run stopped with an error', 'Open "Technical details" below, or send them to whoever set this up.');
  }
  if (r.busy) return banner('warn', 'Something else was already running', 'Wait for it to finish, then try again.');
  if (r.loginRequired) {
    return banner('warn', 'Paycor needs you to log in', 'The run stopped safely before doing anything else. Connect to Paycor, then run it again.', connectButton);
  }

  if (r.kind === 'login') {
    if (!r.ok) return banner('bad', "Couldn't finish the Paycor login", esc(r.error || 'The login window closed or timed out. Try again and finish signing in within 5 minutes.'));
    if (r.jobsError) return banner('warn', 'Logged in to Paycor', `But the job list couldn't be read: ${esc(r.jobsError)} Try "Refresh from Paycor" on the Jobs page.`);
    return banner(r.scopeNote ? 'warn' : 'good', 'Logged in to Paycor', `${esc(r.jobsFound)} job${r.jobsFound === 1 ? '' : 's'} loaded${r.scope ? ` ("${esc(r.scope)}")` : ''}.${r.scopeNote ? ` ${esc(r.scopeNote)}` : ''}`);
  }

  if (r.kind === 'sync') {
    if (!r.ok) return banner('bad', "Couldn't refresh the job list", esc(r.error));
    const partial = r.totalReported && r.totalReported > r.jobsFound ? ` Paycor reports ${esc(r.totalReported)} — some may not have been readable.` : '';
    const note = r.scopeNote ? ` ${esc(r.scopeNote)}` : '';
    return banner(partial || note ? 'warn' : 'good', `${r.jobsFound} job${r.jobsFound === 1 ? '' : 's'} loaded from Paycor${r.scope ? ` ("${r.scope}")` : ''}`, partial + note);
  }

  if (r.kind === 'act') {
    if (r.ok) return banner('good', 'Done', esc(r.note));
    if (r.alreadyMoved) return banner('warn', 'Nothing was done', 'This candidate had already moved on in Paycor, so the item has been closed.');
    return banner('bad', 'That didn\'t work', esc(r.error));
  }

  if (r.error) return banner('bad', 'The run stopped', esc(r.error));

  if (r.kind === 'daily') {
    const s = r.summary || {};
    const problems = (s.errors || []).map((e) => `<li>${esc(nameFor(e.candidateId))}: ${esc(e.message)}</li>`).join('');
    const problemsBlock = problems ? banner('warn', `${s.errors.length} candidate${s.errors.length === 1 ? '' : 's'} had a problem`, `They'll be retried on the next run.<ul class="result-list">${problems}</ul>`) : '';
    // Who was picked up from Paycor this run, and what happens next — grouped by job.
    const it = r.intake;
    const STEP_NAMES = { NEW: 'new — first contact due', FIRST_CONTACT: 'waiting on first contact', FIRST_CONTACT_REMINDED: 'first contact reminded', ATTENTION_1: 're-check (1st)', ATTENTION_1_REMINDED: 're-check reminded (1st)', ATTENTION_2: 're-check (2nd)', ATTENTION_2_REMINDED: 're-check reminded (2nd)', FLUENCY: 'fluency test', FLUENCY_REMINDED: 'fluency test reminded' };
    const scopeText = r.pipelineKey ? pipelineLabel(r.pipelineKey, r.pipelines) : 'all pipelines';
    const intakeBlock = it
      ? `<div class="card" style="margin-top:12px;box-shadow:none;background:var(--surface-2)"><strong>Found in Paycor (${esc(scopeText)}):</strong> ${esc(it.total)} candidate${it.total === 1 ? '' : 's'} picked up${it.total ? ` (${Object.entries(it.pickedUp || {}).map(([k, n]) => `${esc(n)} ${esc(STEP_NAMES[k] || k)}`).join(', ')})` : ''}.${it.stopped ? ` ${esc(it.stopped)} stopped because they were moved in Paycor.` : ''}${it.overNewLimit ? `<div class="hint">${esc(it.overNewLimit)} more new candidate${it.overNewLimit === 1 ? '' : 's'} get the first contact email on the next runs (limit ${esc(it.maxNew)} per run) — listed under each job below.</div>` : ''}${(it.errors || []).length ? `<div class="hint">Problems: ${it.errors.map(esc).join('; ')}</div>` : ''}</div>`
      : '';
    const who = (items) => {
      const names = items.map((i) => esc(i.name || nameFor(i.candidateId)));
      return names.length > 12 ? `${names.slice(0, 12).join(', ')} <details style="display:inline"><summary>and ${names.length - 12} more</summary>${names.slice(12).join(', ')}</details>` : names.join(', ');
    };
    // One section per job: each action with the candidates it applies to, plus anyone held for a later run.
    const byPipeline = (planned, deferred) => {
      const keys = [...new Set([...planned.map((p) => p.pipelineKey), ...deferred.map((d) => d.pipelineKey)])];
      keys.sort((x, y) => pipelineLabel(x, r.pipelines).localeCompare(pipelineLabel(y, r.pipelines)));
      return keys
        .map((key) => {
          const mine = planned.filter((p) => p.pipelineKey === key);
          const later = deferred.filter((d) => d.pipelineKey === key);
          const groups = {};
          for (const p of mine) (groups[p.action] = groups[p.action] || []).push(p);
          const lines = Object.entries(groups).map(([action, items]) => `<li><strong>${esc(ACTION_LABELS[action] || action)} (${items.length})</strong>: ${who(items)}</li>`);
          if (later.length) lines.push(`<li><strong>First contact on a later run (${later.length})</strong>: ${who(later)}</li>`);
          const count = mine.length + later.length;
          return `<details class="pipeline-result"${keys.length <= 3 ? ' open' : ''}><summary><strong>${esc(pipelineLabel(key, r.pipelines))}</strong> <span class="muted small">— ${esc(count)} candidate${count === 1 ? '' : 's'}</span></summary><ul class="result-list">${lines.join('')}</ul></details>`;
        })
        .join('');
    };
    if (r.dryRun) {
      const planned = s.planned || [];
      const deferred = (it && it.deferred) || [];
      const note = `<p class="hint">Replies are read from your Paycor notifications (email and text replies) — ${s.repliesProcessed ? `${esc(s.repliesProcessed)} found this time` : 'none found this time'}. A real run also checks each candidate's profile once more before sending a reminder or passing them.</p>`;
      if (!planned.length && !deferred.length) {
        return `${banner('good', 'Test run finished — nothing was changed', `Nobody in ${esc(scopeText)} is due for an email, reminder or pass right now.`)}${intakeBlock}${note}`;
      }
      return `${banner('good', 'Test run finished — nothing was changed', `Here is what a real run would do right now for ${esc(scopeText)}:`)}${intakeBlock}<div style="margin-top:12px">${byPipeline(planned, deferred)}</div>${note}${problemsBlock}`;
    }
    return `${banner('good', 'Daily outreach finished')}<div style="margin-top:12px">${tiles([
      { label: 'Replies handled', value: s.repliesProcessed || 0 },
      { label: 'First emails sent', value: s.newCandidatesStarted || 0 },
      { label: 'Reminders sent', value: s.remindersSent || 0 },
      { label: 'Passed', value: s.passed || 0 },
      { label: 'Sent to Needs attention', value: s.manualReviewAdded || 0 },
    ])}</div>${intakeBlock}${s.backlogCapTripped ? banner('warn', 'Safety pause', 'More candidates than usual were due to be passed at once, so they were put in Needs attention instead.') : ''}${problemsBlock}`;
  }

  if (r.kind === 'screen') {
    const messages = {
      job_not_found: `Couldn't find job "${esc(r.jobQuery)}" in the Active Jobs on Paycor. Check the Job ID, and that the job is still open.`,
      ambiguous_job: `More than one job matches "${esc(r.jobQuery)}": ${(r.matches || []).map((m) => `${esc(m.title)} (Job ID ${esc(m.jobId)})`).join(', ')}. Use the Job ID instead.`,
      no_new_applicants: `${esc(r.title)} (Job ID ${esc(r.jobId)}) has no new applicants right now.`,
      missing_criteria:
        r.engine === 'claude'
          ? `There's no saved job description for Job ID ${esc(r.jobId)} yet. Paste it in step 2, save it, and try again.`
          : `There are no screening rules for Job ID ${esc(r.jobId)} yet. Fill them in under step 2, save them, and try again.`,
      invalid_rules: `The screening rules for Job ID ${esc(r.jobId)} need a fix: ${(r.problems || []).map(esc).join(' ')}`,
      error: esc(r.detail),
    };
    if (r.status !== 'completed') {
      return banner(r.status === 'no_new_applicants' ? 'good' : 'warn', r.status === 'no_new_applicants' ? 'Nothing to screen' : "Screening didn't start", messages[r.status] || esc(r.status));
    }
    const target = r.screenedStatus || 'Resume Quick Screen';
    const checksOf = (c, result) => (c.checks || []).filter((k) => k.result === result).map((k) => k.name);
    const outcomeText = (c) => {
      switch (c.outcome) {
        case 'accepted':
          return r.dryRun ? [`Would move to ${target}`, 'good'] : [`Moved to ${target}${c.enrolled ? ' + added to outreach' : ''}`, 'good'];
        case 'rejected': {
          const failed = checksOf(c, 'fail');
          return [`${r.dryRun ? 'Would reject' : 'Rejected (Passed)'} — ${c.reason}${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`, 'bad'];
        }
        case 'manual_review': {
          if (c.detail === 'pass cap reached') return [`${r.dryRun ? 'Would go' : 'Sent'} to Needs attention — the pass limit for one run was reached`, 'warn'];
          const unsure = checksOf(c, 'unsure');
          return [`${r.dryRun ? 'Would go' : 'Sent'} to Needs attention — not sure about: ${unsure.join(', ') || 'the resume'}`, 'warn'];
        }
        case 'no_resume_on_file':
          return ['Skipped — no resume on file', ''];
        case 'already_moved': {
          // The stage text from Paycor carries icon names like "directions_run" — show just the status.
          const now = String(c.detail || '').replace(/[a-z]+(_[a-z]+)+/g, '|').split('|').map((t) => t.trim()).filter(Boolean)[0];
          return [`Skipped — no longer a new applicant (now "${now || 'unknown'}")`, ''];
        }
        default:
          return ['Problem', 'bad'];
      }
    };
    const rows = (r.candidates || [])
      .map((c) => {
        const [label, tone] = outcomeText(c);
        // One line per rule, marked with how it came out, so you can see the logic at work.
        const mark = { pass: '✓', fail: '✗', unsure: '?', info: '·' };
        const why = c.checks && c.checks.length
          ? c.checks.map((k) => `<span class="check-${esc(k.result)}">${mark[k.result] || '·'} <strong>${esc(k.name)}:</strong> ${esc(k.detail)}</span>`).join('<br>')
          : c.outcome === 'already_moved'
            ? ''
            : String(c.evidence || c.detail || '').split(' · ').map(esc).join('<br>');
        return `<tr><td>${esc(c.name || c.candidateId)}<div class="small">${paycorLink(c.candidateId)}</div>${c.readBy ? `<div class="small muted">Read from: ${esc(c.readBy)}</div>` : ''}</td><td><span class="pill ${tone}">${esc(label)}</span></td><td class="small">${why}</td></tr>`;
      })
      .join('');
    const title = r.dryRun ? `Test run finished for ${r.title} — nothing was changed in Paycor` : `Screening finished for ${r.title}`;
    return `${banner('good', title)}<div style="margin-top:12px">${tiles([
      { label: r.dryRun ? `Would move to ${target}` : `Moved to ${target}`, value: r.advanced || (r.dryRun ? (r.candidates || []).filter((c) => c.outcome === 'accepted').length : 0) },
      { label: r.dryRun ? 'Would reject' : 'Rejected', value: r.passed || (r.dryRun ? (r.candidates || []).filter((c) => c.outcome === 'rejected').length : 0) },
      { label: r.dryRun ? 'Would need a person' : 'Sent to Needs attention', value: r.manualReview || 0 },
      { label: 'Skipped', value: (r.skippedNoResume || 0) + (r.skippedAlreadyMoved || 0) },
    ])}</div>${r.stoppedAtPassCap ? banner('warn', 'Stopped at the safety limit', `This run made its ${esc(r.passed || 0)} automatic passes (the limit per run), so it stopped. The remaining ${esc(r.leftForNextRun || 0)} applicants are screened on the next run.`) : r.leftForNextRun ? `<p class="hint" style="margin-top:10px">${esc(r.totalWaiting)} new applicants were waiting; the newest ${esc((r.candidates || []).length)} were screened this run and the other ${esc(r.leftForNextRun)} are screened on the next runs (Settings → Safety limits).</p>` : ''}${
      rows ? `<div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Result</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''
    }`;
  }

  return banner('good', 'Finished');
}

function runPanelHtml(kind) {
  const job = store.latestJobs[kind];
  if (!job) return '';
  if (job.status === 'running') {
    // Everything runs in the background (no browser window, except Paycor's own login page).
    const extra = kind === 'login' ? 'A Paycor window has opened — log in there.' : 'Working in the background — you can keep using the dashboard.';
    const pr = job.progress;
    const counted = pr && pr.total > 0;
    const pct = counted ? Math.round((100 * Math.min(pr.done, pr.total)) / pr.total) : 0;
    const progress = pr
      ? `<div class="progress" style="margin-top:10px">
          <div class="progress-label"><span>${esc(pr.label)}</span>${counted ? `<strong>${esc(pr.done)}/${esc(pr.total)} completed</strong>` : '<span class="muted">starting…</span>'}</div>
          ${counted ? `<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${esc(pr.total)}" aria-valuenow="${esc(pr.done)}"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
        </div>`
      : '';
    return `<div class="card"><div class="run-status"><span class="spinner" aria-hidden="true"></span>${esc(KIND_NAMES[kind])}${job.dryRun ? ' (test run)' : ''} is running…</div>${progress}<p class="hint">${esc(extra)}</p></div>`;
  }
  const when = job.finishedAt ? `<p class="hint">${esc(job.dryRun ? 'Test run' : 'Run')} finished ${esc(timeAgo(job.finishedAt))}.</p>` : '';
  const tech = job.log ? `<details class="tech"><summary>Technical details</summary><pre>${esc(job.log)}</pre></details>` : '';
  return `<div class="card">${describeResult(job)}${when}${tech}</div>`;
}

function updateRunPanels() {
  $$('[data-run-kind]').forEach((el) => {
    el.innerHTML = runPanelHtml(el.dataset.runKind);
  });
  if (store.health) $$('[data-needs-idle]').forEach((b) => (b.disabled = !!store.health.activeJob || Object.values(store.latestJobs).some((j) => j && j.status === 'running')));
}

// Buttons rendered inside result cards (e.g. "Connect to Paycor") work on every page.
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-action="connect"]');
  if (!btn) return;
  ev.preventDefault();
  startJob('/api/paycor/login', {}, 'login');
});

// ---------------------------------------------------------------------------------------------
// Login screen — shown whenever this computer isn't logged in to Paycor
// ---------------------------------------------------------------------------------------------

const gate = { shown: false, reason: null };

function showGate(reason = null) {
  gate.shown = true;
  gate.reason = reason;
  document.body.classList.add('gated');
  $('#gate').hidden = false;
  renderGate();
}

function hideGate() {
  gate.shown = false;
  document.body.classList.remove('gated');
  $('#gate').hidden = true;
}

function renderGate() {
  const job = store.latestJobs.login;
  const brand = `<div class="brand"><span class="brand-mark" aria-hidden="true">RA</span><div><div class="brand-name">Recruiting Assistant</div><div class="brand-sub">for Paycor</div></div></div>`;
  let body;
  if (job && job.status === 'running') {
    body = `
      <h1>Sign in to Paycor</h1>
      <div class="run-status" style="margin-top:12px"><span class="spinner" aria-hidden="true"></span>Waiting for you to sign in…</div>
      <ol class="gate-steps">
        <li>A Paycor window has opened. If you can't see it, check your taskbar for Microsoft Edge.</li>
        <li>Enter your Paycor username and password there, and the verification code if Paycor asks for one.</li>
        <li>That's it — this page continues by itself once Paycor finishes loading.</li>
      </ol>
      <p class="fine">You have 5 minutes. Your password goes only to Paycor; this app never sees or stores it.</p>`;
  } else {
    const failed = job && job.status !== 'running' && job.result && !job.result.ok && !job.result.busy;
    const busy = job && job.result && job.result.busy;
    body = `
      <h1>Log in to Paycor</h1>
      <p>${esc(gate.reason || 'Sign in with your own Paycor account to load your jobs and start working.')}</p>
      ${failed ? `<div style="margin-top:14px">${banner('bad', "The login didn't finish", esc(job.result.error || 'Try again.'))}</div>` : ''}
      ${busy ? `<div style="margin-top:14px">${banner('warn', 'Something else is running', 'Wait a moment and try again.')}</div>` : ''}
      <button class="primary" id="gate-login">${icon('plug')}${failed ? 'Try again' : 'Log in to Paycor'}</button>
      <p class="fine">Opens Paycor's own login page in a separate window. Your password goes only to Paycor — this app never sees or stores it. You'll stay logged in on this computer until Paycor ends the session or you log out.</p>`;
  }
  $('#gate').innerHTML = `<div class="gate-card">${brand}${body}</div>`;
  const btn = $('#gate-login');
  if (btn) btn.addEventListener('click', () => startJob('/api/paycor/login', {}, 'login').then(renderGate));
}

$('#logout-btn').addEventListener('click', async () => {
  if (!confirm('Log out of Paycor on this computer?\n\nThe next person to open the dashboard will be asked to log in with their own Paycor account.')) return;
  try {
    await api('POST', '/api/paycor/logout');
    store.latestJobs.login = null;
    showGate('You are logged out. Log in with a Paycor account to continue.');
    refreshHealth();
  } catch (err) {
    toast(err.message);
  }
});

async function loadCandidates() {
  const state = await api('GET', '/api/state');
  store.candidatesById = Object.fromEntries(state.candidates.map((c) => [c.id, c]));
  return state;
}

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

function pageHead(title, sub) {
  return `<div class="page-head"><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>`;
}

function setupNeededBanner() {
  return banner('warn', 'Finish setting up first', 'Save at least one pipeline in Settings before running anything.', '<div class="button-row"><a class="btn small" href="#/settings">Open Settings</a></div>');
}

async function renderHome(main) {
  await Promise.all([refreshHealth(), refreshLatestJobs()]);
  const [state, review, jobData, ap] = await Promise.all([loadCandidates(), api('GET', '/api/manual-review'), api('GET', '/api/paycor/jobs'), api('GET', '/api/autopilot').catch(() => null)]);
  const h = store.health;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const steps = [
    { done: h.configured, title: 'Save your pipeline settings', sub: 'Email template names and Paycor statuses for each job pipeline.', action: '<a class="btn small" href="#/settings">Open Settings</a>' },
    ...(h.screeningEngine === 'claude'
      ? [{ done: h.apiKeySet, title: 'Add your Claude API key', sub: 'Screening is set to use Claude AI (about 1.5¢ per resume).', action: '<a class="btn small" href="#/settings">Add key</a>' }]
      : []),
    { done: h.fluencyHelper.ok, title: 'Fluency helper installed', sub: h.fluencyHelper.ok ? 'The free offline voice-recording scorer is ready.' : h.fluencyHelper.reason, action: '' },
  ];
  const allSet = steps.every((s) => s.done);
  const setupCard = allSet
    ? `<p class="status good">${icon('checkCircle')}All set · Logged in to Paycor${h.paycorLastConnectedAt ? ` since ${esc(timeAgo(h.paycorLastConnectedAt))}` : ''}</p>`
    : `<div class="card"><h2>Get set up</h2><p class="hint">${steps.filter((s) => s.done).length} of ${steps.length} done.</p><ul class="checklist">${steps
        .map(
          (s) => `<li><span class="check-dot ${s.done ? 'done' : ''}">${s.done ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS.check}</svg>` : ''}</span><div class="grow"><div class="title">${esc(s.title)}</div><div class="hint">${esc(s.sub)}</div></div>${s.done ? '' : s.action}</li>`,
        )
        .join('')}</ul></div>`;

  const count = (group) => STAGE_GROUPS.find((g) => g.key === group).tracks.reduce((n, t) => n + (state.byTrack[t] || 0), 0);
  const openCount = review.open.length;
  const kpi = (label, value, href, note = '') => `<a class="tile" href="${href}"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${note}</a>`;
  const kpis = `<div class="kpis">
    ${kpi('Needs your attention', openCount, '#/attention', openCount ? `<div class="tile-note status warn">${icon('alert')}Waiting on you</div>` : '<div class="tile-note status good">' + icon('checkCircle') + 'All clear</div>')}
    ${kpi('Waiting for first email', count('waiting'), '#/candidates?stage=waiting')}
    ${kpi('Emailed, awaiting reply', count('emailed'), '#/candidates?stage=emailed')}
    ${kpi('Fluency test sent', count('fluency'), '#/candidates?stage=fluency')}
    ${kpi('Scored', count('scored'), '#/candidates?stage=scored')}
    ${kpi('Passed', count('passed'), '#/candidates?stage=passed')}
  </div>`;

  const lastRuns = ['screen', 'daily']
    .map((k) => store.latestJobs[k])
    .filter(Boolean)
    .map((j) => `<li>${esc(KIND_NAMES[j.kind])}${j.dryRun ? ' (test run)' : ''} — ${j.status === 'running' ? 'running now' : `${j.status === 'done' ? 'finished' : 'stopped with a problem'} ${esc(timeAgo(j.finishedAt))}`}</li>`)
    .join('');

  main.innerHTML = `
    ${pageHead(h.name ? `${greeting}, ${h.name.split(' ')[0]}` : 'Welcome', 'Screen new applicants, run the daily outreach, and handle anything that needs a person.')}
    <div class="stack">
      ${setupCard}
      <div data-run-kind="login"></div>
      ${h.needsAttention ? banner('warn', 'The last outreach run left you a note', `<pre>${esc(h.needsAttention)}</pre>`) : ''}
    </div>
    <div class="section-title">Autopilot</div>
    <div id="autopilot-card">${autopilotCardHtml(ap)}</div>
    <div class="section-title">Jobs with new applicants</div>
    ${(() => {
      const homeScope = jobScope(jobData);
      const withNew = jobsInScope(jobData, homeScope).filter((j) => j.jobSeekerCount > 0);
      const scopeName = jobData.hasMyJobs ? ` (${homeScope === 'mine' ? 'My Jobs' : 'All Jobs'})` : '';
      if (!jobData.syncedAt) return `<div class="card"><p class="hint" style="margin:0">Your jobs haven't been loaded yet. <a href="#/jobs">Open Jobs</a> and click "Refresh from Paycor".</p></div>`;
      if (jobData.jobs.length && jobData.jobs.every((j) => j.jobSeekerCount == null)) {
        return `<div class="card"><p class="hint" style="margin:0">${esc(jobData.jobs.length)} jobs loaded. New-applicant counts aren't available yet — <a href="#/jobs">open Jobs</a> to screen any of them.</p></div>`;
      }
      if (!withNew.length) return `<div class="card"><p class="status good" style="margin:0">${icon('checkCircle')}No new applicants waiting in ${homeScope === 'mine' && jobData.hasMyJobs ? 'your jobs ("My Jobs")' : `any of the ${esc(jobData.jobs.length)} jobs`} (as of ${esc(timeAgo(jobData.syncedAt))}).${homeScope === 'mine' && jobData.hasMyJobs ? ' <a href="#/jobs">See All Jobs</a>' : ''}</p></div>`;
      return `<div class="card"><div class="table-wrap" style="margin-top:0"><table><tbody>${withNew
        .slice(0, 6)
        .map((j) => `<tr><td><strong>${esc(j.title)}</strong> ${priorityPillHtml(j)}<div class="small muted">${jobMetaHtml(j)}</div></td><td>${jobReadinessHtml(j)}</td><td style="text-align:right">${jobActionHtml(j)}</td></tr>`)
        .join('')}</tbody></table></div>${withNew.length > 6 ? `<p class="hint"><a href="#/jobs">See all ${withNew.length} jobs with new applicants</a></p>` : ''}<p class="hint">Most urgent first${esc(scopeName)}, as of ${esc(timeAgo(jobData.syncedAt))} — updates automatically every ${esc((jobData.autoRefresh && jobData.autoRefresh.everyMinutes) || 15)} minutes · <a href="#/jobs">All jobs</a></p></div>`;
    })()}
    <div class="section-title">Candidates in outreach</div>
    ${kpis}
    <div class="section-title">What would you like to do?</div>
    <div class="actions-grid">
      <a class="action-card" href="#/screen">${icon('search')}<div><strong>Screen new applicants</strong><span class="hint">Read each new resume and advance or pass them.</span></div></a>
      <a class="action-card" href="#/outreach">${icon('send')}<div><strong>Run today's outreach</strong><span class="hint">Check replies, send the next emails and reminders.</span></div></a>
      <a class="action-card" href="#/attention">${icon('flag')}<div><strong>Review ${openCount} item${openCount === 1 ? '' : 's'}</strong><span class="hint">Decisions the assistant left for you.</span></div></a>
    </div>
    ${lastRuns ? `<div class="section-title">Recent runs</div><div class="card"><ul class="result-list" style="margin:0">${lastRuns}</ul></div>` : ''}
  `;
  wireAutopilot(main, ap);
}

// --- Autopilot card (Home) ----------------------------------------------------------------------

function autopilotCycleLine(c) {
  const sc = c.screened || [];
  const sum = (k) => sc.reduce((n, x) => n + (x[k] || 0), 0);
  const parts = [];
  if (sc.length) parts.push(`screened ${sc.length} job${sc.length === 1 ? '' : 's'}: ${sum('advanced')} to Resume Quick Screen, ${sum('passed')} passed, ${sum('needsAttention')} to Needs attention${sum('waiting') ? `, ${sum('waiting')} older applicants still waiting for the next cycles` : ''}`);
  else parts.push('no new applicants to screen');
  if (c.outreach) parts.push(`outreach: ${c.outreach.replies} repl${c.outreach.replies === 1 ? 'y' : 'ies'} handled, ${c.outreach.firstEmails} first emails, ${c.outreach.reminders} reminders, ${c.outreach.passed} passed`);
  const errs = sum('errors') + ((c.outreach && c.outreach.errors) || 0);
  if (errs) parts.push(`${errs} problem${errs === 1 ? '' : 's'} (retried next time)`);
  return `<li><strong>${esc(timeAgo(c.startedAt))}</strong>${c.dryRun ? ' <span class="pill">test cycle — nothing changed; numbers are what would happen</span>' : c.manual ? ' (started by hand)' : ''} — ${esc(parts.join('; '))}.${(c.problems || []).map((p) => ` <span class="pill warn">${esc(p)}</span>`).join('')}</li>`;
}

function autopilotCardHtml(ap) {
  if (!ap) return '';
  const status = ap.running
    ? `<div class="run-status"><span class="spinner" aria-hidden="true"></span>${esc(ap.step || 'Working…')}</div>`
    : ap.enabled
      ? `<p class="status good" style="margin:0">${icon('checkCircle')}On — every ${esc(ap.everyMinutes)} minutes. Next cycle ${ap.nextAt && Date.parse(ap.nextAt) > Date.now() + 30000 ? `around ${esc(new Date(ap.nextAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}` : 'within a minute'}.</p>`
      : `<p class="status" style="margin:0">${icon('alert')}Off — nothing runs by itself.</p>`;
  const wh = ap.workHours || { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', timeZone: '' };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Tokyo', 'Europe/London', 'UTC'];
  const hoursBlock = `<div class="inline" style="margin-top:14px;gap:8px">
      <strong>Work hours:</strong>
      ${DAYS.map((d, i) => `<label class="checkbox" style="gap:4px"><input type="checkbox" data-ap-day="${i}"${wh.days.includes(i) ? ' checked' : ''} />${d}</label>`).join('')}
      <input type="time" id="ap-start" value="${esc(wh.start)}" style="margin-top:0;width:auto" /> to <input type="time" id="ap-end" value="${esc(wh.end)}" style="margin-top:0;width:auto" />
      <input type="text" id="ap-tz" list="ap-zones" value="${esc(wh.timeZone)}" style="margin-top:0;max-width:200px" aria-label="Time zone" /><datalist id="ap-zones">${ZONES.map((z) => `<option value="${z}"></option>`).join('')}</datalist>
      <button id="ap-hours" class="small">Save work hours</button>
    </div>
    <p class="hint">Cycles only start during work hours${ap.workHoursText ? ` — ${esc(ap.workHoursText)}` : ''}${ap.enabled && !ap.inWorkHours ? '. It is outside work hours right now, so Autopilot is waiting.' : '.'}</p>`;
  return `<div class="card">
    <p class="hint" style="margin-top:0">While this dashboard is open, Autopilot screens every pipeline job's new applicants (good fits go to Resume Quick Screen, clear mismatches are passed) and then runs the outreach — replies, first emails, reminders — for all pipelines. Each step shows its progress on the Screen applicants and Daily outreach pages.</p>
    <div class="inline" style="margin:12px 0">
      ${status}
    </div>
    <div class="inline">
      <button id="ap-toggle" class="${ap.enabled ? '' : 'primary'}">${ap.enabled ? 'Turn Autopilot off' : 'Turn Autopilot on'}</button>
      <label class="inline" style="gap:6px">Every
        <select id="ap-every" style="margin-top:0">${ap.choices.map((m) => `<option value="${m}"${m === ap.everyMinutes ? ' selected' : ''}>${m} minutes</option>`).join('')}</select>
      </label>
      <button id="ap-test" ${ap.running ? 'disabled' : ''} data-needs-idle>Test one cycle</button>
      <button id="ap-run" ${ap.running ? 'disabled' : ''} data-needs-idle>Run one cycle now</button>
    </div>
    ${hoursBlock}
    <p class="hint">Turn it on for <strong>one computer only</strong> — two computers on Autopilot for the same jobs would email candidates twice. It stops when the Paycor login expires (log in again and it carries on) and only runs while this computer and this dashboard are on.</p>
    ${ap.history && ap.history.length ? `<details class="tech" ${ap.running ? '' : 'open'}><summary>Recent cycles</summary><ul class="result-list">${ap.history.slice(0, 5).map(autopilotCycleLine).join('')}</ul></details>` : ''}
  </div>`;
}

function wireAutopilot(main, ap) {
  if (!ap || !$('#ap-toggle', main)) return;
  const redraw = async () => {
    const fresh = await api('GET', '/api/autopilot').catch(() => null);
    if (!fresh || currentRoute() !== 'home' || !$('#autopilot-card', main)) return;
    $('#autopilot-card', main).innerHTML = autopilotCardHtml(fresh);
    wireAutopilot(main, fresh);
  };
  $('#ap-toggle', main).addEventListener('click', async () => {
    if (!ap.enabled && !confirm(`Turn Autopilot on?\n\nEvery ${ap.everyMinutes} minutes it will, for real:\n• screen new applicants — move good fits to Resume Quick Screen and pass clear mismatches\n• send first contact emails and reminders, handle replies, and pass candidates who never reply\n\nOnly turn it on for one computer.`)) return;
    try {
      await api('PUT', '/api/autopilot', { enabled: !ap.enabled });
      toast(ap.enabled ? 'Autopilot is off.' : 'Autopilot is on — the first cycle starts within a minute.');
    } catch (err) {
      toast(err.message);
    }
    redraw();
  });
  $('#ap-every', main).addEventListener('input', async (ev) => {
    try {
      await api('PUT', '/api/autopilot', { everyMinutes: Number(ev.target.value) });
      toast(`Autopilot: every ${ev.target.value} minutes.`);
    } catch (err) {
      toast(err.message);
    }
    redraw();
  });
  $('#ap-test', main).addEventListener('click', async () => {
    try {
      await api('POST', '/api/autopilot/run', { dryRun: true });
      toast('Test cycle started — nothing will be changed in Paycor.');
    } catch (err) {
      toast(err.message);
    }
    setTimeout(redraw, 1500);
  });
  $('#ap-run', main).addEventListener('click', async () => {
    if (!confirm('Run one Autopilot cycle now?\n\nThis screens new applicants and runs the outreach for real — emails are sent and candidates may be passed.')) return;
    try {
      await api('POST', '/api/autopilot/run');
      toast('Autopilot cycle started.');
    } catch (err) {
      toast(err.message);
    }
    setTimeout(redraw, 1500);
  });
  $('#ap-hours', main).addEventListener('click', async () => {
    const days = $('[data-ap-day]', main).filter((c) => c.checked).map((c) => Number(c.dataset.apDay));
    try {
      const v = await api('PUT', '/api/autopilot', { workHours: { days, start: $('#ap-start', main).value, end: $('#ap-end', main).value, timeZone: $('#ap-tz', main).value.trim() } });
      toast(`Work hours saved: ${v.workHoursText}.`);
    } catch (err) {
      toast(err.message);
    }
    redraw();
  });
  // Keep the card current while a cycle runs.
  if (ap.running) setTimeout(redraw, 5000);
}

// Jobs are shown in Paycor's own order — most urgent first, the same as on Paycor's home page.
function sortJobs(jobs, scope = 'all') {
  const key = (j) => (scope === 'mine' && j.myRank != null ? j.myRank : j.rank ?? 0);
  return [...jobs].sort((a, b) => key(a) - key(b));
}

// "My Jobs" / "All Jobs", like Paycor's filter. Remembered on this computer; My Jobs by default, as in Paycor.
const JOB_SCOPE_KEY = 'apw.jobScope';
function jobScope(data) {
  if (!data.hasMyJobs) return 'all';
  try {
    return localStorage.getItem(JOB_SCOPE_KEY) === 'all' ? 'all' : 'mine';
  } catch {
    return 'mine';
  }
}
function setJobScope(scope) {
  try {
    localStorage.setItem(JOB_SCOPE_KEY, scope);
  } catch {
    // not remembered — fine
  }
}
function jobsInScope(data, scope = jobScope(data)) {
  return sortJobs(scope === 'mine' ? data.jobs.filter((j) => j.mine) : data.jobs, scope);
}
function jobScopeTabsHtml(data, scope) {
  if (!data.hasMyJobs) return '';
  const mine = data.jobs.filter((j) => j.mine).length;
  return `<div class="tabs" role="tablist" aria-label="Which jobs">
    <button type="button" role="tab" data-scope="mine" aria-selected="${scope === 'mine'}" class="${scope === 'mine' ? 'active' : ''}">My Jobs (${esc(mine)})</button>
    <button type="button" role="tab" data-scope="all" aria-selected="${scope === 'all'}" class="${scope === 'all' ? 'active' : ''}">All Jobs (${esc(data.jobs.length)})</button>
  </div>`;
}

// "New applicants only": works with either tab. Remembered on this computer.
const JOB_NEW_ONLY_KEY = 'apw.jobsNewOnly';
function jobsNewOnly() {
  try {
    return localStorage.getItem(JOB_NEW_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}
function setJobsNewOnly(on) {
  try {
    localStorage.setItem(JOB_NEW_ONLY_KEY, on ? '1' : '0');
  } catch {
    // not remembered — fine
  }
}

function priorityPillHtml(j) {
  if (!j.priorityLabel) return '';
  return `<span class="pill${/urgent/i.test(j.priorityLabel) ? ' warn' : ''}" title="Paycor priority — Urgent first, then Priority 2, 3 and 4 (lowest)">${esc(j.priorityLabel)}</span>`;
}

function jobMetaHtml(j) {
  return [`Job ID ${esc(j.jobId)}`, j.location ? esc(j.location) : null].filter(Boolean).join(' · ');
}

const usingRules = () => !(store.health && store.health.screeningEngine === 'claude');
const hasScreeningCriteria = (j) => (usingRules() ? j.hasRules : j.hasDescription || j.hasPaycorDescription);

function jobActionHtml(j) {
  if (j.jobSeekerCount == null) return `<a class="btn small" href="#/screen?job=${encodeURIComponent(j.jobId)}">Screen</a>`;
  if (!j.jobSeekerCount) return '<span class="muted small">No new applicants</span>';
  return `<a class="btn small${j.pipelineKey && hasScreeningCriteria(j) ? ' primary-link' : ''}" href="#/screen?job=${encodeURIComponent(j.jobId)}">Screen ${esc(j.jobSeekerCount)} new</a>`;
}

function jobReadinessHtml(j) {
  const parts = [];
  parts.push(j.pipelineKey ? `<span class="pill good">Pipeline: ${esc(j.pipelineKey)}</span>` : `<a class="pill warn" href="#/settings?newJob=${encodeURIComponent(j.jobId)}&title=${encodeURIComponent(j.title)}">No pipeline — set up</a>`);
  if (!hasScreeningCriteria(j)) parts.push(`<a class="pill" href="#/screen?job=${encodeURIComponent(j.jobId)}">${usingRules() ? 'No screening rules yet' : 'No job description yet'}</a>`);
  return parts.join(' ');
}

async function renderJobs(main) {
  const [data] = await Promise.all([api('GET', '/api/paycor/jobs'), refreshLatestJobs()]);
  const scope = jobScope(data);
  const inScope = jobsInScope(data, scope);
  const withNew = inScope.filter((j) => j.jobSeekerCount > 0).length;
  const newOnly = jobsNewOnly();
  const jobs = newOnly ? inScope.filter((j) => j.jobSeekerCount > 0) : inScope;
  const countsKnown = inScope.some((j) => j.jobSeekerCount != null);
  const auto = data.autoRefresh || {};
  const scopeName = data.hasMyJobs ? (scope === 'mine' ? 'My Jobs' : 'All Jobs') : data.scope || 'My Jobs';
  const sub = data.syncedAt
    ? `${inScope.length} active job${inScope.length === 1 ? '' : 's'} ("${scopeName}") in Paycor's order, most urgent first${countsKnown ? ` — ${withNew} with new applicants` : ''}. Updated ${timeAgo(data.syncedAt)}${auto.refreshing ? ' — updating now…' : `, and automatically every ${auto.everyMinutes || 15} minutes while this dashboard is open`}.`
    : 'Your active jobs from Paycor will appear here.';

  main.innerHTML = `
    ${pageHead('Jobs', sub)}
    <div class="inline" style="gap:12px;margin-bottom:14px">
      ${jobScopeTabsHtml(data, scope)}
      <div class="tabs"><button type="button" id="new-only" aria-pressed="${newOnly}" class="${newOnly ? 'active' : ''}">${newOnly ? '✓ ' : ''}New applicants only (${esc(withNew)})</button></div>
    </div>
    <div class="inline" style="margin-bottom:14px">
      <button id="sync-btn" data-needs-idle>${icon('refresh')}Refresh from Paycor</button>
      ${jobs.length ? '<input type="search" id="job-search" placeholder="Search jobs" style="max-width:280px" />' : ''}
    </div>
    <div class="run" data-run-kind="sync" style="margin-top:0;margin-bottom:14px"></div>
    ${data.scopeNote ? `<div style="margin-bottom:14px">${banner('warn', 'Only some jobs could be loaded', esc(data.scopeNote))}</div>` : ''}
    ${auto.lastError ? `<div style="margin-bottom:14px">${banner('warn', "The automatic update didn't work", esc(auto.lastError))}</div>` : ''}
    ${data.totalReported && data.totalReported > data.jobs.length ? banner('warn', `Paycor shows ${data.totalReported} jobs, but only ${data.jobs.length} could be read`, 'Try "Refresh from Paycor" again. If it keeps happening, the job list on Paycor may have changed layout.') : ''}
    ${
      jobs.length
        ? `<div class="card"><div class="table-wrap" style="margin-top:0"><table>
            <thead><tr><th>Job</th><th>New applicants</th><th>Other stages</th><th>Ready to screen?</th><th></th></tr></thead>
            <tbody id="job-rows"></tbody></table></div><div id="job-empty" class="empty" hidden>No jobs match.</div></div>`
        : `<div class="card empty">${icon('briefcase')}<div>${!data.syncedAt ? 'No jobs loaded yet. Click "Refresh from Paycor".' : newOnly && inScope.length ? 'No jobs with new applicants here right now. Turn off "New applicants only" to see every job.' : scope === 'mine' && data.jobs.length ? 'No jobs are assigned to you in Paycor. Switch to All Jobs to see the rest.' : 'No active jobs were found in Paycor.'}</div></div>`
    }
  `;
  updateRunPanels();
  $('#sync-btn').addEventListener('click', () => startJob('/api/paycor/sync', {}, 'sync'));
  $('#new-only').addEventListener('click', () => {
    setJobsNewOnly(!newOnly);
    renderJobs(main);
  });
  main.querySelectorAll('.tabs [data-scope]').forEach((b) =>
    b.addEventListener('click', () => {
      setJobScope(b.dataset.scope);
      renderJobs(main);
    }),
  );

  if (!jobs.length) return;
  const draw = () => {
    const q = ($('#job-search').value || '').trim().toLowerCase();
    const rows = jobs.filter((j) => !q || `${j.title} ${j.jobId} ${j.location || ''}`.toLowerCase().includes(q));
    $('#job-rows').innerHTML = rows
      .map((j) => {
        const others = (j.stageCounts || []).filter((s) => !/job seeker/i.test(s.label) && s.count > 0).map((s) => `${esc(s.label)} ${esc(s.count)}`).join(' · ');
        return `<tr>
          <td><strong>${esc(j.title)}</strong> ${priorityPillHtml(j)}<div class="small muted">${jobMetaHtml(j)}</div></td>
          <td class="num">${j.jobSeekerCount == null ? '<span class="muted" title="Not included in Paycor\'s job data">—</span>' : `<span class="tile-value" style="font-size:18px">${esc(j.jobSeekerCount)}</span>`}</td>
          <td class="small">${others || '<span class="muted">—</span>'}</td>
          <td>${jobReadinessHtml(j)}</td>
          <td style="text-align:right">${jobActionHtml(j)}</td>
        </tr>`;
      })
      .join('');
    $('#job-empty').hidden = rows.length > 0;
  };
  $('#job-search').addEventListener('input', draw);
  draw();
}

function rulesToForm(r) {
  return {
    required: (r.requiredSkills || []).map((s) => (s.alternatives || [s.name]).join(' | ')).join('\n'),
    preferred: (r.preferredSkills || []).join('\n'),
    years: r.minimumYears ?? '',
    allowed: (r.allowedLocations || []).join(', '),
    blocked: (r.blockedLocations || []).join(', '),
    hopOn: !!(r.jobHopping && r.jobHopping.maxShortJobs > 0),
    hopCount: (r.jobHopping && r.jobHopping.maxShortJobs) || 3,
    hopMonths: (r.jobHopping && r.jobHopping.shortJobMonths) || 12,
    hopYears: (r.jobHopping && r.jobHopping.lookbackYears) || 5,
  };
}

function rulesFieldsHtml() {
  return `
    <div class="field-row">
      <label class="field">Required skills or qualifications
        <textarea id="r-required" rows="4" placeholder="One per line. Put alternatives on the same line with |, e.g.&#10;CDL | commercial driver's license&#10;clean driving record | clean MVR"></textarea>
        <span class="hint">Has none of them → passed. Has only some → comes to you.</span>
      </label>
      <label class="field">Nice to have
        <textarea id="r-preferred" rows="4" placeholder="One per line; alternatives with |, e.g.&#10;forklift&#10;bilingual | Spanish"></textarea>
        <span class="hint">Shown to you; never decides on its own.</span>
      </label>
    </div>
    <div class="field-row" style="margin-top:12px">
      <label class="field">Minimum years of experience
        <input type="number" id="r-years" min="0" max="50" placeholder="e.g. 3 (empty = no minimum)" />
      </label>
      <label class="field">Must be located in
        <input type="text" id="r-allowed" placeholder="e.g. PA, Pennsylvania, Lancaster (empty = anywhere)" />
      </label>
      <label class="field">Pass on candidates located in
        <input type="text" id="r-blocked" placeholder="e.g. Toronto, Vancouver" />
      </label>
    </div>
    <div class="inline" style="margin-top:12px">
      <label class="checkbox"><input type="checkbox" id="r-hop" /> Pass on job hoppers:</label>
      <input type="number" id="r-hop-count" min="1" max="20" style="width:70px" /> <span>or more jobs shorter than</span>
      <input type="number" id="r-hop-months" min="1" max="60" style="width:70px" /> <span>months in the last</span>
      <input type="number" id="r-hop-years" min="1" max="30" style="width:70px" /> <span>years</span>
    </div>`;
}

function readRulesForm() {
  const lines = (id) => $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
  const list = (id) => $(id).value.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    requiredSkills: lines('#r-required'),
    preferredSkills: lines('#r-preferred'),
    minimumYears: $('#r-years').value === '' ? null : Number($('#r-years').value),
    allowedLocations: list('#r-allowed'),
    blockedLocations: list('#r-blocked'),
    jobHopping: {
      maxShortJobs: $('#r-hop').checked ? Number($('#r-hop-count').value || 3) : 0,
      shortJobMonths: Number($('#r-hop-months').value || 12),
      lookbackYears: Number($('#r-hop-years').value || 5),
    },
  };
}

function fillRulesForm(rules) {
  const f = rulesToForm(rules);
  $('#r-required').value = f.required;
  $('#r-preferred').value = f.preferred;
  $('#r-years').value = f.years;
  $('#r-allowed').value = f.allowed;
  $('#r-blocked').value = f.blocked;
  $('#r-hop').checked = f.hopOn;
  $('#r-hop-count').value = f.hopCount;
  $('#r-hop-months').value = f.hopMonths;
  $('#r-hop-years').value = f.hopYears;
}

async function renderScreen(main) {
  const [cfg, jobData] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/paycor/jobs'), refreshLatestJobs()]);
  if (!cfg.configured) {
    main.innerHTML = pageHead('Screen applicants') + setupNeededBanner();
    return;
  }
  const useRules = (cfg.screeningEngine || 'rules') !== 'claude';
  const options = cfg.pipelines.map((p) => `<option value="${esc(p.key)}">${esc(p.key)}${p.company ? ` — ${esc(p.company)}` : ''}</option>`).join('');
  // Same order as Paycor; the person's own jobs first when "My Jobs" is known.
  const jobOption = (j) => `<option value="${esc(j.jobId)}">${esc(j.title)}${j.priorityLabel && /urgent/i.test(j.priorityLabel) ? ' (Urgent)' : ''}${j.jobSeekerCount ? ` — ${esc(j.jobSeekerCount)} new` : ''}</option>`;
  const jobOptions = (jobData.hasMyJobs ? [...sortJobs(jobData.jobs.filter((j) => j.mine), 'mine'), ...sortJobs(jobData.jobs.filter((j) => !j.mine))] : sortJobs(jobData.jobs)).map(jobOption).join('');
  const jobsById = Object.fromEntries(jobData.jobs.map((j) => [String(j.jobId), j]));

  const descriptionField = `<label class="field">Job description
      <textarea id="criteria" rows="${useRules ? 5 : 8}" placeholder="Paste the job posting."></textarea>
    </label>`;
  const step2 = useRules
    ? `<div class="step-title">What must a good candidate have?</div>
       <p class="hint" style="margin-bottom:10px">These rules decide each resume — no AI is used, and resumes never leave this computer. Anything the rules can't settle comes to you in Needs attention.</p>
       ${rulesFieldsHtml()}
       <details class="tech" style="margin-top:14px"><summary>Job description (optional — for your reference)</summary>${descriptionField}</details>`
    : `<div class="step-title">What does the job need?</div>
       <p class="hint" style="margin-bottom:10px">Claude AI reads each resume against this description. Add lists headed REQUIRED, PREFERRED and DISQUALIFIERS to sharpen the decisions.</p>
       ${descriptionField}`;

  main.innerHTML = `
    ${pageHead('Screen applicants', useRules ? "Reads every new applicant's resume for one job and checks it against the rules you set, then advances clear fits and passes clear mismatches. Anything in between comes to you." : "Claude AI reads every new applicant's resume for one job and compares it with the job description. Anything it isn't sure about comes to you.")}
    <div class="card">
      <div class="step"><div class="step-num">1</div><div>
        <div class="step-title">Which job?</div>
        <label class="field">Paycor Job ID
          <input type="text" id="job-id" placeholder="e.g. 146" autocomplete="off" inputmode="numeric" list="job-options" />
          <datalist id="job-options">${jobOptions}</datalist>
        </label>
        <p class="hint" id="job-hint">The number on the Paycor job card ("Job ID: 146"), or pick from the list of your jobs.</p>
      </div></div>
      <div class="step"><div class="step-num">2</div><div>
        ${step2}
        <div class="inline" style="margin-top:12px"><button class="small" id="save-criteria">${useRules ? 'Save rules' : 'Save description'}</button><span class="hint" id="criteria-status"></span></div>
        <ul class="problems" id="rule-problems" hidden></ul>
      </div></div>
      <div class="step"><div class="step-num">3</div><div>
        <div class="step-title">Where should good fits go?</div>
        <label class="field">Add accepted candidates to this outreach pipeline
          <select id="pipeline"><option value="">Choose a pipeline…</option>${options}</select>
        </label>
        <p class="hint">They'll get the first contact email on the next daily outreach run.</p>
      </div></div>
      <div class="button-row">
        <button id="test-run" data-needs-idle>Test run</button>
        <button id="real-run" class="primary" data-needs-idle>Screen for real</button>
      </div>
      <p class="hint">${
        useRules
          ? 'A test run reads the resumes and shows what each rule decided, without changing anything in Paycor. Free — no AI involved.'
          : 'A test run reads the resumes and shows what it would decide, without changing anything in Paycor. Both use the Claude API — about 1.5¢ per resume.'
      }</p>
    </div>
    <div class="run" data-run-kind="screen"></div>
  `;
  updateRunPanels();

  const jobInput = $('#job-id');
  const criteria = $('#criteria');
  const status = $('#criteria-status');
  const problemsEl = $('#rule-problems');
  let dirty = false;
  let loadTimer = null;

  if (useRules) fillRulesForm({ jobHopping: { maxShortJobs: 0, shortJobMonths: 12, lookbackYears: 5 } });
  $$('#r-required, #r-preferred, #r-years, #r-allowed, #r-blocked, #r-hop, #r-hop-count, #r-hop-months, #r-hop-years, #criteria').forEach((el) =>
    el.addEventListener('input', () => {
      dirty = true;
      status.textContent = 'Not saved yet';
    }),
  );

  jobInput.addEventListener('input', () => {
    clearTimeout(loadTimer);
    const id = jobInput.value.trim();
    const known = jobsById[id];
    $('#job-hint').textContent = known
      ? `${known.title} — ${known.jobSeekerCount ?? '?'} new applicant${known.jobSeekerCount === 1 ? '' : 's'} in Paycor.`
      : 'The number on the Paycor job card ("Job ID: 146"), or pick from the list of your jobs.';
    const matchingPipeline = cfg.pipelines.find((p) => String(p.jobId) === id);
    if (matchingPipeline && !$('#pipeline').value) $('#pipeline').value = matchingPipeline.key;
    if (!/^\d+$/.test(id)) {
      status.textContent = id ? 'Use the numeric Job ID to save or load rules.' : '';
      return;
    }
    loadTimer = setTimeout(async () => {
      const [desc, rules, fromPaycor] = await Promise.all([
        api('GET', `/api/screening-criteria/${id}`),
        useRules ? api('GET', `/api/screening-rules/${id}`) : null,
        api('GET', `/api/paycor/job-descriptions/${id}`).catch(() => ({ exists: false })),
      ]);
      if (dirty) return; // never overwrite what someone is typing
      // A description saved here wins; otherwise the one copied from Paycor.
      criteria.value = desc.exists ? desc.text : fromPaycor.exists ? fromPaycor.text : '';
      const descNote = desc.exists ? '' : fromPaycor.exists ? ' Job description copied from Paycor.' : '';
      if (useRules) {
        fillRulesForm(rules.rules);
        status.textContent = (rules.exists ? `Loaded the saved rules for Job ID ${id}.` : `No rules saved for Job ID ${id} yet — fill them in and save.`) + descNote;
      } else {
        status.textContent = desc.exists ? `Loaded the saved description for Job ID ${id}.` : fromPaycor.exists ? `Job description copied from Paycor for Job ID ${id}.` : `No saved description for Job ID ${id} yet.`;
      }
    }, 350);
  });

  async function saveCriteria() {
    const id = jobInput.value.trim();
    if (!/^\d+$/.test(id)) throw new Error('Enter the numeric Job ID first.');
    problemsEl.hidden = true;
    if (useRules) {
      try {
        await api('PUT', `/api/screening-rules/${id}`, readRulesForm());
      } catch (err) {
        const list = (err.data && err.data.problems) || [err.message];
        problemsEl.innerHTML = list.map((p) => `<li>${esc(p)}</li>`).join('');
        problemsEl.hidden = false;
        throw new Error('The rules need a fix before they can be saved.');
      }
      if (criteria.value.trim()) await api('POST', '/api/screening-criteria', { jobId: id, text: criteria.value });
    } else {
      if (!criteria.value.trim()) throw new Error('Paste the job description first.');
      await api('POST', '/api/screening-criteria', { jobId: id, text: criteria.value });
    }
    dirty = false;
    status.textContent = 'Saved.';
  }

  $('#save-criteria').addEventListener('click', async () => {
    try {
      await saveCriteria();
      toast(useRules ? 'Screening rules saved.' : 'Job description saved.');
    } catch (err) {
      toast(err.message);
    }
  });

  async function run(dryRun) {
    const job = jobInput.value.trim();
    const pipeline = $('#pipeline').value;
    if (!job) return toast('Enter the Job ID first.');
    try {
      await saveCriteria();
    } catch (err) {
      return toast(err.message);
    }
    if (!dryRun) {
      if (!pipeline) return toast('Choose where accepted candidates should go (step 3).');
      if (!confirm(`Screen Job ID ${job} for real?\n\nThis will advance or pass real candidates in Paycor. Anything uncertain goes to Needs attention instead.`)) return;
    }
    startJob('/api/screen-job', { job, pipeline: pipeline || undefined, dryRun }, 'screen');
  }
  $('#test-run').addEventListener('click', () => run(true));
  $('#real-run').addEventListener('click', () => run(false));

  const preselected = hashQuery().job;
  if (preselected && /^\d+$/.test(preselected)) {
    jobInput.value = preselected;
    jobInput.dispatchEvent(new Event('input'));
  }
}

// The pipeline chosen on the Daily outreach page. Remembered on this computer; "" = all pipelines.
const OUTREACH_PIPELINE_KEY = 'apw.outreachPipeline';
function savedOutreachPipeline() {
  try {
    return localStorage.getItem(OUTREACH_PIPELINE_KEY) || '';
  } catch {
    return '';
  }
}
function pipelineLabel(key, pipelines) {
  const p = pipelines && pipelines[key];
  return p ? `${p.title || 'Job'} — Job ID ${p.jobId}` : key;
}

async function renderOutreach(main) {
  const [cfg, jobData] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/paycor/jobs').catch(() => ({ jobs: [] })), refreshLatestJobs(), loadCandidates()]);
  if (!cfg.configured) {
    main.innerHTML = pageHead('Daily outreach') + setupNeededBanner();
    return;
  }
  const titles = new Map((jobData.jobs || []).map((j) => [String(j.jobId), j.title]));
  const pipelineChoices = cfg.pipelines
    .map((p) => ({ key: p.key, label: `${titles.get(String(p.jobId)) || p.key} — Job ID ${p.jobId}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
  let chosen = savedOutreachPipeline();
  if (chosen && !pipelineChoices.some((p) => p.key === chosen)) chosen = '';
  main.innerHTML = `
    ${pageHead('Daily outreach', 'Run this once a day. It works through everyone in your pipelines, one candidate at a time.')}
    <div class="card">
      <h2>What a run does</h2>
      <ul class="result-list">
        <li>Finds the candidates itself: everyone in your pipelines' jobs whose Paycor status is one of the recruiting steps — "Resume Quick Screen" gets the first contact email; the others continue from their step, timed from Paycor's "Last Updated" date.</li>
        <li>Checks each candidate's Paycor profile for a reply, then sends the right next email.</li>
        <li>Sends a reminder to anyone who hasn't replied after 3 days, and passes them if they still don't reply 3 days later.</li>
        <li>Scores fluency & typing tests as they come in.</li>
        <li>Puts questions, unclear replies and anything unusual in <a href="#/attention">Needs attention</a>, untouched.</li>
      </ul>
      <label class="field" style="margin-top:14px;max-width:560px">Which pipeline?
        <select id="outreach-pipeline">
          <option value="">All pipelines (${esc(pipelineChoices.length)})</option>
          ${pipelineChoices.map((p) => `<option value="${esc(p.key)}"${p.key === chosen ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
        </select>
      </label>
      <div class="button-row">
        <button id="test-run" data-needs-idle>Test run</button>
        <button id="real-run" class="primary" data-needs-idle>Run outreach now</button>
      </div>
      <p class="hint">A test run reads Paycor and shows who would get what, without sending anything or changing any records. Every candidate in the pipeline's statuses is included, however long ago Paycor last updated them. At most ${esc((cfg.outreach && cfg.outreach.maxNewPerRun) ?? 50)} new first-contact emails go out per run — the rest are listed and contacted on the next runs (change this in <a href="#/settings">Settings → Safety limits</a>). Anyone you move to another status in Paycor is left alone from then on.</p>
    </div>
    <div class="run" data-run-kind="daily"></div>
  `;
  updateRunPanels();

  const pick = () => $('#outreach-pipeline').value;
  $('#outreach-pipeline').addEventListener('input', () => {
    try {
      localStorage.setItem(OUTREACH_PIPELINE_KEY, pick());
    } catch {
      // not remembered — fine
    }
  });
  const label = () => (pick() ? pipelineChoices.find((p) => p.key === pick()).label : 'all pipelines');
  $('#test-run').addEventListener('click', () => startJob('/api/run-daily', { dryRun: true, pipeline: pick() }, 'daily'));
  $('#real-run').addEventListener('click', () => {
    if (confirm(`Run the outreach for real — ${label()}?\n\nThis sends emails and changes candidate statuses in Paycor.`)) startJob('/api/run-daily', { dryRun: false, pipeline: pick() }, 'daily');
  });
}

function describeItem(e) {
  if (e.kind === 'screening') {
    const suggestion = e.suggestedVerdict === 'REJECT' && e.suggestedReason ? `Suggested: pass — ${e.suggestedReason}` : e.suggestedVerdict === 'ACCEPT' ? 'Suggested: advance' : 'No clear suggestion';
    const details = String(e.reason || '').replace(/^Screening verdict needs review \([^)]*\):\s*/, '').split(' · ').join('\n');
    return { type: 'Screening decision', tone: 'accent', body: `${suggestion}.\n${details}` };
  }
  if (/^reply: query/.test(e.reason || '')) {
    return { type: 'Candidate replied with a question', tone: 'warn', body: 'Read their reply in Paycor and answer it there. Automatic emails have stopped for this candidate.' };
  }
  if (e.reason === 'backlog-cap') return { type: 'Safety pause', tone: 'warn', body: `${e.detail || ''}\nIf this is expected, pass them in Paycor yourself.` };
  if (/Enter this scorecard by hand/.test(e.reason || '')) return { type: 'Fluency score to enter', tone: 'accent', body: e.reason };
  return { type: 'Needs a look', tone: 'warn', body: [e.reason, e.detail].filter(Boolean).join(' — ') };
}

async function renderAttention(main) {
  const [review, cfg] = await Promise.all([api('GET', '/api/manual-review'), api('GET', '/api/config'), refreshLatestJobs(), loadCandidates()]);
  const reasons = cfg.screeningPassReasons || [];
  const tab = store.attentionTab;
  const list = tab === 'open' ? review.open : review.resolved;

  const items = list
    .map((e, i) => {
      const d = describeItem(e);
      const actions =
        tab !== 'open'
          ? `<span class="hint">Closed ${esc(timeAgo(e.resolvedAt))}${e.resolutionNote ? ` — ${esc(e.resolutionNote)}` : ''}</span>`
          : e.kind === 'screening'
            ? `<button class="primary small" data-act="accept" data-i="${i}" data-needs-idle>Advance</button>
               <select data-reason="${i}" aria-label="Pass reason">${reasons.map((r) => `<option value="${esc(r)}"${r === e.suggestedReason ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>
               <button class="small" data-act="pass" data-i="${i}" data-needs-idle>Pass</button>
               <span class="spacer"></span>
               <button class="ghost small" data-act="resolve" data-i="${i}">I handled it myself</button>`
            : `<button class="small" data-act="resolve" data-i="${i}">Mark as handled</button>`;
      return `<div class="item">
        <div class="item-head"><strong>${esc(e.name || e.candidateId)}</strong><span class="pill ${d.tone}">${esc(d.type)}</span><span class="spacer"></span><span class="small">${paycorLink(e.candidateId)}</span></div>
        <div class="item-body">${esc(d.body)}</div>
        <div class="item-actions">${actions}<span class="spacer"></span><span class="hint">Added ${esc(timeAgo(e.addedAt))}</span></div>
      </div>`;
    })
    .join('');

  main.innerHTML = `
    ${pageHead('Needs attention', 'Everything the assistant left for a person. "Advance" and "Pass" act in Paycor for you, after re-checking the candidate. "Mark as handled" just closes the item.')}
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="open" class="${tab === 'open' ? 'active' : ''}" aria-selected="${tab === 'open'}">Open (${review.open.length})</button>
      <button role="tab" data-tab="resolved" class="${tab === 'resolved' ? 'active' : ''}" aria-selected="${tab === 'resolved'}">Recently closed</button>
    </div>
    <div class="run" data-run-kind="act" style="margin-top:0;margin-bottom:14px"></div>
    ${items || `<div class="card empty">${icon('checkCircle')}<div>${tab === 'open' ? "Nothing needs you right now." : 'Nothing closed yet.'}</div></div>`}
  `;
  updateRunPanels();

  $$('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      store.attentionTab = b.dataset.tab;
      render();
    }),
  );
  $$('[data-act]').forEach((b) =>
    b.addEventListener('click', async () => {
      const e = list[Number(b.dataset.i)];
      const who = e.name || e.candidateId;
      if (b.dataset.act === 'resolve') {
        await api('POST', '/api/manual-review/resolve', { candidateId: e.candidateId, addedAt: e.addedAt, note: 'Handled manually' });
        toast('Closed.');
        await refreshHealth();
        render();
      } else if (b.dataset.act === 'accept') {
        if (confirm(`Advance ${who} to Resume Quick Screen in Paycor?`)) startJob('/api/manual-review/act', { candidateId: e.candidateId, addedAt: e.addedAt, action: 'accept' }, 'act');
      } else {
        const reason = $(`[data-reason="${b.dataset.i}"]`).value;
        if (confirm(`Pass on ${who} in Paycor?\n\nReason: ${reason}`)) startJob('/api/manual-review/act', { candidateId: e.candidateId, addedAt: e.addedAt, action: 'pass', reason }, 'act');
      }
    }),
  );
}

async function renderCandidates(main) {
  const [state, cfg] = await Promise.all([loadCandidates(), api('GET', '/api/config')]);
  const q = hashQuery();
  const pipelines = cfg.configured ? cfg.pipelines : [];

  main.innerHTML = `
    ${pageHead('Candidates', `Everyone the assistant is tracking (${state.total}).`)}
    <div class="card">
      <div class="field-row">
        <label class="field">Search<input type="search" id="f-search" placeholder="Name or candidate ID" /></label>
        <label class="field">Stage<select id="f-stage"><option value="">All stages</option>${STAGE_GROUPS.map((g) => `<option value="${g.key}"${q.stage === g.key ? ' selected' : ''}>${esc(g.label)}</option>`).join('')}</select></label>
        <label class="field">Pipeline<select id="f-pipeline"><option value="">All pipelines</option>${pipelines.map((p) => `<option value="${esc(p.key)}">${esc(p.key)}</option>`).join('')}</select></label>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Stage</th><th>Pipeline</th><th>Fluency score</th><th>Last update</th></tr></thead><tbody id="cand-rows"></tbody></table></div>
      <div id="cand-empty" class="empty" hidden>No candidates match.</div>
    </div>
  `;

  const draw = () => {
    const search = $('#f-search').value.trim().toLowerCase();
    const stage = STAGE_GROUPS.find((g) => g.key === $('#f-stage').value);
    const pipeline = $('#f-pipeline').value;
    const rows = state.candidates
      .filter((c) => (!stage || stage.tracks.includes(c.track)) && (!pipeline || c.pipelineKey === pipeline) && (!search || `${c.name} ${c.id}`.toLowerCase().includes(search)))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    $('#cand-rows').innerHTML = rows
      .map(
        (c) => `<tr>
          <td>${esc(c.name && c.name !== '(unknown name)' ? c.name : 'Unnamed')}<div class="small">${paycorLink(c.id, c.id)}</div></td>
          <td><span class="pill ${TRACK_TONE[c.track] ?? 'accent'}">${esc(TRACK_LABELS[c.track] || c.track)}</span>${c.passReason ? `<div class="small muted">${esc(c.passReason === 'noResponse' ? 'Never replied' : 'Other candidates better qualified')}</div>` : ''}${c.error ? `<div class="small status bad">Last attempt failed — will retry</div>` : ''}</td>
          <td>${esc(c.pipelineKey)}</td>
          <td class="num">${esc(c.fluencyScore ?? '—')}</td>
          <td>${esc(timeAgo(c.updatedAt))}</td>
        </tr>`,
      )
      .join('');
    $('#cand-empty').hidden = rows.length > 0;
  };
  ['#f-search', '#f-stage', '#f-pipeline'].forEach((sel) => $(sel).addEventListener('input', draw));
  draw();
}

// --- Settings ---------------------------------------------------------------------------------

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null) o[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

function textField(label, path, value, hint = '', type = 'text') {
  return `<label class="field">${esc(label)}<input type="${type}" data-path="${esc(path)}" value="${esc(value ?? '')}" />${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
}

// --- Settings: Paycor's email templates + the team's shared recruiting steps -------------------
// The steps (which template each step sends, the status after it, Pass reasons) are the same for
// everyone, so they're edited once in the "Recruiting steps" card and saved to team-process.json in
// the app folder. A pipeline only overrides a step when a job really needs something different.

/** Paycor's templates by exact name — the send step picks a template by name, so same-name templates collapse. */
function templateChoices(list) {
  const byName = new Map();
  for (const t of list || []) {
    if (!t || typeof t.name !== 'string') continue;
    const c = byName.get(t.name) || { name: t.name, count: 0, sharedWithTeam: false, usable: t.usable !== false };
    c.count += 1;
    c.sharedWithTeam = c.sharedWithTeam || !!t.sharedWithTeam;
    byName.set(t.name, c);
  }
  return byName;
}

function templateOptionHtml(c, value) {
  const notes = [];
  if (!c.usable) notes.push("can't be used — the name has quotes");
  if (c.count > 1) notes.push(`${c.count} templates in Paycor have this name`);
  return `<option value="${esc(c.name)}"${c.name === value ? ' selected' : ''}${c.usable ? '' : ' disabled'}>${esc(c.name)}${notes.length ? ` (${esc(notes.join('; '))})` : ''}</option>`;
}

/** The warning under a template dropdown for the chosen name (empty when all is well). */
function templateFlagHtml(value, choices, forTeam) {
  if (!value || !choices.size) return '';
  const known = choices.get(value);
  if (!known) return '<span class="pill warn">Not found in Paycor</span> <span class="small muted">Pick the right one from the list — this name would not be found when sending.</span>';
  if (forTeam && !known.sharedWithTeam) return '<span class="pill warn">Only in your Paycor account</span> <span class="small muted">Colleagues won\'t have it unless you share it in Paycor.</span>';
  return '';
}

/**
 * A dropdown of Paycor's email templates. `attr` is the data attribute the change handler reads
 * (data-path for a pipeline, data-team-path for the team steps). A saved name that isn't in Paycor's
 * list stays selected, flagged "not found in Paycor". Without a list yet, it's a text box as before.
 */
function templateSelectHtml({ label, hint = '', attr, path, value, choices, emptyLabel, forTeam = false }) {
  const current = value ?? '';
  const hintHtml = hint ? `<span class="hint">${esc(hint)}</span>` : '';
  if (!choices.size) {
    return `<label class="field">${esc(label)}<input type="text" ${attr}="${esc(path)}" value="${esc(current)}" placeholder="${esc(forTeam ? 'Exact name from Paycor' : 'Empty = same as the team step')}" />${hintHtml}</label>`;
  }
  const all = [...choices.values()];
  const team = all.filter((c) => c.sharedWithTeam);
  const own = all.filter((c) => !c.sharedWithTeam);
  return `<label class="field">${esc(label)}
    <select ${attr}="${esc(path)}" data-template-select${forTeam ? ' data-for-team' : ''}>
      <option value=""${current ? '' : ' selected'}>${esc(emptyLabel)}</option>
      ${current && !choices.has(current) ? `<option value="${esc(current)}" selected>${esc(current)} — not found in Paycor</option>` : ''}
      ${team.length ? `<optgroup label="Shared with the team in Paycor">${team.map((c) => templateOptionHtml(c, current)).join('')}</optgroup>` : ''}
      ${own.length ? `<optgroup label="Only in your own Paycor account">${own.map((c) => templateOptionHtml(c, current)).join('')}</optgroup>` : ''}
    </select>
    <span class="hint" data-template-flag>${templateFlagHtml(current, choices, forTeam)}</span>${hintHtml}
  </label>`;
}

// --- Paycor statuses (stage → statuses), for "move the candidate to" ---------------------------

/** Every status name Paycor has, with the stages it appears in. */
function statusChoices(stages) {
  const byTitle = new Map();
  for (const st of stages || []) {
    for (const s of st.statuses || []) {
      const c = byTitle.get(s.title) || { title: s.title, stages: [] };
      c.stages.push(st.title);
      byTitle.set(s.title, c);
    }
  }
  return byTitle;
}

function statusFlagHtml(value, choices) {
  if (!value || !choices.size || choices.has(value)) return '';
  const close = [...choices.keys()].find((t) => t.toLowerCase().replace(/\s+/g, '') === String(value).toLowerCase().replace(/\s+/g, ''));
  return `<span class="pill warn">Not found in Paycor</span> <span class="small muted">${close ? `Paycor spells it "${esc(close)}" — pick it from the list.` : 'Pick the right status from the list — this name would not be found when moving the candidate.'}</span>`;
}

/**
 * A dropdown of Paycor's statuses, grouped by stage like Paycor's own status menu. A saved name
 * that isn't in Paycor stays selected, flagged. Without the stage list yet, it's a text box.
 */
function statusSelectHtml({ label, hint = '', attr, path, value, stages, choices, emptyLabel }) {
  const current = value ?? '';
  const hintHtml = hint ? `<span class="hint">${esc(hint)}</span>` : '';
  if (!choices.size) {
    return `<label class="field">${esc(label)}<input type="text" ${attr}="${esc(path)}" value="${esc(current)}" placeholder="Exactly as the status is named in Paycor" />${hintHtml}</label>`;
  }
  let selectedDone = !current;
  const opt = (title) => {
    const sel = !selectedDone && title === current;
    if (sel) selectedDone = true;
    return `<option value="${esc(title)}"${sel ? ' selected' : ''}>${esc(title)}</option>`;
  };
  return `<label class="field">${esc(label)}
    <select ${attr}="${esc(path)}" data-status-select>
      <option value=""${current ? '' : ' selected'}>${esc(emptyLabel)}</option>
      ${current && !choices.has(current) ? `<option value="${esc(current)}" selected>${esc(current)} — not found in Paycor</option>` : ''}
      ${stages.map((st) => `<optgroup label="${esc(st.title)}">${st.statuses.map((s) => opt(s.title)).join('')}</optgroup>`).join('')}
    </select>
    <span class="hint" data-status-flag>${statusFlagHtml(current, choices)}</span>${hintHtml}
  </label>`;
}

const SCREENED_DEFAULT_LABEL = 'Click Paycor\'s green "Resume Quick Screen" button (as before)';

function teamTextField(label, path, value, hint = '') {
  return `<label class="field">${esc(label)}<input type="text" data-team-path="${esc(path)}" value="${esc(value ?? '')}" />${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
}

/** A pipeline's own value for a step; empty means "use the team step", shown as the placeholder. */
function overrideTextField(label, path, value, teamValue) {
  return `<label class="field">${esc(label)}<input type="text" data-path="${esc(path)}" value="${esc(value ?? '')}" placeholder="${esc(teamValue || '')}" /><span class="hint">${esc(teamValue ? `Empty = team step: ${teamValue}` : 'Not set in the team steps yet')}</span></label>`;
}

const hasOwnSteps = (p) => ['templates', 'targetStatuses', 'passReasons'].some((k) => p[k] && Object.values(p[k]).some((v) => String(v ?? '').trim()));

function teamStepsCardHtml(meta, team, tpl) {
  const choices = meta.templateChoices;
  const steps = meta.team.steps;
  const notFound = choices.size ? steps.filter((s) => team.templates[s.templateKey] && !choices.has(team.templates[s.templateKey])).length : 0;
  const unset = steps.filter((s) => !String(team.templates[s.templateKey] || '').trim()).length;
  const statusesNotFound = meta.statusChoices.size ? Object.values(team.targetStatuses || {}).filter((v) => v && !meta.statusChoices.has(v)).length : 0;
  const status = tpl.refreshing
    ? { tone: 'warn', ic: 'refresh', text: 'Reading the template list from Paycor…' }
    : tpl.syncedAt
      ? { tone: 'good', ic: 'checkCircle', text: `${tpl.templates.length} templates from Paycor · updated ${timeAgo(tpl.syncedAt)}` }
      : { tone: 'warn', ic: 'alert', text: "Paycor's template list hasn't been read yet — type names exactly, or refresh." };
  return `<div class="card" id="team-steps">
    <h2>Which email each step sends, and the status after it</h2>
    <p class="hint">The recruiting process is the same for everyone, so these steps are shared by the whole team — they're saved in the app folder (team-process.json), not only on this computer. Every job's pipeline uses them unless that pipeline picks something different.</p>
    <div class="inline" style="margin-top:12px">
      <span class="status ${status.tone}" id="tpl-status">${icon(status.ic)}${esc(status.text)}</span>
      <button class="small" id="refresh-templates" ${tpl.refreshing ? 'disabled' : ''}>${icon('refresh')}Refresh templates &amp; statuses from Paycor</button>
    </div>
    ${tpl.lastError ? `<div style="margin-top:12px">${banner('warn', "Couldn't read the templates from Paycor", esc(tpl.lastError))}</div>` : ''}
    ${notFound ? `<div style="margin-top:12px">${banner('warn', `${notFound} step${notFound === 1 ? ' uses a template name' : 's use template names'} Paycor doesn't have`, 'Pick the right template from each list marked "Not found in Paycor", then save.')}</div>` : ''}
    ${!notFound && unset ? `<div style="margin-top:12px">${banner('warn', `${unset} step${unset === 1 ? ' has' : 's have'} no template yet`, 'Choose one for every step, then save.')}</div>` : ''}
    ${statusesNotFound ? `<div style="margin-top:12px">${banner('warn', `${statusesNotFound} status${statusesNotFound === 1 ? '' : 'es'} not found in Paycor`, 'Paycor moves a candidate only to a status with exactly the same name. Pick each one marked "Not found in Paycor" from the list, then save.')}</div>` : ''}
    <div class="stack" style="margin-top:16px">
      <div class="field-row">
        <div class="field"><strong>1. ${esc(meta.team.screeningStep.label)}</strong><span class="hint" style="display:block;margin-top:4px">${esc(meta.team.screeningStep.when)}. No email is sent at this step — what a good resume needs (years of experience, skills) is set in each job's pipeline below or on Screen applicants.</span></div>
        ${statusSelectHtml({ label: 'Then move the candidate to (Paycor status)', attr: 'data-team-path', path: `targetStatuses.${meta.team.screeningStep.statusKey}`, value: team.targetStatuses[meta.team.screeningStep.statusKey], stages: meta.stages, choices: meta.statusChoices, emptyLabel: SCREENED_DEFAULT_LABEL })}
      </div>
      ${steps
        .map(
          (step, n) => `<div class="field-row">
        ${templateSelectHtml({ label: `${n + 2}. ${step.label}`, hint: step.when, attr: 'data-team-path', path: `templates.${step.templateKey}`, value: team.templates[step.templateKey], choices, emptyLabel: 'Choose a Paycor template…', forTeam: true })}
        ${statusSelectHtml({ label: 'Then move the candidate to (Paycor status)', attr: 'data-team-path', path: `targetStatuses.${step.statusKey}`, value: team.targetStatuses[step.statusKey], stages: meta.stages, choices: meta.statusChoices, emptyLabel: step.statusFallbackKey ? `Keep the status of the email before (${team.targetStatuses[step.statusFallbackKey] || 'not chosen yet'})` : 'Choose a Paycor status…' })}
      </div>`,
        )
        .join('')}
    </div>
    <h3>Pass reasons</h3>
    <p class="hint">Exactly as they appear in Paycor's "Pass on Candidate" dialog.</p>
    <div class="field-row">${meta.team.passReasonSteps.map((s) => teamTextField(s.label, `passReasons.${s.key}`, team.passReasons[s.key] ?? meta.team.defaultPassReasons[s.key])).join('')}</div>
    ${team.updatedAt ? `<p class="hint" style="margin-top:12px">Last changed ${esc(timeAgo(team.updatedAt))}${team.updatedBy ? ` by ${esc(team.updatedBy)}` : ''}.</p>` : ''}
  </div>`;
}

function pipelineStepsHtml(p, i, meta) {
  const team = meta.team.process;
  const t = p.templates || {};
  const s = p.targetStatuses || {};
  const r = p.passReasons || {};
  const own = hasOwnSteps(p);
  return `
      <h3>Recruiting steps for this job</h3>
      <p class="hint">${own ? 'Some steps for this job are set differently from the team steps.' : 'This job uses the team steps (Recruiting steps, above).'} Only choose something here if this job needs a different email or status.</p>
      <div class="field-row">${meta.team.steps
        .map((step, n) =>
          templateSelectHtml({
            label: `${n + 1}. ${step.label}`,
            attr: 'data-path',
            path: `pipelines.${i}.templates.${step.templateKey}`,
            value: t[step.templateKey],
            choices: meta.templateChoices,
            emptyLabel: team.templates[step.templateKey] ? `Same as team step (${team.templates[step.templateKey]})` : 'Same as team step (not chosen yet)',
          }),
        )
        .join('')}</div>
      <h3>Paycor status to move the candidate to</h3>
      <div class="field-row">${meta.statusKeys
        .map((k) => {
          const teamValue = team.targetStatuses[k];
          const emptyLabel = teamValue ? `Same as team step (${teamValue})` : k === 'resumeScreened' ? `Same as team step (${SCREENED_DEFAULT_LABEL})` : 'Same as team step (not chosen yet)';
          return statusSelectHtml({ label: STATUS_LABELS[k] || k, attr: 'data-path', path: `pipelines.${i}.targetStatuses.${k}`, value: s[k], stages: meta.stages, choices: meta.statusChoices, emptyLabel });
        })
        .join('')}</div>
      <h3>Pass reasons</h3>
      <div class="field-row">${Object.keys(meta.defaultPassReasons).map((k) => overrideTextField(PASS_LABELS[k] || k, `pipelines.${i}.passReasons.${k}`, r[k], team.passReasons[k] || meta.defaultPassReasons[k])).join('')}</div>
      ${own ? `<div class="button-row"><button class="small" data-use-team="${i}">Use the team steps for every step of this job</button></div>` : ''}`;
}

/** A new pipeline starts from the example's basics; its steps come from the team steps. */
function newPipelineFrom(example) {
  const copy = JSON.parse(JSON.stringify(example));
  delete copy.templates;
  delete copy.targetStatuses;
  delete copy.passReasons;
  return copy;
}

/** Blank per-pipeline step values mean "use the team step" — leave them out of the saved file. */
function withoutBlankSteps(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  for (const p of copy.pipelines || []) {
    for (const section of ['templates', 'targetStatuses', 'passReasons']) {
      if (!p[section] || typeof p[section] !== 'object') continue;
      for (const [k, v] of Object.entries(p[section])) if (v == null || String(v).trim() === '') delete p[section][k];
      if (!Object.keys(p[section]).length) delete p[section];
    }
  }
  return copy;
}

/** Handlers for the team steps card and the template dropdowns (called from renderSettings). */
function wireTeamSteps(main, meta, tpl, openIndex) {
  const choices = meta.templateChoices;
  const openPipeline = () => {
    const i = $$('details.pipeline', main).findIndex((d) => d.open);
    return i === -1 ? openIndex : i;
  };
  const stillHere = () => currentRoute() === 'settings' && main.isConnected && $('#team-steps', main);
  const rerender = () => renderSettings(main, { keepDraft: true, openIndex: openPipeline() });

  if (store.teamDirty) $('#save-status').textContent = 'Unsaved changes';
  $$('[data-team-path]', main).forEach((input) =>
    input.addEventListener('input', () => {
      setPath(store.teamDraft, input.dataset.teamPath, input.value);
      store.teamDirty = true;
      $('#save-status').textContent = 'Unsaved changes';
    }),
  );
  $$('select[data-status-select]', main).forEach((select) =>
    select.addEventListener('input', () => {
      const flag = $('[data-status-flag]', select.parentElement);
      if (flag) flag.innerHTML = statusFlagHtml(select.value, meta.statusChoices);
    }),
  );
  $$('select[data-template-select]', main).forEach((select) =>
    select.addEventListener('input', () => {
      const flag = $('[data-template-flag]', select.parentElement);
      if (flag) flag.innerHTML = templateFlagHtml(select.value, choices, select.hasAttribute('data-for-team'));
    }),
  );
  $$('[data-use-team]', main).forEach((b) =>
    b.addEventListener('click', async () => {
      const i = Number(b.dataset.useTeam);
      const p = store.settingsDraft && store.settingsDraft.pipelines[i];
      if (!p) return;
      delete p.templates;
      delete p.targetStatuses;
      delete p.passReasons;
      await renderSettings(main, { keepDraft: true, openIndex: i });
      $('#save-status').textContent = 'Unsaved changes — save to keep them';
    }),
  );
  $('#refresh-templates', main).addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    $('#tpl-status').className = 'status warn';
    $('#tpl-status').innerHTML = `${icon('refresh')}Reading the template list from Paycor…`;
    try {
      const [view, st] = await Promise.all([api('POST', '/api/paycor/email-templates/refresh'), api('POST', '/api/paycor/stages/refresh')]);
      toast(`Read ${view.templates.length} email templates and ${st.stages.reduce((n, s) => n + s.statuses.length, 0)} statuses from Paycor.`);
    } catch (err) {
      toast(err.message);
      if (err.data && err.data.loginRequired) refreshHealth();
    }
    if (stillHere()) rerender();
  });
  // The list is being read in the background (first visit after a login): show it once it's in.
  if (tpl.refreshing) setTimeout(() => stillHere() && rerender(), 2500);
}

// Screening part of a pipeline: years of experience required (saved in the job's screening rules,
// the same number the Screen applicants page shows) and the job's description copied from Paycor.
// Filled in after the page is drawn — see fillPipelineScreening.
function pipelineScreeningHtml(p, i) {
  return `<h3>Screening</h3>
    <div data-screening-for="${i}">
      <label class="field">Years of experience required
        <input type="number" min="0" max="50" step="0.5" data-years-for="${i}" placeholder="${/^\d+$/.test(String(p.jobId || '')) ? 'e.g. 3 (empty = no minimum)' : 'Enter the Paycor Job ID first'}" ${/^\d+$/.test(String(p.jobId || '')) ? '' : 'disabled'} style="max-width:220px" />
        <span class="hint">Resumes with clearly fewer years are passed; slightly fewer come to you in Needs attention.</span>
      </label>
      <details class="tech jd-box" style="margin-top:12px">
        <summary>Job description from Paycor</summary>
        <div class="jd-body"><p class="hint">${/^\d+$/.test(String(p.jobId || '')) ? 'Loading…' : 'Enter the Paycor Job ID to see its description.'}</p></div>
      </details>
    </div>`;
}

async function fillPipelineScreening(main, draft) {
  store.yearsDraft = store.yearsDraft || {};
  await Promise.all(
    draft.pipelines.map(async (p, i) => {
      const jobId = String(p.jobId || '');
      const box = main.querySelector(`[data-screening-for="${i}"]`);
      if (!box || !/^\d+$/.test(jobId)) return;
      const [rules, jd] = await Promise.all([
        api('GET', `/api/screening-rules/${jobId}`).catch(() => null),
        api('GET', `/api/paycor/job-descriptions/${jobId}`).catch(() => ({ exists: false })),
      ]);
      const input = box.querySelector('[data-years-for]');
      const saved = rules && rules.exists ? rules.rules.minimumYears : null;
      input.value = jobId in store.yearsDraft ? store.yearsDraft[jobId] ?? '' : saved ?? '';
      input.dataset.saved = saved ?? '';
      input.addEventListener('input', () => {
        store.yearsDraft[jobId] = input.value === '' ? null : Number(input.value);
        $('#save-status').textContent = 'Unsaved changes';
      });
      const body = box.querySelector('.jd-body');
      if (!jd.exists) {
        body.innerHTML = '<p class="hint">Not copied from Paycor yet — it is copied on the next "Refresh from Paycor" (Jobs page).</p>';
        return;
      }
      body.innerHTML = `<div class="inline" style="margin-bottom:8px"><button type="button" class="small" data-copy-jd>${icon('copy')}Copy</button><span class="hint">${esc(jd.title)} · copied from Paycor ${esc(timeAgo(jd.fetchedAt))}</span></div><div class="jd-text"></div>`;
      body.querySelector('.jd-text').textContent = jd.text;
      body.querySelector('[data-copy-jd]').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(jd.text);
          toast('Job description copied.');
        } catch {
          toast('Copy didn\'t work here — select the text and press Ctrl+C.');
        }
      });
    }),
  );
}

/** Saves changed years of experience, per job. Returns the problems, if any. */
async function saveYearsDraft(draft) {
  const problems = [];
  for (const [jobId, years] of Object.entries(store.yearsDraft || {})) {
    if (!draft.pipelines.some((p) => String(p.jobId) === jobId)) continue;
    try {
      await api('PUT', `/api/screening-rules/${jobId}/minimum-years`, { minimumYears: years });
      delete store.yearsDraft[jobId];
    } catch (err) {
      problems.push(`Job ID ${jobId}: ${err.message}`);
    }
  }
  return problems;
}

function pipelineForm(p, i, meta, open) {
  return `<details class="pipeline"${open ? ' open' : ''}>
    <summary>${esc(p.key || 'New pipeline')}<span class="muted small">${p.company ? esc(p.company) : ''}${p.jobId ? ` · Job ID ${esc(p.jobId)}` : ''}</span></summary>
    <div class="pipeline-body">
      <h3>Basics</h3>
      <div class="field-row">
        ${textField('Short name', `pipelines.${i}.key`, p.key, 'Lowercase, e.g. hr-director-101')}
        ${textField('Paycor Job ID', `pipelines.${i}.jobId`, p.jobId)}
        ${textField('Company', `pipelines.${i}.company`, p.company)}
        ${textField('Hiring manager email (optional)', `pipelines.${i}.managerEmail`, p.managerEmail, 'Not needed now — scorecards are not sent automatically', 'email')}
      </div>
      ${pipelineScreeningHtml(p, i)}
      ${pipelineStepsHtml(p, i, meta)}
      <div class="button-row"><button class="danger small" data-remove="${i}">Remove this pipeline</button></div>
    </div>
  </details>`;
}

async function renderSettings(main, { keepDraft = false, openIndex = null } = {}) {
  const noTemplates = { syncedAt: null, templates: [], refreshing: false, lastError: null };
  const [meta, team, tpl, stageData] = await Promise.all([
    api('GET', '/api/settings'),
    api('GET', '/api/team-process'),
    api('GET', '/api/paycor/email-templates').catch(() => noTemplates),
    api('GET', '/api/paycor/stages').catch(() => ({ stages: [] })),
  ]);
  meta.stages = stageData.stages || [];
  meta.statusChoices = statusChoices(meta.stages);
  if (!keepDraft || !store.settingsDraft || !store.teamDraft) {
    store.teamDraft = JSON.parse(JSON.stringify(team.process));
    store.teamDirty = false;
  }
  meta.team = { ...team, process: store.teamDraft };
  meta.templateChoices = templateChoices(tpl.templates);
  if (!keepDraft || !store.settingsDraft) {
    store.settingsDraft = JSON.parse(JSON.stringify(meta.config));
    if (!store.settingsDraft.screening) store.settingsDraft.screening = { maxPassesPerRun: 25 };
    const q = hashQuery();
    const newJob = /^\d+$/.test(q.newJob || '') && !store.settingsDraft.pipelines.some((p) => String(p.jobId) === q.newJob) ? q.newJob : null;
    if (newJob) {
      // Arrived from a job's "No pipeline — set up" link: start a pipeline for it (steps come from the team steps).
      const copy = newPipelineFrom(meta.examplePipeline);
      const slug = String(q.title || 'job').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 38) || 'job';
      copy.key = `${slug}-${newJob}`;
      copy.jobId = newJob;
      store.settingsDraft.pipelines.push(copy);
      openIndex = store.settingsDraft.pipelines.length - 1;
    } else if (!store.settingsDraft.pipelines.length) {
      store.settingsDraft.pipelines.push(newPipelineFrom(meta.examplePipeline));
    }
  }
  const draft = store.settingsDraft;

  main.innerHTML = `
    ${pageHead('Settings', 'Your own settings stay on this computer. The recruiting steps are shared with the whole team.')}
    ${meta.exists ? '' : banner('warn', 'Not saved yet', 'An example pipeline is filled in below — check its details and the recruiting steps, then save.')}
    <div class="card" style="margin-top:16px">
      <h2>About you</h2>
      ${textField('Your name', 'name', draft.name)}
    </div>
    <div class="card">
      <h2>How resumes are judged</h2>
      <label class="field">Screening method
        <select data-path="screening.engine" id="engine-select" style="max-width:420px">
          <option value="rules"${(draft.screening.engine || 'rules') === 'rules' ? ' selected' : ''}>Screening rules — free, offline, resumes stay on this computer (recommended)</option>
          <option value="claude"${draft.screening.engine === 'claude' ? ' selected' : ''}>Claude AI — reads resumes like a recruiter, about 1.5¢ per resume</option>
        </select>
        <span class="hint">With rules, you set what each job requires on the Screen applicants page. With Claude AI, resume screenshots are sent to Anthropic's API.</span>
      </label>
      <div id="api-key-section" ${draft.screening.engine === 'claude' ? '' : 'hidden'} style="margin-top:14px">
        <h3>Claude API key</h3>
        <p class="hint">Stored on this computer, never shown again after saving.</p>
        <p class="status ${meta.apiKey.set ? 'good' : 'warn'}" id="key-status">${icon(meta.apiKey.set ? 'checkCircle' : 'alert')}${meta.apiKey.set ? `Key saved (${esc(meta.apiKey.hint)})` : 'No key saved yet'}</p>
        <div class="inline"><input type="password" id="api-key" placeholder="sk-ant-…" autocomplete="off" style="flex:1;min-width:240px" /><button id="save-key">${meta.apiKey.set ? 'Replace key' : 'Save key'}</button></div>
      </div>
    </div>
    <div class="card">
      <h2>Safety limits</h2>
      <label class="field">Most automatic passes in one screening run
        <input type="number" min="0" max="500" data-path="screening.maxPassesPerRun" data-number value="${esc(draft.screening.maxPassesPerRun ?? 25)}" style="max-width:140px" />
        <span class="hint">After this many, that job's screening stops for this run and continues on the next one — protects against wrong rules rejecting everyone.</span>
      </label>
      <label class="field" style="margin-top:12px">Most applicants screened per job in one run
        <input type="number" min="1" max="1000" data-path="screening.maxCandidatesPerRun" data-number value="${esc(draft.screening.maxCandidatesPerRun ?? 50)}" style="max-width:140px" />
        <span class="hint">Newest applicants first; older ones are screened on the next runs. Keeps each Autopilot cycle short when a job has a big backlog.</span>
      </label>
      <div class="field-row" style="margin-top:12px">
        <label class="field">Most new first-contact emails per run
          <input type="number" min="0" max="500" data-path="outreach.maxNewPerRun" data-number value="${esc((draft.outreach && draft.outreach.maxNewPerRun) ?? 50)}" style="max-width:140px" />
          <span class="hint">Newest first; the rest are picked up on the next runs.</span>
        </label>
      </div>
    </div>
    <div class="section-title">Recruiting steps — the same for everyone</div>
    ${teamStepsCardHtml(meta, store.teamDraft, tpl)}
    <div class="section-title">Pipelines</div>
    ${draft.pipelines.map((p, i) => pipelineForm(p, i, meta, openIndex === i || (!meta.exists && i === 0))).join('')}
    <div class="button-row"><button id="add-pipeline">+ Add another pipeline</button></div>
    <div class="save-bar">
      <button class="primary" id="save-settings">Save settings</button>
      <span class="hint" id="save-status"></span>
    </div>
    <ul class="problems" id="problems" hidden></ul>
  `;

  $$('[data-path]', main).forEach((input) =>
    input.addEventListener('input', () => {
      const value = input.hasAttribute('data-number') ? (input.value === '' ? null : Number(input.value)) : input.value;
      setPath(draft, input.dataset.path, value);
      $('#save-status').textContent = 'Unsaved changes';
    }),
  );
  wireTeamSteps(main, meta, tpl, openIndex);
  if (!keepDraft) store.yearsDraft = {};
  fillPipelineScreening(main, draft);
  $('#engine-select').addEventListener('input', (ev) => {
    $('#api-key-section').hidden = ev.target.value !== 'claude';
  });
  $$('[data-remove]', main).forEach((b) =>
    b.addEventListener('click', () => {
      const i = Number(b.dataset.remove);
      if (!confirm(`Remove the pipeline "${draft.pipelines[i].key || 'New pipeline'}"? Candidates already in it stay tracked.`)) return;
      draft.pipelines.splice(i, 1);
      renderSettings(main, { keepDraft: true });
    }),
  );
  $('#add-pipeline').addEventListener('click', () => {
    const copy = newPipelineFrom(meta.examplePipeline);
    copy.key = '';
    copy.jobId = '';
    draft.pipelines.push(copy);
    renderSettings(main, { keepDraft: true, openIndex: draft.pipelines.length - 1 });
  });
  $('#save-settings').addEventListener('click', async () => {
    const problems = $('#problems');
    try {
      // The team steps first: the pipelines are checked against them.
      if (store.teamDirty) {
        const saved = await api('PUT', '/api/team-process', store.teamDraft);
        store.teamDraft = saved.process;
        store.teamDirty = false;
      }
      await api('PUT', '/api/settings', withoutBlankSteps(draft));
      const yearsProblems = await saveYearsDraft(draft);
      if (yearsProblems.length) throw Object.assign(new Error('Years of experience not saved'), { data: { problems: yearsProblems } });
      problems.hidden = true;
      $('#save-status').textContent = 'Saved.';
      toast('Settings saved.');
      store.settingsDraft = null;
      await refreshHealth();
    } catch (err) {
      const list = (err.data && err.data.problems) || [err.message];
      problems.innerHTML = list.map((p) => `<li>${esc(p)}</li>`).join('');
      problems.hidden = false;
      $$('details.pipeline', main).forEach((d) => (d.open = true)); // the fields named in the problems may be collapsed
      $('#save-status').textContent = `Not saved — ${list.length} thing${list.length === 1 ? '' : 's'} to fix below.`;
      problems.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
  $('#save-key').addEventListener('click', async () => {
    const input = $('#api-key');
    try {
      const { hint } = await api('PUT', '/api/settings/api-key', { apiKey: input.value });
      input.value = '';
      $('#key-status').className = 'status good';
      $('#key-status').innerHTML = `${icon('checkCircle')}Key saved (${esc(hint)})`;
      toast('API key saved.');
      refreshHealth();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

const PAGES = { home: renderHome, jobs: renderJobs, screen: renderScreen, outreach: renderOutreach, attention: renderAttention, candidates: renderCandidates, settings: renderSettings };

function currentRoute() {
  const name = location.hash.replace(/^#\//, '').split('?')[0];
  return PAGES[name] ? name : 'home';
}

let lastRoute = null;
async function render() {
  const route = currentRoute();
  const main = $('#main');
  $$('nav a').forEach((a) => {
    const active = a.dataset.route === route;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (route !== lastRoute) {
    main.innerHTML = '<p class="muted">Loading…</p>';
    if (route !== 'settings') store.settingsDraft = null;
  }
  try {
    await PAGES[route](main);
  } catch (err) {
    main.innerHTML = banner('bad', "Couldn't load this page", esc(err.message) + ' — is the dashboard window still open?');
  }
  if (route !== lastRoute) {
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  lastRoute = route;
  updateRunPanels();
}

$$('.nav-icon').forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
window.addEventListener('hashchange', () => {
  if (!gate.shown) render();
});

(async function boot() {
  await refreshLatestJobs();
  await refreshHealth(); // shows the login screen if this computer isn't logged in to Paycor
  if (!gate.shown) render();
})();
setInterval(refreshHealth, 10000);
