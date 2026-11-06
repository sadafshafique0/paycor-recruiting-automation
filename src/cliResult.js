// CLI runs print one machine-readable line at the end so the dashboard can show a plain-language
// result card instead of making a colleague read the raw log. While they work they also print
// progress lines ("Screening resumes 2/25"), shown live on the dashboard.

const RESULT_MARKER = '@@RESULT@@ ';
const PROGRESS_MARKER = '@@PROGRESS@@ ';

function printResult(result) {
  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);
}

function printProgress(label, done, total) {
  process.stdout.write(`\n${PROGRESS_MARKER}${JSON.stringify({ label, done, total })}\n`);
}

/** Returns the last result object printed in a run's output, or null. */
function extractResult(output) {
  const lines = String(output || '').split(/\r?\n/).filter((l) => l.startsWith(RESULT_MARKER));
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1].slice(RESULT_MARKER.length));
  } catch {
    return null;
  }
}

/** The latest progress a run reported ({label, done, total}), or null. */
function extractProgress(output) {
  const text = String(output || '');
  const at = text.lastIndexOf(PROGRESS_MARKER);
  if (at === -1) return null;
  const line = text.slice(at + PROGRESS_MARKER.length).split(/\r?\n/)[0];
  try {
    return JSON.parse(line);
  } catch {
    return null; // the line is still arriving
  }
}

/** The raw log with the result and progress lines removed, for the "technical details" view. */
function stripResultLines(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter((l) => !l.startsWith(RESULT_MARKER) && !l.startsWith(PROGRESS_MARKER))
    .join('\n')
    .trim();
}

module.exports = { printResult, printProgress, extractResult, extractProgress, stripResultLines, RESULT_MARKER, PROGRESS_MARKER };
