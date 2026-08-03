/**
 * Unicode-based text direction and language hints for BiDi rendering.
 *
 * Does NOT reorder or reverse strings — only classifies content so the browser
 * can apply the Unicode Bidirectional Algorithm (UAX #9) via dir + CSS.
 */

export type TextDirection = 'rtl' | 'ltr' | 'auto';

type CodeRange = readonly [start: number, end: number];

/** Strong RTL scripts (Arabic, Hebrew, Persian, Urdu, etc.) */
const RTL_RANGES: readonly CodeRange[] = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic (Urdu, Persian, Arabic)
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

/** Strong LTR scripts used across LeadFlow markets */
const LTR_RANGES: readonly CodeRange[] = [
  [0x0041, 0x005a],
  [0x0061, 0x007a],
  [0x00c0, 0x024f], // Latin extended
  [0x1e00, 0x1eff], // Latin extended additional
  [0x0400, 0x04ff], // Cyrillic (Russian, etc.)
  [0x0500, 0x052f],
  [0x0370, 0x03ff], // Greek
  [0x0100, 0x017f], // Latin extended A (Turkish, etc.)
  [0x0900, 0x097f], // Devanagari (Hindi)
  [0x0980, 0x09ff], // Bengali
  [0x0a00, 0x0a7f], // Gurmukhi
  [0x0b00, 0x0b7f], // Oriya
  [0x0c00, 0x0c7f], // Telugu
  [0x0d00, 0x0d7f], // Malayalam
  [0x0e00, 0x0e7f], // Thai
  [0x1100, 0x11ff], // Hangul Jamo (Korean)
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0x3400, 0x4dbf], // CJK Extension A
  [0xac00, 0xd7af], // Hangul syllables
];

const HTML_TAG_RE = /<(html|body|div|p|span|img|table|a|b|strong|i|em|br|h[1-6]|ul|ol|li|style|meta|head)[^>]*>/i;

function isInRange(codePoint: number, ranges: readonly CodeRange[]): boolean {
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Strip HTML for direction analysis only — never used for display. */
export function stripTagsForAnalysis(html: string): string {
  return decodeBasicEntities(
    String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function looksLikeHtml(content: string): boolean {
  return HTML_TAG_RE.test(String(content || '').trim());
}

export function detectTextDirection(text: string, sampleLimit = 12000): TextDirection {
  const sample = String(text || '').slice(0, sampleLimit);
  let rtl = 0;
  let ltr = 0;

  for (let i = 0; i < sample.length; ) {
    const codePoint = sample.codePointAt(i);
    if (codePoint === undefined) break;
    i += codePoint > 0xffff ? 2 : 1;

    if (codePoint <= 0x20 || codePoint === 0x7f) continue;
    if (/\p{White_Space}/u.test(String.fromCodePoint(codePoint))) continue;

    if (isInRange(codePoint, RTL_RANGES)) rtl += 1;
    else if (isInRange(codePoint, LTR_RANGES)) ltr += 1;
  }

  if (rtl === 0 && ltr === 0) return 'auto';
  if (rtl > 0 && ltr === 0) return 'rtl';
  if (ltr > 0 && rtl === 0) return 'ltr';
  // Mixed content: prefer auto so UBA resolves English/numbers inside RTL runs correctly.
  if (rtl > 0 && ltr > 0) return 'auto';
  if (rtl > ltr) return 'rtl';
  return 'ltr';
}

/** Read explicit dir= from HTML fragment when present (email clients often set this). */
export function detectExplicitHtmlDirection(html: string): TextDirection | null {
  const match = String(html || '').slice(0, 4000).match(/\bdir\s*=\s*["']?(rtl|ltr|auto)\b/i);
  if (!match) return null;
  const value = match[1].toLowerCase();
  if (value === 'rtl' || value === 'ltr' || value === 'auto') return value;
  return null;
}

export function detectHtmlDirection(html: string): TextDirection {
  return detectExplicitHtmlDirection(html) || detectTextDirection(stripTagsForAnalysis(html));
}

/** Optional lang hint from dominant script — helps screen readers; BiDi uses dir. */
export function detectLanguageHint(text: string): string | undefined {
  const sample = String(text || '').slice(0, 8000);
  let hebrew = 0;
  let arabicScript = 0;
  let cyrillic = 0;
  let cjk = 0;
  let hangul = 0;
  let kana = 0;
  let devanagari = 0;
  let latin = 0;

  for (let i = 0; i < sample.length; ) {
    const cp = sample.codePointAt(i);
    if (cp === undefined) break;
    i += cp > 0xffff ? 2 : 1;
    if (cp >= 0x0590 && cp <= 0x05ff) hebrew += 1;
    else if (cp >= 0x0600 && cp <= 0x06ff) arabicScript += 1;
    else if (cp >= 0x0400 && cp <= 0x04ff) cyrillic += 1;
    else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) cjk += 1;
    else if (cp >= 0xac00 && cp <= 0xd7af) hangul += 1;
    else if ((cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff)) kana += 1;
    else if (cp >= 0x0900 && cp <= 0x097f) devanagari += 1;
    else if ((cp >= 0x0041 && cp <= 0x005a) || (cp >= 0x0061 && cp <= 0x007a)) latin += 1;
  }

  const ranked: Array<[string, number]> = [
    ['he', hebrew],
    ['ar', arabicScript],
    ['ru', cyrillic],
    ['zh', cjk],
    ['ko', hangul],
    ['ja', kana],
    ['hi', devanagari],
    ['en', latin],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] === 0) return undefined;
  if (ranked[0][0] === 'ar' && arabicScript > 0) {
    // Urdu/Persian share Arabic script — use neutral Arabic script tag when ambiguous.
    return 'und';
  }
  return ranked[0][0];
}

export function resolveContentDirection(content: string, format: 'html' | 'text'): {
  dir: TextDirection;
  lang?: string;
} {
  const plain = format === 'html' ? stripTagsForAnalysis(content) : content;
  const dir = format === 'html' ? detectHtmlDirection(content) : detectTextDirection(content);
  const lang = detectLanguageHint(plain);
  return { dir, lang: lang === 'und' ? undefined : lang };
}
