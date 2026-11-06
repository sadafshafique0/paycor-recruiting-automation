// Isolate a candidate's new reply text from the quoted original message beneath it.
// Without this, a reply that only quotes the instruction text (e.g. "...reply with your
// favorite color...") could false-positive as an answer.
// Ported as-is from Paycor-Outreach-Toolkit/src/quoteStrip.js.

const QUOTE_MARKERS = [
  /^from:\s/i,
  /^sent:\s/i,
  /^to:\s/i,
  /^subject:\s/i,
  /^on .+ wrote:\s*$/i,
  /^>/,
  /^-{2,}\s*original message\s*-{2,}\s*$/i,
];

function stripQuote(rawText) {
  const text = String(rawText || '');
  const lines = text.split(/\r?\n/);
  let cutIndex = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && QUOTE_MARKERS.some((re) => re.test(line))) {
      cutIndex = i;
      break;
    }
  }
  return lines.slice(0, cutIndex).join('\n').trim();
}

module.exports = { stripQuote };
