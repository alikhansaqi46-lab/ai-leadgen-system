/**
 * Context-aware reply generation (S5.3 extension).
 *
 * Analyzes conversation history + lead profile to generate a relevant reply.
 * Heuristic mode uses intent detection + templates with strict knowledge guards.
 */

const {
  mergeAiAgentConfig,
  hasKnowledgeForTopic,
  buildMissingKnowledgeReply,
  intentRequiresKnowledge,
  knowledgeTopicForIntent,
} = require('../utils/aiAgentConfig');
const { analyzeScript } = require('../utils/languageDetection');

function firstName(name) {
  const n = String(name || '').trim();
  if (!n) return 'there';
  return n.split(/\s+/)[0];
}

function detectIntent(lastMessage) {
  const text = String(lastMessage?.body || '').toLowerCase();
  if (text.includes('price') || text.includes('cost') || text.includes('how much') || text.includes('pricing')) return 'pricing';
  if (text.includes('discount') || text.includes('promo') || text.includes('offer')) return 'offers';
  if (text.includes('ship') || text.includes('delivery') || text.includes('return policy') || text.includes('refund')) return 'policies';
  if (text.includes('time') || text.includes('schedule') || text.includes('call') || text.includes('meet') || text.includes('available') || text.includes('slot') || text.includes('appointment')) return 'scheduling';
  if (text.includes('interested') || text.includes('yes') || text.includes('tell me more') || text.includes('sounds good')) return 'interested';
  if (text.includes('not interested') || text.includes('no thanks') || text.includes('stop') || text.includes('unsubscribe')) return 'uninterested';
  if (text.includes('thank') || text.includes('thanks')) return 'gratitude';
  if (text.includes('help') || text.includes('what do you do') || text.includes('services') || text.includes('product')) return 'info';
  if (text.includes('hi') || text.includes('hello') || text.includes('hey')) return 'greeting';
  if (text.includes('bye') || text.includes('goodbye')) return 'farewell';
  if (text.includes('website') || text.includes('online') || text.includes('google')) return 'online_presence';
  return 'general';
}

function buildReply(intent, lead, conversation, agentConfig = {}) {
  const cfg = mergeAiAgentConfig(agentConfig, null, { skipAutoFill: true });
  const hi = firstName(lead?.name);
  const niche = String(lead?.niche || lead?.category || 'business').trim().toLowerCase();
  const city = String(lead?.city || '').trim();
  const location = city || 'your area';
  const business = cfg.businessName || lead?.name || 'our team';

  if (intent === 'scheduling') {
    if (!hasKnowledgeForTopic(cfg, 'appointment')) {
      return buildMissingKnowledgeReply('appointment', cfg, { scriptFamily: conversation?.scriptFamily || 'latin' });
    }
    return `Hi ${hi}, thank you for reaching out. ${cfg.appointmentInstructions} Please let us know what time works best for you.`;
  }

  const templates = {
    greeting: [
      `Hi ${hi}! Thanks for reaching out to ${business}. How can we help you today?`,
      `Hello ${hi}! Great to hear from you. What would you like to know about ${business}?`,
    ],
    scheduling: [
      `Hi ${hi}, I'd love to help schedule a time to connect. What day works best for you?`,
    ],
    interested: [
      `Thanks for your interest, ${hi}! What would be most helpful for you to learn about ${business}?`,
      `Great to hear from you, ${hi}. What specific outcome are you looking for?`,
    ],
    uninterested: [
      `No worries at all, ${hi}. Totally understand. If anything changes, feel free to reach out anytime.`,
      `Thanks for letting me know, ${hi}. We'll leave you be, but we're here if you ever want to chat.`,
    ],
    gratitude: [
      `You're very welcome, ${hi}! Let us know if there's anything else we can help with.`,
      `Anytime, ${hi}! We appreciate your message.`,
    ],
    info: [
      `Hi ${hi}, thanks for your question. Could you share a bit more about what you're looking for so we can point you in the right direction?`,
    ],
    online_presence: [
      `Hi ${hi}, thanks for reaching out. Could you tell us a little more about what you're hoping to improve online?`,
    ],
    farewell: [
      `Goodbye, ${hi}! Have a wonderful day. Feel free to message us anytime.`,
    ],
    general: [
      `Hi ${hi}, thanks for your message! Could you share a bit more about what you're looking for?`,
      `Appreciate you reaching out, ${hi}. What would be most helpful for you right now?`,
    ],
  };

  const options = templates[intent] || templates.general;
  const idx = (conversation?.messageCount || 0) % options.length;
  return options[idx];
}

/**
 * Generate a context-aware reply for a conversation.
 * @param {Array} messages - conversation messages (oldest first)
 * @param {Object} lead - lead profile
 * @param {Object} options - { agentConfig? }
 */
function generateReply(messages, lead, options = {}) {
  const agentConfig = options.agentConfig || {};
  const cfg = mergeAiAgentConfig(agentConfig, null, { skipAutoFill: true });
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
  const intent = detectIntent(lastInbound);
  const scriptFamily = analyzeScript(lastInbound?.body || '').dominantScript || 'latin';

  if (intentRequiresKnowledge(intent)) {
    const topic = knowledgeTopicForIntent(intent);
    if (!hasKnowledgeForTopic(cfg, topic)) {
      return {
        body: buildMissingKnowledgeReply(topic, cfg, { scriptFamily }),
        intent,
        requiresHuman: true,
        model: 'heuristic',
        context: {
          lastMessage: lastInbound?.body || null,
          messageCount: messages.length,
          leadName: lead?.name || null,
          knowledgeGuard: true,
        },
      };
    }
  }

  if (intent === 'pricing' && !hasKnowledgeForTopic(cfg, 'pricing')) {
    return {
      body: buildMissingKnowledgeReply('pricing', cfg, { scriptFamily }),
      intent,
      requiresHuman: true,
      model: 'heuristic',
      context: { knowledgeGuard: true },
    };
  }

  if (intent === 'offers' && !hasKnowledgeForTopic(cfg, 'offers')) {
    return {
      body: buildMissingKnowledgeReply('offers', cfg, { scriptFamily }),
      intent,
      requiresHuman: true,
      model: 'heuristic',
      context: { knowledgeGuard: true },
    };
  }

  if (intent === 'policies' && !hasKnowledgeForTopic(cfg, 'policies')) {
    return {
      body: buildMissingKnowledgeReply('policies', cfg, { scriptFamily }),
      intent,
      requiresHuman: true,
      model: 'heuristic',
      context: { knowledgeGuard: true },
    };
  }

  const body = buildReply(intent, lead, { messageCount: messages.length }, cfg);
  return {
    body,
    intent,
    model: 'heuristic',
    context: {
      lastMessage: lastInbound?.body || null,
      messageCount: messages.length,
      leadName: lead?.name || null,
      niche: lead?.niche || null,
    },
  };
}

module.exports = { generateReply };
