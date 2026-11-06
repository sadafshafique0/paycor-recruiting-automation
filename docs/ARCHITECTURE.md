# Architecture

## Why no MCP, no Claude-in-Chrome

MCP Playwright and the Claude-in-Chrome extension exist to let an LLM in an interactive chat
session drive a browser turn by turn, with a human watching. Neither is a requirement of
*automating a browser* — only of a *chat session* automating one. This project has no chat
session in the loop at all, so it drives Playwright as a plain Node library
(`src/edge.js`, `src/paycor-actions.js`) and calls the Claude API directly for the one task that
genuinely needs judgment (`src/screening/resumeJudge.js`), with no MCP server involved.

Reply detection is Outlook-free for the same reason the original toolkit went that way: a
candidate's reply to a Paycor-sent email gets logged back onto their own Paycor profile by
Paycor's own send-relay, so `readLatestReply` reads it straight off the Angular
`candidateHistoryList` scope — no inbox, no browser extension, no second login.

## The nervous system vs. the hands vs. the one judgment call

```
                    ┌─────────────────────────────────────────┐
  Dashboard  ─────▶  │  src/engine/scheduler.js (the daily cycle) │
  (server/)          │  + src/engine/trackMachine.js (pure)       │
                    │  + src/engine/timers.js (pure)              │
                    └───────────────┬─────────────────────────────┘
                                    │ ACTION
                    ┌───────────────▼─────────────────────────────┐
                    │  src/engine/executeAction.js (dispatcher)     │
                    └──┬─────────────┬──────────────┬──────────────┘
                       │             │              │
             src/paycor-actions.js   │     src/fluency/runFluencyScorer.js
             (Playwright library,    │     (subprocess → Paycor-fluency's
              no MCP)                │      analyze.py — free, offline)
                                     │
                          src/screening/resumeJudge.js
                          (Anthropic Messages API, direct —
                           the only metered call in this project)
```

Everything in the left/middle columns is deterministic code — free, already unit-tested, and
the same kind of logic `Paycor-Outreach-Toolkit` already proved out (90 tests there, 97 here).
Only resume-fit screening calls an LLM, because judging a resume against a job description is
not reducible to a rule.

## Cost

The only metered cost in this project is `resumeJudge.js`'s calls to the Anthropic API. Per
candidate screened: 1–3 resume screenshots (~1,300–2,600 tokens each) + the job criteria text
(~300–800 tokens) in, a short structured verdict out (~250 tokens) — roughly 6,500 input tokens,
250 output tokens.

| Model | Cost/candidate screened |
|---|---|
| Claude Sonnet 5 (`SCREENING_MODEL` default) | ~$0.015 |
| Claude Opus 5 | ~$0.039 |

At 6,500 resumes/month (300/day, 5 days/week) that's **~$97/month on Sonnet 5** — well under
what a single part-time screening role costs, and it doesn't scale with how many colleagues use
the dashboard, only with how many resumes get screened. Everything else (outreach sends,
reminders, reply reading, fluency scoring) costs $0 in API terms — it's plain Playwright and a
local Whisper model.

`resumeJudge.js` defaults to Sonnet 5 specifically because this is a high-volume,
well-specified, cost-sensitive classification task — not open-ended reasoning — and because at
real volume the model choice crosses the breakeven point against what a human screener costs
(see the per-resume cost table above). Change `SCREENING_MODEL` in `.env` if calibration shows
Sonnet 5 isn't accurate enough; re-check the cost math before doing so.

## Concurrency

The daily cycle, a screening sweep, and a dashboard Accept/Pass all drive the same persistent
Edge profile, so they share one run lock (`run.lock`) and the dashboard allows one at a time.
`candidatesState.json` and `manualReview.json` are written under a short per-file lock
(`withFileLock` in `src/state/store.js`) so the dashboard and a running CLI process can't drop
each other's writes.

## Packaging for non-technical colleagues

The dashboard (`server/`) is the whole UI surface: no file editing, no terminal, no Claude Code.
What's still missing to make this a true double-click product:

1. **An installer.** Bundle the Node runtime, this app, and Playwright's browser binary into a
   Windows installer (electron-builder or Tauri) so nobody runs `npm install`.
2. **A first-run wizard.** Open a browser window, have the colleague log into their own Paycor
   account once, close it — same persistent-profile pattern `src/edge.js` already uses.
3. **A shared Anthropic API key baked into the install**, not entered by each colleague.

None of this changes the architecture above — it's packaging, not a rewrite.

## What this does *not* remove: the human role

Resume screening is the highest-stakes judgment call in this pipeline — auto-rejecting real
applicants with zero review has real compliance exposure (see the ADEA-adjacent findings already
surfaced in this org's existing scorecard audit). Keep:

- The manual-review queue as mandatory for screening, not a setting a colleague can disable.
- A periodic human spot-check of auto-rejections, even once confidence is high.
- Fixed, closed-set reject reasons only — `resumeJudge.js` validates the model's chosen reason
  against the fixed list and downgrades to `UNCERTAIN` rather than trusting an invented one.
