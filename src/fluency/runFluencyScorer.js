// Bridges to the already-built, already-tested Paycor-fluency Python tool rather than
// reimplementing Whisper transcription + typing-PDF parsing in Node. Paycor-fluency is free and
// offline (local Whisper model, no API key) — see that project's own README.
//
// Default paths point at the sibling project on this machine
// (a Paycor-fluency folder next to this project). Override via PAYCOR_FLUENCY_DIR in .env if it ever
// moves or a colleague's machine lays out the Desktop differently.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function fluencyDir() {
  return process.env.PAYCOR_FLUENCY_DIR || path.resolve(__dirname, '..', '..', '..', 'Paycor-fluency');
}

function pythonExe() {
  return path.join(fluencyDir(), '.venv', 'Scripts', 'python.exe');
}

function analyzeScript() {
  return path.join(fluencyDir(), 'analyze.py');
}

function checkInstalled() {
  const py = pythonExe();
  const script = analyzeScript();
  if (!fs.existsSync(py)) return { ok: false, reason: `Python venv not found at ${py} — set up Paycor-fluency first (see its README) or set PAYCOR_FLUENCY_DIR` };
  if (!fs.existsSync(script)) return { ok: false, reason: `analyze.py not found at ${script}` };
  return { ok: true };
}

/**
 * Runs analyze.py against a Vocaroo link + (optional) typing PDF path and returns the parsed
 * JSON. Per the fluency command's own error-handling rule: a Python/setup failure is surfaced
 * as an error the caller should treat as "stop and look at this", not a per-candidate outcome —
 * see executeAction.js's AUTO_SCORE_FLUENCY handler.
 *
 * @param {string|null} vocarooLink
 * @param {string|null} typingPdfPath
 * @returns {Promise<object>} parsed analyze.py stdout
 */
function runAnalyze(vocarooLink, typingPdfPath) {
  const installed = checkInstalled();
  if (!installed.ok) return Promise.reject(new Error(installed.reason));

  const args = [analyzeScript(), '--audio', vocarooLink || ''];
  if (typingPdfPath) args.push('--typing-pdf', typingPdfPath);

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExe(), args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`analyze.py exited ${code}: ${stderr || '(no stderr)'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`analyze.py did not print valid JSON: ${err.message}\n--- stdout ---\n${stdout}`));
      }
    });
  });
}

module.exports = { runAnalyze, checkInstalled, fluencyDir, pythonExe, analyzeScript };
