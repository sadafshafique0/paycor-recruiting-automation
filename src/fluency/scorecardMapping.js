// Pure scoring/mapping logic — no I/O, no Paycor, no Python. Ports the fixed rules from
// Paycor-fluency/fluency/scoring.py (suggest_speaking, typing_stars, final_score) and the field
// mapping documented in Paycor-full-package/.claude/commands/paycor-fluency.md, so this project
// doesn't re-derive the calibration that already exists and is tested there
// (Paycor-fluency/tests/test_calibration.py). To recalibrate, change the bands in BOTH places,
// or point runFluencyScorer.js's consumer solely at scoring.py's own suggested_stars and treat
// this file as just final-score arithmetic + field formatting — see the comment on
// buildScorecardData's `speech.suggested_stars` passthrough below.

const WPM_THRESHOLDS = [[70, 5], [60, 4], [50, 3], [40, 2], [30, 1]];
const MIN_ACCURACY = 93.0;
const SPEAKING_WEIGHT = 0.9;
const TYPING_WEIGHT = 0.1;

function typingStars(wpm, accuracy) {
  if (!wpm) {
    return { wpm: 0, accuracy: accuracy ?? null, stars: 0, note: 'No typing test result provided.' };
  }
  let stars = 0;
  for (const [threshold, s] of WPM_THRESHOLDS) {
    if (wpm >= threshold) {
      stars = s;
      break;
    }
  }
  let note = '';
  if (accuracy == null) {
    note = 'Typing accuracy not found on the result; rated on WPM only.';
  } else if (accuracy < MIN_ACCURACY) {
    note = `Typing: Disqualified - accuracy ${accuracy}% is below the ${MIN_ACCURACY}% minimum (0 stars).`;
    stars = 0;
  }
  return { wpm, accuracy: accuracy ?? null, stars, note };
}

function finalScore(confident, accent, fluency, typing) {
  const speakingAverage = (confident + accent + fluency) / 3;
  return {
    speakingAverage: Math.round(speakingAverage * 100) / 100,
    finalScore: Math.round((speakingAverage * SPEAKING_WEIGHT + typing * TYPING_WEIGHT) * 10) / 10,
  };
}

const RATE_BANDS = [[135, 5], [128, 4], [120, 3.5], [110, 3], [100, 2.5], [95, 2], [85, 1.5]];
const UNCLEAR_BANDS = [[3, 5], [5, 4.5], [7, 4], [9, 3.5], [11, 3], [13, 2.5], [15, 2], [18, 1.5]];

function half(x) {
  return Math.max(1, Math.min(5, Math.floor(x * 2 + 0.5) / 2));
}

/**
 * @param {{speaking_rate_wpm: number, unclear_words_percent: number, duration_sec: number,
 *          pauses_over_1_5s: number, longest_pause_sec: number}} m - analyze.py's `speech` block
 */
function suggestSpeaking(m) {
  const rate = m.speaking_rate_wpm;
  const unclear = m.unclear_words_percent;
  const minutes = Math.max(m.duration_sec / 60, 0.1);

  let rateStars = 1.0;
  for (const [t, s] of RATE_BANDS) {
    if (rate >= t) {
      rateStars = s;
      break;
    }
  }
  let clearStars = 1.0;
  for (const [t, s] of UNCLEAR_BANDS) {
    if (unclear <= t) {
      clearStars = s;
      break;
    }
  }

  let fluency = rateStars;
  if (m.pauses_over_1_5s / minutes >= 3.5) fluency -= 0.5;
  if (m.longest_pause_sec >= 15) fluency -= 1;
  if (unclear >= 11.5 && rate < 130) fluency = Math.min(fluency, 2);
  fluency = half(fluency);

  const accent = half((clearStars + rateStars) / 2);
  const confidentDelivery = half((fluency + accent) / 2);
  return { confidentDelivery, accent, fluency };
}

function buildComment({ speech, typing }) {
  const parts = [];
  if (speech && speech.word_count) {
    parts.push(`Speaks at ~${Math.round(speech.speaking_rate_wpm)} WPM` + (speech.unclear_words_percent <= 7 ? '; clear and easily understood.' : '; some words were hard to make out.'));
    if (speech.filler_words) parts.push(`${speech.filler_words} filler word(s) noted (not penalized).`);
  } else {
    parts.push('Speaking could not be rated — no usable recording.');
  }
  if (typing && typing.wpm) {
    parts.push(`Typing: ${typing.wpm} WPM, ${typing.accuracy != null ? typing.accuracy + '% accuracy' : 'accuracy unknown'} (${typing.stars}★).`);
    if (typing.note) parts.push(typing.note);
  } else {
    parts.push('No typing test on file (0★).');
  }
  return parts.join(' ');
}

/**
 * Combines analyze.py's JSON output + the Vocaroo link into everything
 * src/paycor-actions.js's fillFluencyScorecard needs, or flags needsManual per the fluency
 * command's own safety rule: never submit a scorecard where speaking couldn't be rated.
 *
 * @param {object} analyzeOutput - parsed stdout of Paycor-fluency/analyze.py
 * @param {string|null} vocarooLink
 */
function buildScorecardData(analyzeOutput, vocarooLink) {
  const speech = analyzeOutput.speech || {};
  const typing = typingStars(analyzeOutput.typing?.wpm, analyzeOutput.typing?.accuracy);

  if (!vocarooLink || speech.error || !speech.word_count) {
    return {
      needsManual: true,
      needsManualReason: !vocarooLink
        ? 'No Vocaroo link found in the candidate Newsfeed reply'
        : speech.error
          ? `Speech analysis failed: ${speech.error}`
          : 'Transcription produced no words — recording may be silent, dead link, or unreadable',
      vocarooLink,
      typing,
    };
  }

  // Use the analyzer's own suggested_stars if present (keeps this in sync with whatever
  // calibration Paycor-fluency/fluency/scoring.py currently ships, including any tuning done
  // there after this file was written); otherwise recompute with the ported rules above.
  const stars = analyzeOutput.suggested_stars
    ? {
        confidentDelivery: analyzeOutput.suggested_stars.confident_delivery,
        accent: analyzeOutput.suggested_stars.accent,
        fluency: analyzeOutput.suggested_stars.fluency,
      }
    : suggestSpeaking(speech);

  const { speakingAverage, finalScore: score } = finalScore(stars.confidentDelivery, stars.accent, stars.fluency, typing.stars);

  return {
    needsManual: false,
    vocarooLink,
    typingWpm: typing.wpm,
    typingAccuracy: typing.accuracy,
    typingStars: typing.stars,
    confidentDelivery: stars.confidentDelivery,
    accent: stars.accent,
    fluency: stars.fluency,
    speakingAverage,
    finalScore: score,
    comment: buildComment({ speech, typing }),
  };
}

module.exports = { typingStars, finalScore, suggestSpeaking, buildComment, buildScorecardData, MIN_ACCURACY, WPM_THRESHOLDS };
