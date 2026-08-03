/**
 * WhatsApp AI Brain — completely independent AI for WhatsApp channel.
 * 
 * Has its own:
 * - Conversation memory (only WhatsApp messages)
 * - Prompt template (WhatsApp-optimized: short, conversational)
 * - Tone (casual, friendly, concise)
 * - Follow-up strategy (quick replies, 24h window)
 * - Reply generation
 * - Context management
 * - Campaign state tracking
 * 
 * NEVER reads Email or SMS history. NEVER shares context with other channels.
 */

const conversationStorage = require('../../utils/conversationStorage');
const campaignStorage = require('../../utils/campaignStorage');
const timelineStorage = require('../../utils/timelineStorage');
const leadStorage = require('../../utils/leadStorage');
const personalContactStorage = require('../../utils/personalContactStorage');
const userStorage = require('../../utils/userStorage');
const openAiKeyService = require('../../services/openAiKeyService');
const aiProvider = require('../../services/aiProvider');
const whatsappTransport = require('../../services/whatsappTransport');
const { mergeAiAgentConfig, shouldHandoffToHuman, buildMissingKnowledgeReply } = require('../../utils/aiAgentConfig');
const { analyzeScript } = require('../../utils/languageDetection');

/**
 * WhatsApp-specific prompt template.
 * Optimized for WhatsApp messaging: short, conversational, use emojis, be direct.
 */
const WHATSAPP_SYSTEM_PROMPT = `You are a WhatsApp AI Sales Assistant for NovaCore Technologies.

RULES:
1. Respond ONLY to WhatsApp messages — never use Email or SMS history.
2. Keep responses SHORT and CONVERSATIONAL (WhatsApp is casual).
3. Use emojis naturally where appropriate.
4. Be direct and friendly.
5. Always identify yourself as the lead's WhatsApp assistant.
6. If the customer asks about pricing, offer to schedule a call.
7. Never invent information not provided in the conversation.
8. If unsure, suggest a human follow-up.
9. Response must be under 300 characters.
10. Output ONLY the reply text — no JSON, no formatting.`;

/**
 * Get or create a WhatsApp brain instance for a workspace.
 * Each workspace gets its own brain with isolated state.
 * 
 * @param {string} workspaceId
 * @returns {Object} WhatsAppBrain
 */
function getWhatsAppBrain(workspaceId) {
  const brain = {
    workspaceId,
    channel: 'whatsapp',
    
    /**
     * The WhatsApp tone — casual, friendly, concise.
     */
    tone: {
      style: 'casual',
      formality: 'low',
      emoji: true,
      maxLength: 300,
      greeting: 'Hi {name}!',
      signature: null, // WhatsApp doesn't need signatures
    },

    /**
     * WhatsApp follow-up strategy.
     * WhatsApp has a 24-hour customer-initiated window.
     */
    followUpStrategy: {
      enabled: true,
      initialDelay: 60 * 60 * 1000, // 1 hour
      maxFollowUps: 3,
     间隔: [1, 4, 24], // hours: 1h, 4h, 24h
      reengagementMessage: 'Hey {name}, just checking in! 👋 Let me know if you have any questions.',
      expiryAfter: 7 * 24 * 60 * 60 * 1000, // 7 days
    },

    /**
     * Load WhatsApp-only conversation memory.
     * Filters messages to ONLY WhatsApp channel — never returns Email or SMS.
     * 
     * @param {string} conversationId
     * @param {Object} options
     * @returns {Promise<Array>} only WhatsApp messages
     */
    async loadConversationMemory(conversationId, { workspaceId: wsId } = {}) {
      const ws = wsId || this.workspaceId;
      const messages = await conversationStorage.getMessages(conversationId, { workspaceId: ws });
      
      // CRITICAL: Filter to ONLY WhatsApp messages — no cross-channel contamination
      const whatsAppMessages = (messages || []).filter(
        m => m.channel === 'whatsapp' || m.channel === 'whatsapp_qr'
      );
      
      return whatsAppMessages.sort(
        (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
      );
    },

    /**
     * Generate a WhatsApp-optimized prompt with context.
     * Only includes WhatsApp message history — never Email/SMS.
     * 
     * @param {Array} messages - WhatsApp-only messages (already filtered)
     * @param {Object} lead
     * @param {Object} agentConfig
     * @returns {string} prompt
     */
    buildPrompt(messages, lead, agentConfig) {
      const businessName = agentConfig?.businessName || 'NovaCore Technologies';
      const niche = lead?.niche || 'business';
      const name = lead?.name || 'there';
      
      let prompt = `You are a WhatsApp sales assistant for ${businessName}.\n\n`;
      prompt += `CUSTOMER: ${name}\n`;
      prompt += `BUSINESS TYPE: ${niche}\n`;
      prompt += `CITY: ${lead?.city || 'Unknown'}\n\n`;
      prompt += `CONVERSATION HISTORY (WhatsApp only):\n`;

      for (const msg of messages) {
        const sender = msg.direction === 'inbound' ? 'CUSTOMER' : 'YOU';
        prompt += `${sender}: ${msg.body || ''}\n`;
      }

      prompt += `\nGenerate a WhatsApp-appropriate reply. Keep it under 300 characters. Be friendly and conversational. Use emojis naturally.`;
      
      return prompt;
    },

    /**
     * Get the WhatsApp-specific system prompt for OpenAI.
     */
    getSystemPrompt() {
      return WHATSAPP_SYSTEM_PROMPT;
    },

    /**
     * Generate an AI reply for WhatsApp using only WhatsApp context.
     * 
     * @param {Array} messages - ALL messages (will filter to WhatsApp only)
     * @param {Object} lead
     * @param {Object} options
     * @returns {Promise<Object>} { body, intent, model, requiresHuman }
     */
    async generateReply(messages, lead, options = {}) {
      const { config, agentConfig, workspaceId: wsId } = options;
      const ws = wsId || this.workspaceId;
      
      // Filter to WhatsApp-only messages (isolation guarantee)
      const waMessages = await this.loadConversationMemory(null, { workspaceId: ws });
      // If conversationId wasn't provided, use the passed messages filtered to WhatsApp
      const filteredMessages = (messages || []).filter(
        m => m.channel === 'whatsapp' || m.channel === 'whatsapp_qr'
      );
      
      const chronological = (filteredMessages.length > 0 ? filteredMessages : waMessages).sort(
        (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
      );

      const lastInbound = [...chronological].reverse().find(m => m.direction === 'inbound');
      if (!lastInbound) return { body: '👋 Hi! How can I help you today?', intent: 'greeting', model: 'template' };

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
            channel: 'whatsapp',
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
          console.warn('[WhatsAppBrain] OpenAI reply failed, falling back to template:', err.message);
        }
      }

      // Fallback to template-based reply
      const { generateReply } = require('../../services/reply');
      const templateReply = generateReply(chronological, lead, { agentConfig });
      return {
        body: templateReply,
        intent: 'ai_generated',
        model: 'template',
        requiresHuman: false,
      };
    },

    /**
     * Send the reply through WhatsApp transport.
     * 
     * @param {string} to - phone number
     * @param {string} body - message text
     * @param {Object} options
     * @returns {Promise<Object>} send result
     */
    async sendReply(to, body, options = {}) {
      const ws = options.workspaceId || this.workspaceId;
      if (!whatsappTransport.isConfigured(ws)) {
        throw new Error('WhatsApp is not connected. Please connect WhatsApp first.');
      }
      return whatsappTransport.sendText({
        workspaceId: ws,
        to,
        message: body,
        testMode: false,
      });
    },

    /**
     * Save the reply to conversation storage (WhatsApp-only).
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
        channel: 'whatsapp',
        source: 'auto-ai',
        status: 'sent',
        messageType: 'text',
        externalMessageId: metadata.messageId || null,
        metadata: {
          ...metadata,
          aiGenerated: true,
          autoReply: true,
          intent: metadata.intent || 'ai_generated',
          brain: 'whatsapp',
          channel: 'whatsapp',
          // Isolation identifiers
          workspaceId: ws,
          conversationId,
        },
      }, { workspaceId: ws });
    },

    /**
     * Update campaign stage for WhatsApp.
     * 
     * @param {string} leadId
     * @param {Object} options
     */
    async updateCampaign(leadId, options = {}) {
      const ws = options.workspaceId || this.workspaceId;
      await campaignStorage.recordReply(leadId, { workspaceId: ws, channel: 'whatsapp' }).catch(() => null);
      await campaignStorage.cancelFollowUps(leadId, { workspaceId: ws }).catch(() => null);
    },

    /**
     * Update timeline for WhatsApp.
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
        channel: 'whatsapp',
        conversationId,
        referenceId: reply.messageId || null,
        payload: {
          action: 'auto_reply',
          intent: reply.intent,
          requiresHuman: reply.requiresHuman,
          preview: String(reply.body || '').slice(0, 120),
          brain: 'whatsapp',
        },
      }, { workspaceId: ws }).catch(() => null);
    },
  };

  return brain;
}

module.exports = { getWhatsAppBrain, WHATSAPP_SYSTEM_PROMPT };