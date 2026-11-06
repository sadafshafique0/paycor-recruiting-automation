const { test } = require('node:test');
const assert = require('node:assert/strict');
const { typingStars, finalScore, suggestSpeaking, buildScorecardData } = require('../src/fluency/scorecardMapping');

test('typingStars: no WPM -> 0 stars with a note, not an error', () => {
  const r = typingStars(0, null);
  assert.equal(r.stars, 0);
  assert.match(r.note, /No typing test/);
});

test('typingStars: at least 70 WPM with good accuracy -> 5 stars', () => {
  const r = typingStars(72, 98);
  assert.equal(r.stars, 5);
});

test('typingStars: 65 WPM -> 4 stars (>=60 threshold, "at least" semantics)', () => {
  const r = typingStars(65, 96);
  assert.equal(r.stars, 4);
});

test('typingStars: accuracy below 93% disqualifies regardless of WPM', () => {
  const r = typingStars(80, 90);
  assert.equal(r.stars, 0);
  assert.match(r.note, /Disqualified/);
});

test('finalScore: perfect speaking + perfect typing -> 5.0', () => {
  const { finalScore: score, speakingAverage } = finalScore(5, 5, 5, 5);
  assert.equal(speakingAverage, 5);
  assert.equal(score, 5.0);
});

test('finalScore: speaking is weighted 0.9, typing only 0.1', () => {
  const { finalScore: score } = finalScore(3, 3, 3, 0);
  assert.equal(score, 2.7); // 3*0.9 + 0*0.1
});

test('suggestSpeaking: fast, clear speech scores high', () => {
  const r = suggestSpeaking({ speaking_rate_wpm: 140, unclear_words_percent: 2, duration_sec: 90, pauses_over_1_5s: 0, longest_pause_sec: 2 });
  assert.ok(r.fluency >= 4.5, `expected high fluency, got ${r.fluency}`);
  assert.ok(r.accent >= 4.5);
});

test('suggestSpeaking: slow, unclear speech with a very long pause scores low', () => {
  const r = suggestSpeaking({ speaking_rate_wpm: 80, unclear_words_percent: 20, duration_sec: 60, pauses_over_1_5s: 5, longest_pause_sec: 20 });
  assert.ok(r.fluency <= 1.5, `expected low fluency, got ${r.fluency}`);
});

test('buildScorecardData: no Vocaroo link -> needsManual, never guesses a score', () => {
  const r = buildScorecardData({ speech: { error: 'No Vocaroo link found.' }, typing: { wpm: 0 } }, null);
  assert.equal(r.needsManual, true);
  assert.match(r.needsManualReason, /No Vocaroo link/);
});

test('buildScorecardData: speech.error set -> needsManual even if a link exists', () => {
  const r = buildScorecardData({ speech: { error: 'dead link' }, typing: { wpm: 0 } }, 'https://voca.ro/abc');
  assert.equal(r.needsManual, true);
  assert.match(r.needsManualReason, /dead link/);
});

test('buildScorecardData: zero word_count -> needsManual (silent/unreadable recording)', () => {
  const r = buildScorecardData({ speech: { word_count: 0, speaking_rate_wpm: 0, unclear_words_percent: 100, duration_sec: 5, pauses_over_1_5s: 0, longest_pause_sec: 0 }, typing: { wpm: 0 } }, 'https://voca.ro/abc');
  assert.equal(r.needsManual, true);
});

test('buildScorecardData: uses analyze.py\'s own suggested_stars when present, rather than recomputing', () => {
  const r = buildScorecardData(
    {
      speech: { word_count: 50, speaking_rate_wpm: 120, unclear_words_percent: 5, duration_sec: 60, pauses_over_1_5s: 0, longest_pause_sec: 1, filler_words: 2 },
      suggested_stars: { confident_delivery: 4.5, accent: 4, fluency: 3.5 },
      typing: { wpm: 65, accuracy: 97 },
    },
    'https://voca.ro/abc',
  );
  assert.equal(r.needsManual, false);
  assert.equal(r.confidentDelivery, 4.5);
  assert.equal(r.accent, 4);
  assert.equal(r.fluency, 3.5);
  assert.equal(r.typingStars, 4);
  // speaking average = (4.5+4+3.5)/3 = 4.0, final = 4.0*0.9 + 4*0.1 = 4.0
  assert.equal(r.finalScore, 4.0);
  assert.match(r.comment, /120 WPM/);
  assert.match(r.comment, /65 WPM/);
});

test('buildScorecardData: falls back to recomputing stars when analyze.py did not supply suggested_stars', () => {
  const r = buildScorecardData(
    {
      speech: { word_count: 80, speaking_rate_wpm: 140, unclear_words_percent: 2, duration_sec: 90, pauses_over_1_5s: 0, longest_pause_sec: 2 },
      typing: { wpm: 0, accuracy: null },
    },
    'https://voca.ro/abc',
  );
  assert.equal(r.needsManual, false);
  assert.ok(r.fluency >= 4.5);
  assert.equal(r.typingStars, 0);
});
