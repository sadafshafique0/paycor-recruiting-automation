// Turns a resume file into plain text — offline, free, on whichever computer runs the app.
// PDF (Mozilla's PDF.js), Word .docx (mammoth), old Word .doc (word-extractor), RTF and plain text.
// Scanned resumes with no text layer fall back to OCR (Tesseract.js) on screenshots of Paycor's
// resume viewer; Tesseract downloads its English language file (~10 MB) once, on first use, and
// keeps it in %LOCALAPPDATA%\AutonomousPaycorWorkflow\ocr-cache.

const path = require('path');

function detectKind(buffer, fileName = '', contentType = '') {
  const head = buffer.subarray(0, 8);
  const ext = path.extname(fileName).toLowerCase();
  if (head.subarray(0, 4).toString('latin1') === '%PDF' || /pdf/i.test(contentType)) return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b) return 'docx'; // zip container (docx)
  if (head.toString('hex') === 'd0cf11e0a1b11ae1') return 'doc'; // old Office binary
  if (buffer.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  if (ext === '.txt' || /^text\/plain/i.test(contentType)) return 'txt';
  if (ext === '.html' || ext === '.htm' || /html/i.test(contentType)) return 'html';
  return 'unknown';
}

async function pdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true, disableFontFace: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, 15); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join(''));
    }
    return pages.join('\n');
  } finally {
    await task.destroy().catch(() => {});
  }
}

async function docxText(buffer) {
  const mammoth = require('mammoth');
  return (await mammoth.extractRawText({ buffer })).value;
}

async function docText(buffer) {
  const WordExtractor = require('word-extractor');
  const doc = await new WordExtractor().extract(buffer);
  return doc.getBody();
}

function rtfText(buffer) {
  return buffer
    .toString('latin1')
    .replace(/\\par[d]?/g, '\n')
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\'[0-9a-f]{2}/gi, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '');
}

function htmlText(buffer) {
  return buffer
    .toString('utf8')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function wordCount(text) {
  return (String(text || '').match(/[A-Za-z]{2,}/g) || []).length;
}

/** @returns {Promise<{text: string, kind: string, words: number}>} */
async function extractText(buffer, { fileName = '', contentType = '' } = {}) {
  const kind = detectKind(buffer, fileName, contentType);
  let text = '';
  try {
    if (kind === 'pdf') text = await pdfText(buffer);
    else if (kind === 'docx') text = await docxText(buffer);
    else if (kind === 'doc') text = await docText(buffer);
    else if (kind === 'rtf') text = rtfText(buffer);
    else if (kind === 'html') text = htmlText(buffer);
    else if (kind === 'txt') text = buffer.toString('utf8');
  } catch {
    text = ''; // a damaged or unusual file — the caller falls back to OCR
  }
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, kind, words: wordCount(text) };
}

/** OCR on PNG screenshots (base64). Slower (~5–15 s per screenshot) — only for scanned resumes. */
async function ocrScreenshots(screenshotsBase64, cachePath) {
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('eng', 1, { cachePath, logger: () => {} });
  try {
    const parts = [];
    for (const b64 of screenshotsBase64) {
      const { data } = await worker.recognize(Buffer.from(b64, 'base64'));
      parts.push(data.text || '');
    }
    const text = parts.join('\n').trim();
    return { text, words: wordCount(text) };
  } finally {
    await worker.terminate();
  }
}

module.exports = { extractText, ocrScreenshots, detectKind, wordCount };
