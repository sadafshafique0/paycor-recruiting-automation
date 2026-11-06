# Screening criteria

Job descriptions used by the resume-screening judgment service (`src/screening/`) to judge
whether a Job Seeker's resume is a good fit. These are job postings, not candidate PII — safe
to keep in this folder and commit.

## One file per job

Name each file by the job's **numeric Job ID** as shown on the Paycor job card ("Job ID: 146"):

```
screening-criteria/job-146.md
screening-criteria/job-211.md
```

A screening sweep refuses to run against a job with no criteria file here — it reports
`missing_criteria` rather than inventing a judgment. The dashboard's job-assignment screen lets
a colleague paste a job description directly, which writes this file for them.

## Format

Free-form is fine — paste the real job posting. Optionally add explicit bullets at the end to
sharpen the call; the judgment service reads the whole file holistically.

```markdown
# <Job title> (Job ID <n>)

<the full job description / posting text>

## REQUIRED
- 8+ years HR experience
- Bachelor's degree

## PREFERRED
- SHRM / PHR / SPHR certification

## DISQUALIFIERS
- No relevant experience / internship only
- Located outside the hiring region with no relocation
- Job hopper (multiple <1-year stints)
```

## Reject reasons

When a resume is not a fit, the judgment service picks one of these four fixed Paycor "Pass on
Candidate" reasons (see `src/engine/constants.js` `SCREENING_PASS_REASONS`) — never an invented
one:

- `Experience / Skills are not a match`
- `Job hopper`
- `Not located in our geo region (no relo)`
- `Poor Resume`

Write the DISQUALIFIERS section with those four buckets in mind.
