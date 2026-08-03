/**
 * Workspace AI Sales Agent configuration defaults and prompt helpers.
 */

const DEFAULT_AI_AGENT_CONFIG = {
  businessName: '',
  companyDescription: '',
  products: '',
  services: '',
  pricing: '',
  features: '',
  offers: '',
  promotions: '',
  faqs: '',
  objectionHandling: '',
  salesTone: 'professional and friendly',
  writingStyle: 'concise, clear, and helpful',
  languages: ['English'],
  callToAction: '',
  companyPolicies: '',
  appointmentInstructions: '',
  supportInfo: '',
  emailAutoReplyEnabled: true,
  whatsappAutoReplyEnabled: true,
  humanTakeoverKeywords: ['human', 'agent', 'call me', 'speak to someone', 'representative'],
};

const CRITICAL_KNOWLEDGE_FIELDS = ['companyDescription', 'products', 'services', 'pricing'];
const SUPPORTING_KNOWLEDGE_FIELDS = ['faqs', 'objectionHandling', 'companyPolicies', 'offers', 'promotions', 'features'];

function isFilled(value) {
  return Boolean(String(value || '').trim());
}

function mergeAiAgentConfig(input = {}, user = null, options = {}) {
  const merged = {
    ...DEFAULT_AI_AGENT_CONFIG,
    ...(input || {}),
  };
  if (!merged.businessName && user?.business_name) merged.businessName = user.business_name;
  if (!merged.businessName && user?.businessName) merged.businessName = user.businessName;
  if (!Array.isArray(merged.languages)) {
    merged.languages = merged.languages ? [String(merged.languages)] : DEFAULT_AI_AGENT_CONFIG.languages;
  }
  if (typeof merged.emailAutoReplyEnabled !== 'boolean') {
    merged.emailAutoReplyEnabled = DEFAULT_AI_AGENT_CONFIG.emailAutoReplyEnabled;
  }
  if (typeof merged.whatsappAutoReplyEnabled !== 'boolean') {
    merged.whatsappAutoReplyEnabled = DEFAULT_AI_AGENT_CONFIG.whatsappAutoReplyEnabled;
  }
  return merged;
}

function hasKnowledgeForTopic(config, topic) {
  const cfg = mergeAiAgentConfig(config, null, { skipAutoFill: true });
  const t = String(topic || '').toLowerCase();
  if (t === 'pricing' || t === 'cost') return isFilled(cfg.pricing);
  if (t === 'products') return isFilled(cfg.products);
  if (t === 'services') return isFilled(cfg.services);
  if (t === 'offers' || t === 'promotions' || t === 'discount') {
    return isFilled(cfg.offers) || isFilled(cfg.promotions);
  }
  if (t === 'policies' || t === 'shipping' || t === 'returns') return isFilled(cfg.companyPolicies);
  if (t === 'appointment' || t === 'scheduling') return isFilled(cfg.appointmentInstructions);
  if (t === 'support') return isFilled(cfg.supportInfo);
  if (t === 'features') return isFilled(cfg.features);
  if (t === 'faqs' || t === 'info') {
    return isFilled(cfg.faqs) || isFilled(cfg.companyDescription) || isFilled(cfg.products) || isFilled(cfg.services);
  }
  return isFilled(cfg.companyDescription) || isFilled(cfg.products) || isFilled(cfg.services);
}

function assessAiKnowledgeStatus(config = {}, user = null) {
  const cfg = mergeAiAgentConfig(config, user, { skipAutoFill: true });
  const criticalFilled = CRITICAL_KNOWLEDGE_FIELDS.filter((key) => isFilled(cfg[key])).length;
  const supportingFilled = SUPPORTING_KNOWLEDGE_FIELDS.filter((key) => isFilled(cfg[key])).length;
  const hasIdentity = isFilled(cfg.businessName);
  const score = criticalFilled + (hasIdentity ? 1 : 0) + Math.min(supportingFilled, 2);

  if (criticalFilled >= 3 && hasIdentity && (isFilled(cfg.pricing) || isFilled(cfg.products) || isFilled(cfg.services))) {
    return {
      status: 'complete',
      level: 'complete',
      label: 'Business Knowledge Complete',
      icon: '🟢',
      message: 'The AI has enough configured business knowledge to answer customers accurately.',
      criticalFilled,
      supportingFilled,
    };
  }

  if (criticalFilled >= 1 || hasIdentity) {
    return {
      status: 'partial',
      level: 'partial',
      label: 'AI Knowledge Partial',
      icon: '🟡',
      message: 'Some business fields are still empty. The AI will avoid guessing and may defer to a human for missing topics.',
      criticalFilled,
      supportingFilled,
    };
  }

  return {
    status: 'missing',
    level: 'missing',
    label: 'AI Knowledge Missing',
    icon: '🟡',
    message: 'Configure your AI Sales Agent profile before relying on automatic replies. The AI will not invent prices, offers, or product details.',
    criticalFilled,
    supportingFilled,
  };
}

/**
 * Best-effort localized professional deferral templates — used ONLY when no
 * OpenAI key is configured (pure heuristic mode). Never exposes "not
 * configured", "I don't know", or any internal/system language. When OpenAI
 * IS available, the deferral message is generated dynamically in the exact
 * language the customer used (see buildAiAgentSystemPrompt) — this table is
 * a safety net for the offline/no-AI-key path only.
 *
 * Keyed by script family (see utils/languageDetection.js) since that is all
 * a deterministic heuristic can reliably distinguish; Arabic-script input
 * (Arabic/Urdu/Persian) falls back to the Arabic phrasing below, which is
 * intelligible as a formal, generic message even to Urdu/Farsi readers.
 * Precise per-language phrasing is handled by the AI path above.
 */
const DEFERRAL_TEMPLATES = {
  latin: (name) => `Thank you for contacting ${name}. We have received your message and forwarded it to our support team. They will contact you as soon as possible with complete information. Thank you for your patience.`,
  arabic: (name) => `شكراً لتواصلكم مع ${name}. لقد استلمنا رسالتكم وقمنا بإحالتها إلى فريق الدعم الخاص بنا. سيتواصل معكم فريقنا في أقرب وقت ممكن بالمعلومات الكاملة. نشكركم على صبركم.`,
  hebrew: (name) => `תודה שפניתם אל ${name}. קיבלנו את הודעתכם והעברנו אותה לצוות התמיכה שלנו. הצוות שלנו יחזור אליכם בהקדם האפשרי עם כל המידע. תודה על הסבלנות.`,
  cyrillic: (name) => `Спасибо за обращение в ${name}. Мы получили ваше сообщение и передали его в нашу команду поддержки. Наша команда свяжется с вами как можно скорее с полной информацией. Благодарим за терпение.`,
  devanagari: (name) => `${name} से संपर्क करने के लिए धन्यवाद। हमें आपका संदेश मिल गया है और इसे हमारी सहायता टीम को भेज दिया गया है। हमारी टीम पूरी जानकारी के साथ जल्द से जल्द आपसे संपर्क करेगी। आपके धैर्य के लिए धन्यवाद।`,
  cjk: (name) => `感谢您联系${name}。我们已收到您的消息，并已转交给我们的支持团队。我们的团队会尽快与您联系并提供完整信息。感谢您的耐心等待。`,
  hiragana_katakana: (name) => `${name}にお問い合わせいただき、ありがとうございます。お問い合わせを受け付け、サポートチームに転送いたしました。担当者より詳細情報とともに、できるだけ早くご連絡いたします。ご不便をおかけしますが、よろしくお願いいたします。`,
  hangul: (name) => `${name}에 문의해 주셔서 감사합니다. 문의하신 내용을 접수하여 지원팀에 전달했습니다. 담당자가 곧 자세한 정보와 함께 연락드릴 예정입니다. 기다려 주셔서 감사합니다.`,
};

function buildMissingKnowledgeReply(topic, config = {}, options = {}) {
  const cfg = mergeAiAgentConfig(config, null, { skipAutoFill: true });
  const name = cfg.businessName || 'our team';
  const scriptFamily = options.scriptFamily || 'latin';
  const template = DEFERRAL_TEMPLATES[scriptFamily] || DEFERRAL_TEMPLATES.latin;
  return template(name);
}

function buildAiAgentSystemPrompt(config = {}, options = {}) {
  const cfg = mergeAiAgentConfig(config, null, { skipAutoFill: true });
  const sections = [];
  const knowledgeStatus = assessAiKnowledgeStatus(cfg);
  const scriptHint = options.customerScriptHint || null;

  sections.push(`You are the AI Sales Agent for ${cfg.businessName || 'this business'}.`);
  sections.push('You reply to customer emails on behalf of the business. Be helpful, trustworthy, and action-oriented.');
  sections.push(`Tone: ${cfg.salesTone}. Writing style: ${cfg.writingStyle}.`);

  sections.push('');
  sections.push('LANGUAGE RULES — NEVER VIOLATE:');
  sections.push('- Detect the language of the customer\'s most recent message yourself, directly from its text. Reply ENTIRELY in that same language.');
  sections.push('- Do NOT default to English. Do NOT translate the customer\'s message for them or explain what language they used — just write your whole reply in it.');
  sections.push('- Follow that language\'s own grammar, punctuation, honorifics, and writing-direction conventions (e.g. Urdu/Arabic/Persian/Hebrew are right-to-left).');
  sections.push('- If the customer mixes languages (e.g. a product name or number in English inside an otherwise Urdu message), mirror that same mixing style naturally rather than forcing everything into one language.');
  sections.push('- Only reply in a different language than the customer\'s message if they explicitly ask you to.');
  if (scriptHint) {
    sections.push(`- Hint: the customer's message appears to be written in ${scriptHint}. Confirm the exact language yourself from the message and reply in it.`);
  }
  if (cfg.languages?.length) sections.push(`- Business-preferred languages (used only when the customer's own language is unclear or the thread has no prior message): ${cfg.languages.join(', ')}.`);

  sections.push('');
  sections.push('CRITICAL ACCURACY RULES — NEVER VIOLATE:');
  sections.push('- Use ONLY the verified business knowledge listed below. Never invent, estimate, or assume prices, offers, discounts, product specs, policies, shipping terms, or availability.');
  sections.push('- If the customer asks about pricing, products, services, offers, policies, shipping, or discounts and that information is NOT listed below, do NOT say the information is missing, not configured, or unavailable, and do NOT say "I don\'t know" or "I cannot answer". Instead, respond with a warm, professional customer-service message: thank them for contacting the business, confirm their message has been received and forwarded to the support team, and that the team will follow up shortly with complete information.');
  sections.push('- Do not use placeholder numbers, example pricing, or generic marketing claims.');
  sections.push('- Never claim discounts, promotions, or guarantees unless explicitly listed below.');
  sections.push('- The customer must never feel like the AI failed or is limited — the deferral message above should read like normal, confident customer service, not an apology for missing data.');

  sections.push('');
  sections.push('requiresHuman FIELD RULES — be precise, this controls internal CRM routing, NOT whether your reply gets sent (it is always sent):');
  sections.push('- Set requiresHuman to FALSE whenever you successfully answered the customer\'s actual question using the verified business knowledge below — even if you also mention that a team member can share extra details, book something, or process an order.');
  sections.push('- Set requiresHuman to TRUE only when you could NOT answer the customer\'s core question because the needed information is not in the verified knowledge below, or the customer explicitly asked for a human/manager/phone call, or the message needs a judgment call a human should make (complaint, legal, refund dispute, unusual bulk/custom request).');
  sections.push('- requiresHuman must depend only on whether the question was actually answerable — never on what language the customer wrote in, and never "true by default".');

  sections.push('');
  sections.push('VERIFIED BUSINESS KNOWLEDGE (only source of truth):');
  if (cfg.companyDescription) sections.push(`Company description: ${cfg.companyDescription}`);
  if (cfg.products) sections.push(`Products: ${cfg.products}`);
  if (cfg.services) sections.push(`Services: ${cfg.services}`);
  if (cfg.pricing) sections.push(`Pricing: ${cfg.pricing}`);
  if (cfg.features) sections.push(`Features: ${cfg.features}`);
  if (cfg.offers) sections.push(`Offers: ${cfg.offers}`);
  if (cfg.promotions) sections.push(`Promotions: ${cfg.promotions}`);
  if (cfg.faqs) sections.push(`FAQs: ${cfg.faqs}`);
  if (cfg.objectionHandling) sections.push(`Objection handling guidance: ${cfg.objectionHandling}`);
  if (cfg.callToAction) sections.push(`Preferred call-to-action: ${cfg.callToAction}`);
  if (cfg.companyPolicies) sections.push(`Company policies: ${cfg.companyPolicies}`);
  if (cfg.appointmentInstructions) sections.push(`Appointment booking instructions: ${cfg.appointmentInstructions}`);
  if (cfg.supportInfo) sections.push(`Support information: ${cfg.supportInfo}`);

  if (knowledgeStatus.level !== 'complete') {
    sections.push('');
    sections.push('KNOWLEDGE STATUS: Incomplete — defer to a human for any topic not explicitly listed above.');
  }

  sections.push('');
  sections.push('Keep email replies short (2-5 sentences) unless the customer asks for detail.');
  sections.push('If the customer requests a human, manager, or phone call, respond with the same warm professional deferral described above (received, forwarded to the team, will follow up soon) in the customer\'s own language, and set requiresHuman to true. Do not pretend to be human.');
  sections.push('Return JSON with keys: { "body": "your reply, written entirely in the customer\'s detected language", "intent": "detected intent", "context": "brief context", "requiresHuman": false }');

  return sections.join('\n');
}

function shouldHandoffToHuman(text, config = {}) {
  const cfg = mergeAiAgentConfig(config);
  const lower = String(text || '').toLowerCase();
  return (cfg.humanTakeoverKeywords || []).some((kw) => lower.includes(String(kw).toLowerCase()));
}

function intentRequiresKnowledge(intent) {
  return ['pricing', 'info', 'online_presence', 'interested'].includes(intent);
}

function knowledgeTopicForIntent(intent) {
  if (intent === 'pricing') return 'pricing';
  if (intent === 'info') return 'info';
  if (intent === 'interested') return 'products';
  return 'info';
}

module.exports = {
  DEFAULT_AI_AGENT_CONFIG,
  CRITICAL_KNOWLEDGE_FIELDS,
  mergeAiAgentConfig,
  buildAiAgentSystemPrompt,
  shouldHandoffToHuman,
  assessAiKnowledgeStatus,
  hasKnowledgeForTopic,
  buildMissingKnowledgeReply,
  intentRequiresKnowledge,
  knowledgeTopicForIntent,
  isFilled,
};
