const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateResume, normalizeRules, findWorkPeriods, totalMonths } = require('../src/screening/rules');

const NOW = new Date('2026-10-19T12:00:00Z');
const filler = ' Reliable, punctual and safety focused professional with excellent customer service and communication skills.'.repeat(6);

const driverRules = normalizeRules({
  requiredSkills: ['CDL | commercial driver', 'clean driving record | clean MVR'],
  preferredSkills: ['forklift'],
  minimumYears: 3,
  allowedLocations: ['PA', 'Pennsylvania'],
  blockedLocations: ['Toronto', 'Vancouver'],
  jobHopping: { maxShortJobs: 3, shortJobMonths: 12, lookbackYears: 5 },
}).rules;

test('a clear fit is accepted with every check explained', () => {
  const resume = `Maria Lopez, Lancaster, PA\nCommercial Driver License (CDL Class A), clean driving record, forklift certified.\nDelivery Driver, ABC Logistics, March 2019 - Present\nWarehouse Associate, Jan 2016 - Feb 2019\n${filler}`;
  const r = evaluateResume(resume, driverRules, { now: NOW });
  assert.equal(r.verdict, 'ACCEPT');
  assert.equal(r.confidence, 'high');
  assert.match(r.evidence, /Has all required: CDL, clean driving record/);
  assert.match(r.evidence, /Has forklift/);
});

test('none of the required skills → Pass "Experience / Skills are not a match"', () => {
  const resume = `John Smith, Reading, PA\nCashier at Corner Store, May 2018 - Present\nStocking and inventory.\n${filler}`;
  const r = evaluateResume(resume, driverRules, { now: NOW });
  assert.equal(r.verdict, 'REJECT');
  assert.equal(r.reason, 'Experience / Skills are not a match');
});

test('clearly too little experience → Pass on skills; slightly short → sent to a person', () => {
  const tooShort = evaluateResume(`Lancaster, PA. CDL, clean driving record.\nDriver, June 2025 - Present\n${filler}`, driverRules, { now: NOW });
  assert.equal(tooShort.verdict, 'REJECT');
  assert.match(tooShort.evidence, /Needs 3\+ years/);

  const close = evaluateResume(`Lancaster, PA. CDL, clean driving record.\nDriver, Jan 2024 - Present\n${filler}`, driverRules, { now: NOW });
  assert.equal(close.verdict, 'UNCERTAIN');
  assert.match(close.evidence, /close/);
});

test('several short jobs in the last five years → Pass "Job hopper"', () => {
  const resume = `Harrisburg, PA. CDL, clean driving record.\nCDL Driver, Jan 2026 - Present\nCDL Driver, Feb 2025 - Aug 2025\nCDL Courier, Jan 2024 - Oct 2024\nCDL Driver, Mar 2023 - Nov 2023\nCDL Driver, Jan 2015 - Dec 2022\n${filler}`;
  const r = evaluateResume(resume, driverRules, { now: NOW });
  assert.equal(r.verdict, 'REJECT');
  assert.equal(r.reason, 'Job hopper');
});

test('a blocked location with no allowed one → Pass "Not located in our geo region"', () => {
  const r = evaluateResume(`Ali Khan, Toronto\nCDL holder, clean driving record.\nDriver, Jan 2015 - Present\n${filler}`, driverRules, { now: NOW });
  assert.equal(r.verdict, 'REJECT');
  assert.equal(r.reason, 'Not located in our geo region (no relo)');
});

test('no location mentioned at all is not a rejection — a person decides', () => {
  const r = evaluateResume(`CDL Class A, clean driving record.\nDriver, Jan 2015 - Present\n${filler}`, driverRules, { now: NOW });
  assert.equal(r.verdict, 'UNCERTAIN');
  assert.match(r.evidence, /None of the allowed locations/);
});

test('some but not all required skills → a person decides', () => {
  const r = evaluateResume(`Lancaster, PA. CDL Class A.\nDriver, Jan 2015 - Present\n${filler}`, driverRules, { now: NOW });
  assert.equal(r.verdict, 'UNCERTAIN');
  assert.match(r.evidence, /missing clean driving record/);
});

test('unreadable or nearly empty text is never auto-passed', () => {
  assert.equal(evaluateResume('scan', driverRules, { now: NOW }).verdict, 'UNCERTAIN');
  const shortScan = evaluateResume('CDL driver Lancaster PA clean driving record ten years experience driving trucks across the state daily', driverRules, { method: 'ocr', now: NOW });
  assert.notEqual(shortScan.reason, 'Poor Resume');
});

test('a genuinely thin (but readable) resume → Pass "Poor Resume"', () => {
  const r = evaluateResume('Driver. Lancaster PA. Looking for work. I can drive cars and vans well. Call me any time please thanks.', driverRules, { method: 'file', now: NOW });
  assert.equal(r.verdict, 'REJECT');
  assert.equal(r.reason, 'Poor Resume');
});

test('education date ranges are not counted as work experience', () => {
  const periods = findWorkPeriods('Bachelor of Science, Penn State University, 2012 - 2016\nDispatcher, City Cabs, Jan 2017 - Dec 2019', NOW);
  assert.equal(periods.length, 1);
  assert.equal(totalMonths(periods), 36);
});

test('a date on its own line takes the meaning of the heading next to it', () => {
  const periods = findWorkPeriods('Master of Business Administration\n2018 - 2020\nOperations Supervisor\nMar 2020 - Feb 2023', NOW);
  assert.equal(periods.length, 1);
  assert.equal(periods[0].months, 36);
});

test('overlapping jobs are not double-counted', () => {
  const periods = findWorkPeriods('Driver, Jan 2020 - Dec 2021\nPart-time courier, Jun 2021 - Dec 2022', NOW);
  assert.equal(totalMonths(periods), 36);
});

test('a "10+ years of experience" claim counts when dates are missing', () => {
  const r = evaluateResume(`Lancaster, PA. CDL, clean driving record. Over 10+ years of driving experience.\n${filler}`, normalizeRules({ requiredSkills: ['CDL'], minimumYears: 5 }).rules, { now: NOW });
  assert.equal(r.verdict, 'ACCEPT');
});

test('normalizeRules: alternatives with "|", and at least one rule is required', () => {
  const { rules } = normalizeRules({ requiredSkills: ['CDL | commercial driver'] });
  assert.deepEqual(rules.requiredSkills[0], { name: 'CDL', alternatives: ['CDL', 'commercial driver'] });
  assert.ok(normalizeRules({ preferredSkills: ['x'] }).problems.some((p) => /at least one rule/.test(p)));
});

test('skills match whole words only, and multi-word terms tolerate hyphens', () => {
  const r = normalizeRules({ requiredSkills: ['C++', 'forklift operator'] }).rules;
  const res = evaluateResume(`Skills: C++, fork-lift operator.\nEngineer, Jan 2015 - Present\n${filler}`, r, { now: NOW });
  assert.match(res.evidence, /missing forklift operator|Has all required/);
  assert.match(evaluateResume(`Skills: c++\nEngineer, Jan 2015 - Present\n${filler}`, normalizeRules({ requiredSkills: ['C++'] }).rules, { now: NOW }).evidence, /Has all required: C\+\+/);
  assert.match(evaluateResume(`Skills: pcdl\nEngineer, Jan 2015 - Present\n${filler}`, normalizeRules({ requiredSkills: ['CDL'] }).rules, { now: NOW }).evidence, /none of the required/);
});

test('nice-to-haves can list alternatives with | too', () => {
  const { rules } = normalizeRules({ requiredSkills: ['HR manager'], preferredSkills: ['HRIS | HRM', 'Excel'] });
  const text = `HR manager at ABC 01/2015 - Present. Used HRM software daily. ${'Reliable and organised team player. '.repeat(12)}`;
  const v = evaluateResume(text, rules, { method: 'file' });
  assert.match(v.evidence, /Nice to have: Has HRIS \| HRM\./);
});

test('years count only in relevant roles: a data entry operator who lists "social media" is not a marketer', () => {
  const rules = normalizeRules({ requiredSkills: ['digital marketing | brand manager | marketing executive'], preferredSkills: ['social media'], minimumYears: 3 }).rules;
  // The real case: years of data entry, "social media management" listed — never a marketer → reject.
  const dataEntry = `SKILLS\nData entry operator, computer operator, online social media management\nEXPERIENCE\nData Entry Operator, Income Support Program, 2016 - 2019\nComputer Operator, City Office, 2019 - 2024\n${filler}`;
  const r = evaluateResume(dataEntry, rules, { now: NOW });
  assert.equal(r.verdict, 'REJECT');
  assert.match(r.evidence, /no job in a relevant role found \(\d+(\.\d)? years in all jobs\)/);

  // The skill word is in the resume but no job shows it: never accepted, but a person decides —
  // the layout may hide which job it belongs to.
  const mentions = dataEntry.replace('social media management', 'social media management, digital marketing basics');
  const unsure = evaluateResume(mentions, rules, { now: NOW });
  assert.equal(unsure.verdict, 'UNCERTAIN');
  assert.match(unsure.evidence, /check which jobs were relevant/);

  // Title and duties ABOVE the dates (a common PDF layout) still count for that job.
  const above = `EXPERIENCE\nSocial Media Manager, Digital Marketing Executive\nRan campaigns and SEO outreach.\nMarch 2020 - April 2025\nTrendy Co\n${filler}`;
  assert.equal(evaluateResume(above, rules, { now: NOW }).verdict, 'ACCEPT');

  const marketer = `EXPERIENCE\nDigital Marketing Executive, Brand Co, Jan 2019 - Present\nRan paid and organic campaigns.\nSales Assistant, Shop, 2015 - 2018\n${filler}`;
  const ok = evaluateResume(marketer, rules, { now: NOW });
  assert.equal(ok.verdict, 'ACCEPT');
  assert.match(ok.evidence, /years in relevant roles/);
});

test('no dates for any job → Pass "Poor Resume" (a scan with unreadable dates goes to a person)', () => {
  const rules = normalizeRules({ requiredSkills: ['SEO'], minimumYears: 3 }).rules;
  const noDates = `SEO Specialist at Rank Co. Did keyword research, link building and audits.\n${filler}`;
  const r = evaluateResume(noDates, rules, { now: NOW });
  assert.equal(r.verdict, 'REJECT');
  assert.equal(r.reason, 'Poor Resume');
  assert.match(r.evidence, /No dates for any job/);
  assert.equal(evaluateResume(noDates, rules, { now: NOW, method: 'ocr' }).verdict, 'UNCERTAIN');
  // "8 years of experience" with no dated jobs is not "missing dates".
  assert.notEqual(evaluateResume(`SEO Specialist with 8 years of experience in SEO.\n${filler}`, rules, { now: NOW }).reason, 'Poor Resume');
});
