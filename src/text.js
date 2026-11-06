// Pure HTML/text helpers, run in Node rather than inside page.evaluate so they're unit-testable.
//
// Why not innerText in the page: Paycor's history `content` is put into a detached <div>, and
// per the HTML spec innerText on a non-rendered element falls back to textContent — which drops
// every <br>/<p> line break. quoteStrip.js needs those line breaks to find the "From:" line of the
// quoted thread, so without them the quoted header's email address made every reply look like it
// had answered the attention-to-detail check.

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|blockquote|h[1-6]|table)>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const VOCAROO_RE = /https?:\/\/(?:www\.)?(?:vocaroo\.com|voca\.ro)\/[A-Za-z0-9]+/i;

/** Searches raw HTML (so link hrefs count, not just visible link text) for a Vocaroo link. */
function findVocarooLink(htmlOrText) {
  const match = String(htmlOrText || '').match(VOCAROO_RE);
  return match ? match[0] : null;
}

module.exports = { htmlToText, findVocarooLink };
