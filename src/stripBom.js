// Notepad and PowerShell's `Set-Content -Encoding utf8` both commonly write a UTF-8
// byte-order-mark, which JSON.parse chokes on. Every JSON file this project reads from disk
// that a human or non-Node tool might have saved goes through this first.
// Ported as-is from Paycor-Outreach-Toolkit/src/stripBom.js (already unit-tested there).
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

module.exports = { stripBom };
