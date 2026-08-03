/**
 * Backend script/direction detection — server-side counterpart to
 * frontend/src/utils/textDirection.ts, used to:
 *   1. Give the AI reply generator a deterministic language/direction hint
 *      (the LLM still identifies the exact language itself — this hint
 *      narrows ambiguity and lets us verify its output).
 *   2. Detect language/script MISMATCH between the customer's message and
 *      the AI-generated reply, so we can self-correct instead of silently
 *      sending an English reply to a non-English customer.
 *   3. Set dir="rtl"/"ltr"/"auto" on outbound email HTML so RTL languages
 *      (Urdu, Arabic, Persian, Hebrew) render correctly in Gmail/Outlook,
 *      not just inside the LeadFlow Inbox UI.
 *
 * Pure Unicode code-point math — no external dependency, no LLM call.
 * Never reorders or rewrites text.
 */

const RTL_RANGES = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic (covers Arabic, Persian/Farsi, Urdu)
  [0x0700, 0x074f], // Syriac
  [0x0750, 0x077f], // Arabic Supplement
  [0x0780, 0x07bf], // Thaana
  [0x07c0, 0x07ff], // NKo / Samaritan / Mandaic
  [0x0800, 0x083f], // Samaritan
  [0x0840, 0x085f], // Mandaic
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb1d, 0xfb4f], // Hebrew presentation forms
  [0xfb50, 0xfdff], // Arabic presentation forms A
  [0xfe70, 0xfeff], // Arabic presentation forms B
];

/** Script family ranges used to build a language hint + detect mismatches. */
const SCRIPT_RANGES = [
  { key: 'hebrew', ranges: [[0x0590, 0x05ff], [0xfb1d, 0xfb4f]] },
  { key: 'arabic', ranges: [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]] },
  { key: 'devanagari', ranges: [[0x0900, 0x097f]] },
  { key: 'cyrillic', ranges: [[0x0400, 0x04ff], [0x0500, 0x052f]] },
  { key: 'greek', ranges: [[0x0370, 0x03ff]] },
  { key: 'hangul', ranges: [[0x1100, 0x11ff], [0xac00, 0xd7af]] },
  { key: 'hiragana_katakana', ranges: [[0x3040, 0x309f], [0x30a0, 0x30ff]] },
  { key: 'cjk', ranges: [[0x4e00, 0x9fff], [0x3400, 0x4dbf]] },
  { key: 'thai', ranges: [[0x0e00, 0x0e7f]] },
  { key: 'latin', ranges: [[0x0041, 0x005a], [0x0061, 0x007a], [0x00c0, 0x024f], [0x1e00, 0x1eff]] },
];

function isInRange(codePoint, ranges) {
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}

function isRtlCodePoint(codePoint) {
  return isInRange(codePoint, RTL_RANGES);
}

function scriptFamilyOf(codePoint) {
  for (const { key, ranges } of SCRIPT_RANGES) {
    if (isInRange(codePoint, ranges)) return key;
  }
  return null;
}

/** Strip HTML for analysis only — never used for display. */
function stripTagsForAnalysis(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Analyze text and return direction + dominant script family + a rough
 * per-script character count breakdown (for mismatch comparisons).
 */
function analyzeScript(text, sampleLimit = 8000) {
  const sample = String(text || '').slice(0, sampleLimit);
  let rtl = 0;
  let ltr = 0;
  const counts = {};

  for (let i = 0; i < sample.length; ) {
    const cp = sample.codePointAt(i);
    if (cp === undefined) break;
    i += cp > 0xffff ? 2 : 1;
    if (cp <= 0x20 || cp === 0x7f) continue;

    if (isRtlCodePoint(cp)) rtl += 1;
    const family = scriptFamilyOf(cp);
    if (family) {
      counts[family] = (counts[family] || 0) + 1;
      if (family === 'latin' || family === 'cyrillic' || family === 'greek' || family === 'devanagari'
        || family === 'hangul' || family === 'hiragana_katakana' || family === 'cjk' || family === 'thai') {
        ltr += 1;
      }
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  let dominantScript = null;
  let dominantCount = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (count > dominantCount) {
      dominantScript = key;
      dominantCount = count;
    }
  }

  let direction = 'auto';
  if (rtl > 0 && ltr === 0) direction = 'rtl';
  else if (ltr > 0 && rtl === 0) direction = 'ltr';
  else if (rtl === 0 && ltr === 0) direction = 'auto';
  else direction = 'auto'; // mixed content — let the browser/BiDi algorithm resolve it

  return { direction, dominantScript, total, counts };
}

function detectTextDirection(text) {
  return analyzeScript(text).direction;
}

function detectHtmlDirection(html) {
  const explicit = String(html || '').slice(0, 4000).match(/\bdir\s*=\s*["']?(rtl|ltr|auto)\b/i);
  if (explicit) return explicit[1].toLowerCase();
  return detectTextDirection(stripTagsForAnalysis(html));
}

/**
 * Human-readable script-family hint for the AI prompt. This intentionally
 * does NOT claim a precise language (Urdu vs Arabic vs Persian share the
 * same script) — the LLM identifies the exact language from the message
 * itself far more reliably than script heuristics can. This hint only
 * narrows the search space and gives the model a concrete anchor.
 */
const SCRIPT_HINT_LABELS = {
  arabic: 'Arabic-script (this may be Arabic, Urdu, Persian/Farsi, or another Arabic-script language)',
  hebrew: 'Hebrew',
  devanagari: 'Devanagari-script (e.g. Hindi)',
  cyrillic: 'Cyrillic-script (e.g. Russian)',
  greek: 'Greek',
  hangul: 'Korean (Hangul)',
  hiragana_katakana: 'Japanese (Hiragana/Katakana)',
  cjk: 'Chinese (or CJK ideographs)',
  thai: 'Thai',
  latin: 'Latin-script (e.g. English, German, Portuguese, French, Spanish, Turkish)',
};

function detectScriptHintLabel(text) {
  const { dominantScript, total } = analyzeScript(text);
  if (!dominantScript || total === 0) return null;
  return SCRIPT_HINT_LABELS[dominantScript] || null;
}

/**
 * Compare the customer's message script against the AI-generated reply's
 * script. Returns true when the reply is clearly the wrong script family
 * (e.g. customer wrote in Arabic/Urdu script, reply came back pure Latin).
 * Used to trigger a single corrective retry — never used to rewrite text.
 */
function isLikelyLanguageMismatch(customerText, replyText) {
  const customer = analyzeScript(customerText);
  const reply = analyzeScript(replyText);
  if (!customer.dominantScript || customer.total < 3) return false; // too short/ambiguous to judge
  if (customer.dominantScript === 'latin') return false; // Latin-script replies are expected for Latin-script input (English/German/etc.)
  if (!reply.dominantScript || reply.total < 3) return false;
  return reply.dominantScript !== customer.dominantScript;
}

module.exports = {
  analyzeScript,
  detectTextDirection,
  detectHtmlDirection,
  detectScriptHintLabel,
  isLikelyLanguageMismatch,
  stripTagsForAnalysis,
};
