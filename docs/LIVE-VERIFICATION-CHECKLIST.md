# Live verification checklist

Resolve every item here before pointing this at real candidates. Items marked **carried over,
already confirmed** come from `Paycor-Outreach-Toolkit`'s own README (confirmed live 2026-08-09)
and `Paycor-full-package/docs/paycor-screen-plan.md` (confirmed live 2026-09-09) — they're listed
so the full picture is in one place, not because they're newly in doubt.

## Carried over, already confirmed live

- [x] Send-email-and-advance flow, Pass-candidate button/dialog/reason text, reply reading via
  `candidateHistoryList` — all confirmed 2026-08-09 against real candidate-profile pages.
- [x] Job list scraping, Job Seeker grid scraping, resume-viewer scroll+screenshot mechanics —
  confirmed 2026-09-09 (Recruiting v19.92.0).

## New in this project — unverified

- [ ] **`advanceResumeQuickScreen`'s exact confirm/toast behavior.** The plan flagged this as
  needing confirmation on the first live candidate — screenshot and adapt.
- [ ] **`getFluencySubmission`'s Vocaroo-link extraction from the Newsfeed.** Built from the
  `paycor-fluency.md` command's description of where the link lives, never run against a real
  Newsfeed entry by this project's code.
- [ ] **`getFluencySubmission`'s typing-PDF download.** Same status — the selector
  (`.download-icon a[href*="/attachments/"]`) is reused from `/paycor-resume`'s confirmed
  pattern, but the "pick the one that looks like a typing test" heuristic here is new and
  untested against a profile with multiple attachments.
- [ ] **Fluency scorecard auto-submit — currently disabled by design.** `fillFluencyScorecard`
  only *locates* the fields (exact label matching) and always reports the form as incomplete,
  because nobody has confirmed how Paycor's star-rating widgets (Confident Delivery, Accent,
  Fluency, Typing Speed Skill) can be set. Every scored candidate goes to the exception queue
  with the computed scores. To enable auto-submit: confirm the widget live, set all fields in
  `fillFluencyScorecard`, submit only when `missing` is empty, and verify the result.
- [ ] **Where the scorecard form lives.** `paycor-fluency.md` says it's filled "on the profile";
  `fillFluencyScorecard` looks on the profile page. Confirm.
- [ ] **"Already scored" detection** is a heuristic (scorecard title near the word
  "submitted"/"completed"). Confirm against a candidate with a submitted fluency scorecard.
- [ ] **Job Seeker grid scrolling.** `scrapeJobSeekers` scrolls `.ag-body-viewport` and refuses
  to screen if it reads fewer rows than the footer's total. Confirm the scroller class on the real
  grid.
- [ ] **Resume-screening API call** has only run against a mocked client. Run one dry-run sweep
  with a real `ANTHROPIC_API_KEY` and check the verdicts in `screening-results/`.
- [ ] **Resume-screening's `advanceResumeQuickScreen` / `passCandidate` targeting the right
  candidate state.** The screening sweep navigates page-by-page through scraped candidate IDs;
  confirm the Angular app doesn't need an extra settle delay between `goto` and reading
  `activeResumeGroups` at real-world network speed (the 8s poll in `screenshotResumePages`
  is a guess, not a measured value).
- [ ] **Resume-screening calibration.** Before trusting `ACCEPT`/`REJECT` verdicts unattended,
  run a dry-run sweep against a job with known-good human verdicts and compare — same spirit as
  `Paycor-fluency`'s own calibration test suite for speaking stars.

## Staged rollout (same philosophy as `Paycor-Outreach-Toolkit`'s own plan)

1. Dry-run mode (`DRY_RUN=true` / the dashboard's "Dry run" checkbox) across a full cycle so
   every branch fires at least once, including a fluency submission and a screening sweep.
2. Live, but gated: keep the manual-review queue as the only path for screening verdicts and
   fluency scores for a trial period, even ones the judgment service was confident about —
   compare its calls against your own judgment before trusting it unattended.
3. Full auto once agreement has been consistently high, with the compliance-sampling practice
   from `docs/ARCHITECTURE.md` kept standing, not dropped once trust is established.
