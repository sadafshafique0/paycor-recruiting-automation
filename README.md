# Autonomous Paycor Workflow

An unattended, dashboard-driven version of the Paycor recruiting pipeline — resume screening,
outreach, reminders/escalation, and fluency scoring — that runs without a live Claude Code chat
session, MCP Playwright, or the Claude-in-Chrome extension. A colleague opens a local web page,
assigns a job to the pipeline, and the rest happens on its own; anything it isn't confident
about lands in an exception queue for a human to resolve.

> **Portfolio copy.** This is a sanitized public version of a private, in-use project. Company
> names, email-template and stage names, real job screening rules, and people's names have been
> replaced with generic placeholders; `screening-criteria/job-101.*` is a fictional example.

It's the productized successor to three earlier private tools (`Paycor-full-package`,
`Paycor-Outreach-Toolkit`, `Paycor-fluency`) and reuses their proven logic:

| Piece | Reused from | What changed |
|---|---|---|
| Outreach state machine, timers, scheduler, reply classifier | `Paycor-Outreach-Toolkit` | Ported essentially as-is (same 90-test-covered logic) — fluency's hand-off changed, see below |
| Paycor UI selectors (send email, Pass, reply reading, job/resume scraping) | `Paycor-Outreach-Toolkit` + `Paycor-full-package/docs/paycor-screen-plan.md` | Reused where confirmed live; new resume-screening and scorecard-fill selectors are **unverified** — see `docs/LIVE-VERIFICATION-CHECKLIST.md` |
| Fluency scoring (Whisper transcription, typing-PDF parsing, star-rating rules) | `Paycor-fluency` | Called as a subprocess (`src/fluency/runFluencyScorer.js`) rather than reimplemented — still free, still offline |
| Resume-fit judgment | *(new)* | Calls the Claude API directly (`src/screening/resumeJudge.js`) instead of a live Claude Code chat session judging each resume |

## Status: a complete, tested scaffold — **not yet safe to run live**

Every piece of pure decision logic (state machine, timers, scheduler, reply classifier, fluency
scoring math) is built and unit-tested: `npm test` → 97 passing, including regression tests for
the safety fixes below. The dashboard boots, serves its API, and a full dry-run daily cycle has
been exercised end-to-end locally.

**Fluency scorecards are never auto-submitted yet.** Scoring runs automatically, but the
scorecard's star-rating widgets have no confirmed way to be set, so every scored candidate lands
in the exception queue with the computed scores to enter by hand, rather than being submitted
incomplete. See the checklist.

### Safety behavior worth knowing

- Every action opens and verifies the target candidate's own profile first.
- An expired Paycor login stops the whole run; nobody gets acted on from a login page.
- A candidate whose replies couldn't be read is skipped that day — never timed out and Passed.
- Dry runs write nothing (no state, no queue entries); they list what they *would* do.
- Screening never acts on a candidate who has left the Job Seeker stage, caps automatic Passes
  per run (`screening.maxPassesPerRun`, default 25), and enrolls accepted candidates straight into
  the chosen outreach pipeline.
- The dashboard listens on `127.0.0.1` only and rejects requests for any other host name.

What has **not** been done: anyone actually clicking through this against a live, logged-in
Paycor session. The resume-screening and fluency-scorecard browser automation in
`src/paycor-actions.js` is written from the selectors already reverse-engineered in the sibling
projects' own docs, but — unlike the outreach/reply/Pass functions, which carry over selectors
already confirmed live in `Paycor-Outreach-Toolkit` — nobody has run the screening or
scorecard-fill code against a real candidate yet. **Do not point this at real candidates until
`docs/LIVE-VERIFICATION-CHECKLIST.md` is resolved.**

## Using it (no terminal needed)

1. Install [Node.js](https://nodejs.org) (LTS) once.
2. Double-click **`Start Recruiting Assistant.bat`**. The first time, it installs the app's
   components; after that it just opens the dashboard in your browser. Keep the black window open
   while you work — closing it stops the dashboard.
3. **Log in to Paycor.** The dashboard opens on a login screen. Click **Log in to Paycor**: Paycor's
   own login page opens in a separate Edge window — sign in there with your Paycor username,
   password and verification code. Your password goes only to Paycor; this app never sees or
   stores it. As soon as Paycor finishes loading, the dashboard opens and your active jobs ("My
   Jobs") are loaded onto the **Jobs** page. You stay logged in on this computer until Paycor ends
   the session (the login screen then comes back by itself) or you click **Log out** in the
   sidebar — which is also how a colleague switches to their own Paycor account.
4. The **Home** page walks you through the rest of setup:
   - **Settings** — your name, your Claude API key, and each job pipeline (email template names,
     Paycor statuses, Pass reasons). On the Jobs page, **No pipeline — set up** starts a pipeline
     for that job from the example. Check every name against Paycor — spelling and punctuation must
     match exactly. Saved only on this computer, under `%LOCALAPPDATA%\AutonomousPaycorWorkflow`.
   - The fluency helper (`Paycor-fluency`) must be set up separately — see its README. Set
     `PAYCOR_FLUENCY_DIR` in `.env` if it isn't in a `Paycor-fluency` folder next to this project.
5. Then, day to day:
   - **Jobs** — every active job with its new-applicant count; **Screen N new** opens screening for
     that job. **Refresh from Paycor** re-reads the list.
   - **Screen applicants** — Job ID, set the job's screening rules (required skills, minimum years,
     locations, job hopping), pick the pipeline, then **Test run** (shows what each rule decided,
     changes nothing) or **Screen for real**. No AI and no API key needed: each resume is downloaded
     into memory, read on this computer, and never stored or sent anywhere. Clear fits are advanced,
     clear mismatches passed, everything in between goes to Needs attention. (Settings can switch
     screening to Claude AI instead, which needs an API key and costs about 1.5¢ per resume.)
   - **Daily outreach** — **Test run** or **Run outreach now**; also adds candidates to a pipeline
     by ID.
   - **Needs attention** — everything left for a person, with Advance / Pass buttons for
     screening decisions and an "Open in Paycor" link on every item.
   - **Candidates** — everyone being tracked, filterable by stage and pipeline.

Results are shown as plain-language summaries; the raw log is one click away under
"Technical details". The terminal entry points (`cli/*.js`, `npm run run-daily` etc.) still work for
Task Scheduler.

## Architecture, cost, and what's genuinely unverified

See `docs/ARCHITECTURE.md` for why this has no MCP/Claude-in-Chrome dependency, the per-resume
API cost math, and the packaging path to a double-click app for non-technical colleagues. See
`docs/LIVE-VERIFICATION-CHECKLIST.md` before any live (non-dry-run) use.

## Safety notes carried over from the sibling projects

- Every automatic Pass/reject uses one of the fixed reason strings only — never an invented one
  (enforced in code, not just prompted for, in `src/screening/resumeJudge.js`).
- Any reply classified `query`, any screening verdict the judgment service wasn't confident
  about, and any fluency submission that couldn't be rated all go to the manual-review queue —
  never guessed, never silently dropped.
- A sudden large batch of auto-Passes (symptom of a long outage, not a real event) trips a
  backlog safety cap and queues for manual approval instead of auto-executing.
- `AUTO_SCORE_FLUENCY` never submits a scorecard it couldn't actually rate — see
  `src/fluency/scorecardMapping.js`'s `needsManual` path.
