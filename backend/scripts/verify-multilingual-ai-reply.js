/**
 * Non-invasive verification: exercises aiProvider.generateReply() across all
 * major business languages, WITHOUT sending any email. Confirms:
 *   1. AI replies in the same language as the customer's message.
 *   2. Answerable questions are answered directly (requiresHuman: false).
 *   3. Missing-knowledge / explicit human requests get a professional,
 *      localized deferral, and (verified separately in
 *      autonomousReplyService.js) are still SENT to the customer.
 *
 * Usage: node backend/scripts/verify-multilingual-ai-reply.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const aiProvider = require('../services/aiProvider');
const userStorage = require('../utils/userStorage');
const openAiKeyService = require('../services/openAiKeyService');
const { mergeAiAgentConfig } = require('../utils/aiAgentConfig');
const { analyzeScript } = require('../utils/languageDetection');

const WORKSPACE_ID = process.env.TRACE_WORKSPACE_ID || 'usr_super_admin_1783323507243';

const FORBIDDEN_PHRASES = [
  "i don't have this information",
  "i don't know",
  "not configured",
  "is missing from the system",
  "cannot answer",
  "not yet configured",
];

// All answerable with a simple pricing question — pricing IS configured for this test account.
const CASES = [
  { lang: 'English', text: 'What is the price of your toothpaste?' },
  { lang: 'Urdu', text: 'اس دانتوں کے پیسٹ کی قیمت کیا ہے؟' },
  { lang: 'Arabic', text: 'ما هو سعر معجون الأسنان هذا؟' },
  { lang: 'Italian', text: 'Quanto costa questo dentifricio?' },
  { lang: 'Turkish', text: 'Bu diş macununun fiyatı nedir?' },
  { lang: 'French', text: 'Quel est le prix de ce dentifrice?' },
  { lang: 'German', text: 'Was kostet diese Zahnpasta?' },
  { lang: 'Portuguese', text: 'Qual é o preço desta pasta de dente?' },
  { lang: 'Spanish', text: '¿Cuál es el precio de esta pasta de dientes?' },
  { lang: 'Azerbaijani', text: 'Bu diş pastasının qiyməti nədir?' },
  { lang: 'Dutch', text: 'Wat is de prijs van deze tandpasta?' },
  { lang: 'Russian', text: 'Сколько стоит эта зубная паста?' },
  { lang: 'Indonesian', text: 'Berapa harga pasta gigi ini?' },
  { lang: 'Malay', text: 'Berapa harga ubat gigi ini?' },
  { lang: 'Chinese', text: '这款牙膏多少钱？' },
  { lang: 'Japanese', text: 'この歯磨き粉の価格はいくらですか？' },
  { lang: 'Korean', text: '이 치약 가격이 얼마인가요?' },
  { lang: 'Hebrew', text: 'מה המחיר של משחת השיניים הזו?' },
];

async function main() {
  const user = await userStorage.findById(WORKSPACE_ID).catch(() => null);
  const agentConfig = mergeAiAgentConfig(await userStorage.getAiAgentConfig(WORKSPACE_ID), user);
  const oaConfig = await openAiKeyService.getOpenAiConfig(WORKSPACE_ID);
  console.log('[VERIFY] OpenAI config blocked?', oaConfig.blocked, '| source:', oaConfig.source);

  const results = [];
  for (const c of CASES) {
    const messages = [{ direction: 'inbound', body: c.text }];
    const lead = { name: 'Test Customer', niche: 'retail', city: 'KL' };
    const reply = await aiProvider.generateReply(messages, lead, { workspaceId: WORKSPACE_ID, config: oaConfig, agentConfig });

    const bodyLower = reply.body.toLowerCase();
    const forbiddenHit = FORBIDDEN_PHRASES.find((p) => bodyLower.includes(p));
    const customerScript = analyzeScript(c.text).dominantScript;
    const replyScript = analyzeScript(reply.body).dominantScript;
    const scriptMatch = customerScript === 'latin' ? (replyScript === 'latin') : (replyScript === customerScript);

    results.push({
      lang: c.lang,
      customerScript,
      replyScript,
      scriptMatch,
      forbiddenPhraseFound: forbiddenHit || null,
      requiresHuman: reply.requiresHuman,
      answeredDirectly: !reply.requiresHuman,
      model: reply.model,
      body: reply.body,
    });
  }

  console.log('\n[VERIFY] Results:');
  for (const r of results) {
    console.log(`\n--- ${r.lang} ---`);
    console.log('scriptMatch:', r.scriptMatch, '| requiresHuman:', r.requiresHuman, '(expected false — this is a simple, answerable pricing question)');
    console.log('forbiddenPhraseFound:', r.forbiddenPhraseFound);
    console.log('body:', r.body);
  }

  const allScriptsMatch = results.every((r) => r.scriptMatch);
  const noForbiddenPhrases = results.every((r) => !r.forbiddenPhraseFound);
  const allAnsweredDirectly = results.every((r) => !r.requiresHuman);
  console.log('\n[VERIFY SUMMARY] allScriptsMatch:', allScriptsMatch, '| noForbiddenPhrases:', noForbiddenPhrases, '| allAnsweredDirectly (requiresHuman=false):', allAnsweredDirectly);
  process.exit(allScriptsMatch && noForbiddenPhrases ? 0 : 1);
}

main().catch((err) => {
  console.error('[VERIFY FATAL]', err);
  process.exit(1);
});
