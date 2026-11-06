// Rule-based resume screening — no AI, no API, no internet. Same answer on every computer.
//
// The rules for a job (screening-criteria/job-<id>.rules.json) are:
//   requiredSkills    [{ name, alternatives: [...] }] — each satisfied if any alternative appears
//   preferredSkills   [string]                        — reported as evidence, never decides
//   minimumYears      number | null                   — from job date ranges + "N years experience" claims
//   allowedLocations  [string]                        — if set, at least one should appear
//   blockedLocations  [string]                        — appearing (with no allowed one) means "not in our region"
//   jobHopping        { maxShortJobs, shortJobMonths, lookbackYears } (maxShortJobs 0 = off)
//   minimumWords      number                          — below this a readable resume is "Poor Resume"
//
// It only acts when the answer is clear-cut. Anything borderline comes back UNCERTAIN, which goes
// to Needs attention with the reasons spelled out — never a guess.

const { SCREENING_VERDICT } = require('../engine/constants');

const REASON = {
  SKILLS: 'Experience / Skills are not a match',
  HOPPER: 'Job hopper',
  GEO: 'Not located in our geo region (no relo)',
  POOR: 'Poor Resume',
};

const DEFAULT_RULES = Object.freeze({
  requiredSkills: [],
  preferredSkills: [],
  minimumYears: null,
  allowedLocations: [],
  blockedLocations: [],
  jobHopping: { maxShortJobs: 0, shortJobMonths: 12, lookbackYears: 5 },
  minimumWords: 60,
});

// ---------------------------------------------------------------------------------------------
// Rules file validation
// ---------------------------------------------------------------------------------------------

const cleanList = (list) => [...new Set((Array.isArray(list) ? list : []).map((s) => String(s || '').trim()).filter(Boolean))];

/** Normalizes a rules object from the form/file. Returns { rules, problems }. */
function normalizeRules(input = {}) {
  const problems = [];
  const requiredSkills = (Array.isArray(input.requiredSkills) ? input.requiredSkills : [])
    .map((s) => {
      const alternatives = cleanList(typeof s === 'string' ? s.split('|') : [s.name, ...(s.alternatives || [])]);
      return alternatives.length ? { name: alternatives[0], alternatives } : null;
    })
    .filter(Boolean);
  const hop = input.jobHopping || {};
  const num = (v, fallback) => (v === '' || v == null ? fallback : Number(v));
  const rules = {
    requiredSkills,
    preferredSkills: cleanList(input.preferredSkills),
    minimumYears: num(input.minimumYears, null),
    allowedLocations: cleanList(input.allowedLocations),
    blockedLocations: cleanList(input.blockedLocations),
    jobHopping: {
      maxShortJobs: num(hop.maxShortJobs, 0),
      shortJobMonths: num(hop.shortJobMonths, 12),
      lookbackYears: num(hop.lookbackYears, 5),
    },
    minimumWords: num(input.minimumWords, DEFAULT_RULES.minimumWords),
  };
  if (rules.minimumYears != null && !(rules.minimumYears >= 0 && rules.minimumYears <= 50)) problems.push('Minimum years must be a number from 0 to 50.');
  for (const [k, v] of Object.entries(rules.jobHopping)) if (!(Number.isInteger(v) && v >= 0 && v <= 120)) problems.push(`Job-hopping setting "${k}" must be a whole number.`);
  if (!(Number.isInteger(rules.minimumWords) && rules.minimumWords >= 0 && rules.minimumWords <= 1000)) problems.push('Minimum words must be a whole number.');
  const hasAnyRule = rules.requiredSkills.length || rules.minimumYears != null || rules.allowedLocations.length || rules.blockedLocations.length || rules.jobHopping.maxShortJobs > 0;
  if (!hasAnyRule) problems.push('Add at least one rule: a required skill, minimum years, a location, or job hopping.');
  return { rules, problems };
}

// ---------------------------------------------------------------------------------------------
// Text matching
// ---------------------------------------------------------------------------------------------

function normalizeText(text) {
  return String(text || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function termRegex(term) {
  const escaped = normalizeText(term)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '[\\s\\-/]+');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
}

const containsTerm = (normText, term) => termRegex(term).test(normText);

// ---------------------------------------------------------------------------------------------
// Dates → experience and job hopping
// ---------------------------------------------------------------------------------------------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RE = `(?:${MONTH_RE}\\.?,?\\s*(?:19|20)\\d{2}|\\d{1,2}[\\/.](?:19|20)\\d{2}|(?:19|20)\\d{2}[\\/.]\\d{1,2}(?!\\d)|(?:19|20)\\d{2})`;
const PRESENT_RE = '(?:present|current(?:ly)?|now|till date|to date|ongoing|today)';
const RANGE_RE = new RegExp(`(${DATE_RE})\\s*(?:-|to|till|until|through)\\s*(${DATE_RE}|${PRESENT_RE})`, 'gi');
const EDUCATION_RE = /universit|college|school|bachelor|master|degree|diploma|\bb\.?\s?s\.?c|\bm\.?\s?s\.?c|\bmba\b|graduat|matric|intermediate|\bgpa\b|certificat|course|training program/i;
// Resume section headings — a job's entry stops at these (see findWorkPeriods).
const SECTION_HEADING_RE = /^(?:key |core |technical |professional |work |career |personal )?(?:skills?|competencies|education|academics?|qualifications?|summary|profile|objective|about me|experience|employment(?: history)?|work history|certifications?|languages?|interests|hobbies|references|projects|achievements|awards|contact)\s*:?$/i;

function parseDate(token, now) {
  const t = token.toLowerCase().trim();
  if (new RegExp(`^${PRESENT_RE}$`, 'i').test(t)) return { y: now.getFullYear(), m: now.getMonth() + 1, present: true };
  let m = t.match(new RegExp(`^(${MONTH_RE})\\.?,?\\s*((?:19|20)\\d{2})$`, 'i'));
  if (m) return { y: Number(m[2]), m: MONTHS[m[1].slice(0, 4) === 'sept' ? 'sept' : m[1].slice(0, 3)] };
  m = t.match(/^(\d{1,2})[/.]((?:19|20)\d{2})$/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { y: Number(m[2]), m: Number(m[1]) };
  m = t.match(/^((?:19|20)\d{2})[/.](\d{1,2})$/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { y: Number(m[1]), m: Number(m[2]) };
  m = t.match(/^((?:19|20)\d{2})$/);
  if (m) return { y: Number(m[1]), m: null }; // year only
  return null;
}

/**
 * Work periods found in the text (education lines skipped).
 * @returns {Array<{start: number, end: number, months: number, present: boolean, yearOnly: boolean, line: string}>} start/end as month index (y*12+m)
 */
function findWorkPeriods(text, now = new Date()) {
  const periods = [];
  const lines = String(text || '').replace(/[–—]/g, '-').split(/\n+/);
  lines.forEach((line, i) => {
    const context = `${lines[i - 1] || ''} ${line} ${lines[i + 1] || ''}`;
    for (const match of line.matchAll(RANGE_RE)) {
      const a = parseDate(match[1], now);
      const b = parseDate(match[2], now);
      if (!a || !b) continue;
      const yearOnly = a.m == null || b.m == null;
      const start = a.y * 12 + (a.m == null ? 1 : a.m);
      const end = b.y * 12 + (b.m == null ? (b.present ? now.getMonth() + 1 : 12) : b.m);
      const nowIdx = now.getFullYear() * 12 + now.getMonth() + 1;
      if (end < start || end > nowIdx + 1 || a.y < 1960 || end - start > 50 * 12) continue;
      // A line that is only dates belongs to whatever heading is next to it; otherwise judge the line itself.
      const dateOnlyLine = (line.replace(RANGE_RE, '').match(/[A-Za-z]{3,}/g) || []).length < 2;
      if (EDUCATION_RE.test(line) || (dateOnlyLine && EDUCATION_RE.test(context))) continue;
      periods.push({ start, end, months: end - start + 1, present: !!b.present, yearOnly, line: line.trim().slice(0, 120), lineIndex: i });
    }
  });
  // Each job's own entry: its date line plus the lines around it, up to the neighbouring jobs —
  // used to tell whether that job was in a relevant role (see evaluateResume).
  // Resume layouts differ: some put the title and duties above the dates, some below. So the entry is
  // every line between the neighbouring jobs' dates (at most 8 each way), never crossing a section
  // heading (Skills, Education, …) — a skills list above the first job is not part of that job.
  const isHeading = (l) => SECTION_HEADING_RE.test(String(l || '').trim()) && String(l).trim().split(/\s+/).length <= 4;
  periods.forEach((p, k) => {
    const prev = periods[k - 1];
    const next = periods[k + 1];
    let from = p.lineIndex;
    const minFrom = Math.max(prev && prev.lineIndex < p.lineIndex ? prev.lineIndex + 1 : 0, p.lineIndex - 8);
    while (from > minFrom && !isHeading(lines[from - 1])) from--;
    let to = p.lineIndex;
    const maxTo = Math.min(next && next.lineIndex > p.lineIndex ? next.lineIndex - 1 : lines.length - 1, p.lineIndex + 8);
    while (to < maxTo && !isHeading(lines[to + 1])) to++;
    p.block = lines.slice(from, to + 1).join(' ');
  });
  return periods;
}

function totalMonths(periods) {
  const sorted = [...periods].sort((x, y) => x.start - y.start);
  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const p of sorted) {
    if (curEnd == null || p.start > curEnd + 1) {
      if (curEnd != null) total += curEnd - curStart + 1;
      curStart = p.start;
      curEnd = p.end;
    } else curEnd = Math.max(curEnd, p.end);
  }
  if (curEnd != null) total += curEnd - curStart + 1;
  return total;
}

function claimedYears(normText) {
  let best = null;
  const patterns = [/(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b(?:\s+of)?(?:\s+\w+){0,3}?\s+experience/g, /experience\s+of\s+(\d{1,2})\s*\+?\s*(?:years?|yrs?)/g];
  for (const re of patterns) for (const m of normText.matchAll(re)) best = Math.max(best || 0, Number(m[1]));
  return best;
}

/** "5 years of experience in digital marketing" — a stated number of years, only when it names one of `terms` nearby. */
function claimedRelevantYears(normText, terms) {
  let best = null;
  const patterns = [/(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b(?:\s+of)?(?:\s+\w+){0,3}?\s+experience/g, /experience\s+of\s+(\d{1,2})\s*\+?\s*(?:years?|yrs?)/g];
  for (const re of patterns) {
    for (const m of normText.matchAll(re)) {
      const around = normText.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
      if (terms.some((t) => containsTerm(around, t))) best = Math.max(best || 0, Number(m[1]));
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} text - resume text
 * @param {object} rules - normalized rules
 * @param {{method?: 'file'|'application'|'ocr', now?: Date}} [opts]
 * @returns {{verdict, reason, evidence, confidence, flagLowConfidence, checks: Array<{name, result: 'pass'|'fail'|'unsure'|'info', detail}>}}
 */
function evaluateResume(text, rules, { method = 'file', now = new Date() } = {}) {
  const norm = normalizeText(text);
  const words = (String(text || '').match(/[A-Za-z]{2,}/g) || []).length;
  const checks = [];
  const fails = []; // { reason, detail }
  const add = (name, result, detail, reason) => {
    checks.push({ name, result, detail });
    if (result === 'fail') fails.push({ reason, detail });
  };

  // Readability first — every other check depends on it.
  if (words < 15) {
    add('Readable', 'unsure', `Only ${words} words could be read from the resume${method === 'ocr' ? ' (scanned)' : ''}.`);
  } else if (words < rules.minimumWords) {
    // Thin but genuinely readable text is a weak resume; a thin OCR read may just be a bad scan.
    add('Readable', method === 'ocr' ? 'unsure' : 'fail', `Very short resume (${words} words, minimum ${rules.minimumWords}).`, REASON.POOR);
  } else {
    add('Readable', 'pass', `${words} words${method === 'ocr' ? ' (read from a scan)' : ''}.`);
  }
  const readable = words >= 15;

  if (readable) {
    // Location
    const allowedHit = rules.allowedLocations.find((l) => containsTerm(norm, l));
    const blockedHit = rules.blockedLocations.find((l) => containsTerm(norm, l));
    if (blockedHit && !allowedHit) add('Location', 'fail', `Mentions ${blockedHit}, and none of: ${rules.allowedLocations.join(', ') || '(no allowed list)'}.`, REASON.GEO);
    else if (rules.allowedLocations.length && !allowedHit) add('Location', 'unsure', `None of the allowed locations (${rules.allowedLocations.join(', ')}) appear in the resume.`);
    else if (allowedHit) add('Location', 'pass', `Mentions ${allowedHit}.`);

    // Required skills
    if (rules.requiredSkills.length) {
      const have = [];
      const missing = [];
      for (const skill of rules.requiredSkills) (skill.alternatives.some((alt) => containsTerm(norm, alt)) ? have : missing).push(skill.name);
      if (!missing.length) add('Required', 'pass', `Has all required: ${have.join(', ')}.`);
      else if (!have.length) add('Required', 'fail', `Has none of the required: ${missing.join(', ')}.`, REASON.SKILLS);
      else add('Required', 'unsure', `Has ${have.join(', ')}; missing ${missing.join(', ')}.`);
    }

    // Experience — counted in RELEVANT roles: jobs whose own entry mentions a required skill. A skill
    // that only appears in a skills list, with years spent in other work, is not relevant experience.
    const periods = findWorkPeriods(text, now);
    const totalYears = Math.max((totalMonths(periods) || 0) / 12, claimedYears(norm) || 0);
    const terms = rules.requiredSkills.flatMap((s) => s.alternatives);
    const round = (y) => Math.round(y * 10) / 10;
    if (!periods.length && !claimedYears(norm)) {
      // No dates for any job (and no "N years of experience") → Pass as "Poor Resume" (2026-10-19).
      // A scanned resume may just have unreadable dates, so that one goes to a person instead.
      if (method === 'ocr') add('Experience', 'unsure', 'No job dates could be read from this scanned resume.');
      else add('Experience', 'fail', 'No dates for any job — experience can\'t be checked.', REASON.POOR);
    } else if (terms.length) {
      const relevant = periods.filter((p) => terms.some((t) => containsTerm(normalizeText(p.block || p.line), t)));
      const years = Math.max((totalMonths(relevant) || 0) / 12, claimedRelevantYears(norm, terms) || 0);
      const totalNote = totalYears && round(totalYears) !== round(years) ? ` (${round(totalYears)} years in all jobs)` : '';
      const yearsText = years ? `about ${round(years)} years in relevant roles${totalNote}` : periods.length ? `no job in a relevant role found${totalNote}` : 'no dated experience found';
      const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;
      if (rules.minimumYears != null) {
        // Clear reject only when nothing could change the answer: all jobs together are too short, or
        // the required skills appear nowhere. If the skills are in the resume but the relevant years look
        // short, the resume layout may have hidden which job they belong to — a person decides.
        const skillsMentioned = terms.some((t) => containsTerm(norm, t));
        if (!years && !periods.length) add('Experience', 'unsure', `Needs ${rules.minimumYears}+ years; ${yearsText}.`);
        else if (totalYears < rules.minimumYears - 1) add('Experience', 'fail', `Needs ${rules.minimumYears}+ years; about ${round(totalYears)} years in all jobs.`, REASON.SKILLS);
        else if (years < rules.minimumYears - 1 && !skillsMentioned) add('Experience', 'fail', `Needs ${rules.minimumYears}+ years in a relevant role; ${yearsText}.`, REASON.SKILLS);
        else if (years < rules.minimumYears - 1) add('Experience', 'unsure', `Needs ${rules.minimumYears}+ years in a relevant role; ${yearsText} — check which jobs were relevant.`);
        else if (years < rules.minimumYears) add('Experience', 'unsure', `Needs ${rules.minimumYears}+ years; ${yearsText} — close.`);
        else add('Experience', 'pass', `${cap(yearsText)} (needs ${rules.minimumYears}).`);
      } else if (periods.length && !years) {
        add('Experience', 'unsure', `The required skills are mentioned, but ${yearsText}.`);
      } else if (years) {
        add('Experience', 'info', `${cap(yearsText)}.`);
      }
    } else if (rules.minimumYears != null) {
      const yearsText = totalYears ? `about ${round(totalYears)} years` : 'no dated experience found';
      if (!totalYears) add('Experience', 'unsure', `Needs ${rules.minimumYears}+ years; ${yearsText}.`);
      else if (totalYears < rules.minimumYears - 1) add('Experience', 'fail', `Needs ${rules.minimumYears}+ years; ${yearsText}.`, REASON.SKILLS);
      else if (totalYears < rules.minimumYears) add('Experience', 'unsure', `Needs ${rules.minimumYears}+ years; ${yearsText} — close.`);
      else add('Experience', 'pass', `About ${round(totalYears)} years (needs ${rules.minimumYears}).`);
    } else if (totalYears) {
      add('Experience', 'info', `About ${round(totalYears)} years.`);
    }

    // Job hopping — only dated (month-level) periods that have ended, within the lookback window.
    const hop = rules.jobHopping;
    if (hop.maxShortJobs > 0) {
      const windowStart = (now.getFullYear() - hop.lookbackYears) * 12 + now.getMonth() + 1;
      const dated = periods.filter((p) => !p.yearOnly);
      const short = dated.filter((p) => !p.present && p.end >= windowStart && p.months < hop.shortJobMonths);
      const detail = `${short.length} job${short.length === 1 ? '' : 's'} under ${hop.shortJobMonths} months in the last ${hop.lookbackYears} years (limit ${hop.maxShortJobs - 1}).`;
      if (dated.length < 2) add('Job history', 'unsure', 'Not enough dated jobs to judge job hopping.');
      else if (short.length >= hop.maxShortJobs) add('Job history', 'fail', detail, REASON.HOPPER);
      else add('Job history', 'pass', detail);
    }

    // Nice-to-haves never decide; they're shown to help a person reviewing.
    if (rules.preferredSkills.length) {
      // Alternatives with | work here too, e.g. "HRIS | HRM".
      const pref = rules.preferredSkills.filter((s) => s.split('|').map((t) => t.trim()).filter(Boolean).some((t) => containsTerm(norm, t)));
      add('Nice to have', 'info', pref.length ? `Has ${pref.join(', ')}.` : 'None of the nice-to-haves.');
    }
  }

  const evidence = checks.map((c) => `${c.name}: ${c.detail}`).join(' · ');
  const order = [REASON.POOR, REASON.GEO, REASON.SKILLS, REASON.HOPPER];
  if (fails.length) {
    const first = order.map((r) => fails.find((f) => f.reason === r)).find(Boolean);
    return { verdict: SCREENING_VERDICT.REJECT, reason: first.reason, evidence, confidence: 'high', flagLowConfidence: false, checks };
  }
  if (checks.some((c) => c.result === 'unsure') || !readable) {
    return { verdict: SCREENING_VERDICT.UNCERTAIN, reason: null, evidence, confidence: 'low', flagLowConfidence: true, checks };
  }
  return { verdict: SCREENING_VERDICT.ACCEPT, reason: null, evidence, confidence: 'high', flagLowConfidence: false, checks };
}

module.exports = { evaluateResume, normalizeRules, findWorkPeriods, totalMonths, claimedYears, containsTerm, DEFAULT_RULES, REASON };
