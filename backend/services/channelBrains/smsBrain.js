/**
 * SMS AI Brain — completely independent AI for SMS channel.
 * 
 * Has its own:
 * - Conversation memory (only SMS messages)
 * - Prompt template (SMS-optimized: ultra-short, direct)
 * - Tone (brief, action-oriented, no fluff)
 * - Follow-up strategy (quick, limited)
 * - Reply generation
 * - Context management
 * - Campaign state tracking
 * 
 * NEVER reads WhatsApp or Email history. NEVER shares context with other channels.
 */

const conversationStorage = require('../../utils/conversationStorage');
const campaignStorage = require('../../utils/campaignStorage');
const timelineStorage = require('../../utils/timelineStorage');
const leadStorage = require('../../utils/leadStorage');
const personalContactStorage = require('../../utils/personalContactStorage');
const userStorage = require('../../utils/userStorage');
const openAiKeyService = require('../../services/openAiKeyService');
const aiProvider = require('../../services/aiProvider');
const { sendSms } = require('../../services/smsService');
const { mergeAiAgentConfig, shouldHandoffToHuman, buildMissingKnowledgeReply } = require('../../utils/aiAgentConfig');
const { analyzeScript } = require('../../utils/languageDetection');

/**
 * SMS-specific system prompt.
 * Optimized for SMS: ultra-short, direct, no fluff, no emojis in some contexts.
 */
const SMS_SYSTEM_PROMPT = `You are an SMS AI Sales Assistant for NovaCore Technologies.

RULES:
1. Respond ONLY to SMS messages — never use WhatsApp or Email history.
2. Keep responses UNDER 160 characters (single SMS).
3. Be DIRECT and ACTION-ORIENTED.
4. No greetings, no signatures (SMS is brief).
5. Use simple language — customers read SMS on mobile.
6. Include a clear call-to-action when appropriate.
7. Never invent information not provided in the conversation.
8. If unsure, suggest a human follow-up.
9. Output ONLY the reply text — no JSON, no formatting.`;

/**
 * Get or create an SMS brain instance for a workspace.
 * 
 * @param {string} workspaceId
 * @returns {Object} SmsBrain
 */
function getSmsBrain(workspaceId) {
  const brain = {
    workspaceId,
    channel: 'sms',

    /**
     * The SMS tone — brief, direct, no fluff.
     */
    tone: {
      style: 'direct',
      formality: 'low',
      emoji: false,
      maxLength: 160,
      greeting: null, // SMS doesn't need greetings
      signature: null, // SMS doesn't need signatures
    },

    /**
     * SMS follow-up strategy.
     * SMS is limited — fewer follow-ups, shorter window.
     */
    followUpStrategy: {
      enabled: true,
      initialDelay: 2 * 60 * 60 * 1000, // 2 hours
      maxFollowUps: 2,
     间隔: [2, 24], // hours: 2h, 24h
      reengagementMessage: 'Hi {name}, quick follow-up — any questions? Reply STOP to opt out.',
      expiryAfter: 3 * 24 * 60 * 60 * 1000, // 3 days
    },

    /**
     * Load SMS-only conversation memory.
     * Filters messages to ONLY SMS channel — never returns WhatsApp or Email.
     * 
     * @param {string} conversationId
     * @param {Object} options
     * @returns {Promise<Array>} only SMS messages
     */
    async loadConversationMemory(conversationId, { workspaceId: wsId } = {}) {
      const ws = wsId || this.workspaceId;
      const messages = await conversationStorage.getMessages(conversationId, { workspaceId: ws });

      // CRITICAL: Filter to ONLY SMS messages — no cross-channel contamination
      const smsMessages = (messages || []).filter(
        m => m.channel === 'sms' || m.messageType === 'sms'
      );

      return smsMessages.sort(
        (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
      );
    },

    /**
     * Generate an SMS-optimized prompt with context.
     * Only includes SMS message history — never WhatsApp/Email.
     * 
     * @param {Array} messages - SMS-only messages (already filtered)
     * @param {Object} lead
     * @param {Object} agentConfig
     * @returns {string} prompt
     */
    buildPrompt(messages, lead, agentConfig) {
      const businessName = agentConfig?.businessName || 'NovaCore Technologies';
      const name = lead?.name || 'there';
      
      let prompt = `You are an SMS assistant for ${businessName}.\n\n`;
      prompt += `CUSTOMER: ${name}\n\n`;
      prompt += `SMS CONVERSATION HISTORY (SMS only):\n`;

      for (const msg of messages) {
        const sender = msg.direction === 'inbound' ? 'CUSTOMER' : 'YOU';
        prompt += `${sender}: ${msg.body || ''}\n`;
      }

      prompt += `\nGenerate a brief SMS reply. Under 160 characters. Direct and action-oriented. No greetings.`;
      
      return prompt;
    },

    /**
     * Get the SMS-specific system prompt.
     */
    getSystemPrompt() {
      return SMS_SYSTEM_PROMPT;
    },

    /**
     * Generate an AI reply for SMS using only SMS context.
     * 
     * @param {Array} messages - ALL messages (will filter to SMS only)
     * @param {Object} lead
     * @param {Object} options
     * @returns {Promise<Object>} { body, intent, model, requiresHuman }
     */
    async generateReply(messages, lead, options = {}) {
      const { config, agentConfig, workspaceId: wsId } = options;
      const ws = wsId || this.workspaceId;

      // Filter to SMS-only messages (isolation guarantee)
      const filteredMessages = (messages || []).filter(
        m => m.channel === 'sms' || m.messageType === 'sms'
      );

      const chronological = filteredMessages.sort(
        (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
      );

      const lastInbound = [...chronological].reverse().find(m => m.direction === 'inbound');
      if (!lastInbound) return { body: 'Thanks for your message. How can we help?', intent: 'greeting', model: 'template' };

      // Check for human handoff
      if (shouldHandoffToHuman(lastInbound.body, agentConfig)) {
        const scriptFamily = analyzeScript(lastInbound.body).dominantScript || 'latin';
        return {
          body: buildMissingKnowledgeReply('info', agentConfig, { scriptFamily }),
          intent: 'human_requested',
          model: 'keyword-handoff',
          requiresHuman: true,
        };
      }

      // Try OpenAI if configured
      if (config && !config.blocked) {
        try {
          const reply = await aiProvider.generateReply(chronological, lead, {
            workspaceId: ws,
            config,
            agentConfig,
            channel: 'sms',
            systemPrompt: this.getSystemPrompt(),
          });

          if (reply?.body) {
            await openAiKeyService.consumeFreeMessage(ws, config.source).catch(() => null);
            return {
              body: reply.body,
              intent: reply.intent || 'ai_generated',
              model: reply.model || 'openai',
              requiresHuman: Boolean(reply.requiresHuman),
            };
          }
        } catch (err) {
          console.warn('[SmsBrain] OpenAI reply failed, falling back to template:', err.message);
        }
      }

      // Fallback to template-based reply
      const { generateReply } = require('../../services/reply');
      const templateReply = generateReply(chronological, lead, { agentConfig });
      // Truncate SMS to 160 chars
      const truncated = String(templateReply || '').slice(0, 160);
      return {
        body: truncated,
        intent: 'ai_generated',
        model: 'template',
        requiresHuman: false,
      };
    },

    /**
     * Send the reply through SMS transport.
     * 
     * @param {string} to - phone number
     * @param {string} body - message text
     * @param {Object} options
     * @returns {Promise<Object>} send result
     */
    async sendReply(to, body, options = {}) {
      const ws = options.workspaceId || this.workspaceId;
      return sendSms({ to, body, workspaceId: ws });
    },

    /**
     * Save the reply to conversation storage (SMS-only).
     * 
     * @param {string} conversationId
     * @param {string} body
     * @param {Object} metadata
     * @param {Object} options
     * @returns {Promise<Object>} saved message
     */
    async saveReply(conversationId, body, metadata = {}, options = {}) {
      const ws = options.workspaceId || this.workspaceId;
      return conversationStorage.addMessage(conversationId, {
        direction: 'outbound',
        body,
        channel: 'sms',
        source: 'auto-ai',
        status: 'sent',
        messageType: 'text',
        externalMessageId: metadata.messageId || null,
        metadata: {
          ...metadata,
          aiGenerated: true,
          autoReply: true,
          intent: metadata.intent || 'ai_generated',
          brain: 'sms',
          channel: 'sms',
          workspaceId: ws,
          conversationId,
        },
      }, { workspaceId: ws });
    },

    /**
     * Update campaign stage for SMS.
     * 
     * @param {string} leadId
     * @param {Object} options
     */
    async updateCampaign(leadId, options = {}) {
      const ws = options.workspaceId || this.workspaceId;
      await campaignStorage.recordReply(leadId, { workspaceId: ws, channel: 'sms' }).catch(() => null);
      await campaignStorage.cancelFollowUps(leadId, { workspaceId: ws }).catch(() => null);
    },

    /**
     * Update timeline for SMS.
     * 
     * @param {string} leadId
     * @param {string} conversationId
     * @param {Object} reply
     * @param {Object} options
     */
    async updateTimeline(leadId, conversationId, reply, options = {}) {
      const ws = options.workspaceId || this.workspaceId;
      await timelineStorage.recordEvent({
        leadId,
        type: 'ai_action',
        channel: 'sms',
        conversationId,
        referenceId: reply.messageId || null,
        payload: {
          action: 'auto_reply',
          intent: reply.intent,
          requiresHuman: reply.requiresHuman,
          preview: String(reply.body || '').slice(0, 120),
          brain: 'sms',
        },
      }, { workspaceId: ws }).catch(() => null);
    },
  };

  return brain;
}

module.exports = { getSmsBrain, SMS_SYSTEM_PROMPT };