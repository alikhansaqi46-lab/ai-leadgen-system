/**
 * Email AI Brain — completely independent AI for Email channel.
 * 
 * Has its own:
 * - Conversation memory (only Email messages)
 * - Prompt template (Email-optimized: professional, formal)
 * - Tone (professional, polite, detailed)
 * - Follow-up strategy (slower cadence, multi-day)
 * - Reply generation
 * - Context management (thread headers, signatures)
 * - Campaign state tracking
 * 
 * NEVER reads WhatsApp or SMS history. NEVER shares context with other channels.
 */

const conversationStorage = require('../../utils/conversationStorage');
const campaignStorage = require('../../utils/campaignStorage');
const timelineStorage = require('../../utils/timelineStorage');
const leadStorage = require('../../utils/leadStorage');
const personalContactStorage = require('../../utils/personalContactStorage');
const userStorage = require('../../utils/userStorage');
const openAiKeyService = require('../../services/openAiKeyService');
const aiProvider = require('../../services/aiProvider');
const emailService = require('../../services/emailService');
const { mergeAiAgentConfig, shouldHandoffToHuman, buildMissingKnowledgeReply } = require('../../utils/aiAgentConfig');
const { resolveDeliveryEmail } = require('../../utils/emailValidation');
const { analyzeScript } = require('../../utils/languageDetection');

/**
 * Email-specific system prompt.
 * Optimized for email: professional, formal, proper structure.
 */
const EMAIL_SYSTEM_PROMPT = `You are an Email AI Sales Assistant for NovaCore Technologies.

RULES:
1. Respond ONLY to Email messages — never use WhatsApp or SMS history.
2. Use PROFESSIONAL, POLITE language suitable for email.
3. Include proper email structure (greeting, body, closing).
4. Do NOT use emojis (emails are formal).
5. Include a proper email signature.
6. Reference the customer's name and business when appropriate.
7. If the customer asks about pricing, offer a detailed breakdown.
8. Never invent information not provided in the conversation.
9. If unsure, suggest a human follow-up.
10. Output ONLY the reply text — no JSON, no formatting.`;

/**
 * Get or create an Email brain instance for a workspace.
 * 
 * @param {string} workspaceId
 * @returns {Object} EmailBrain
 */
function getEmailBrain(workspaceId) {
  const brain = {
    workspaceId,
    channel: 'email',

    /**
     * The Email tone — professional, polite, formal.
     */
    tone: {
      style: 'professional',
      formality: 'high',
      emoji: false,
      maxLength: 800,
      greeting: 'Dear {name},',
      signature: '\n\nBest regards,\n{company}\n{email}',
    },

    /**
     * Email follow-up strategy.
     * Email allows longer follow-up windows.
     */
    followUpStrategy: {
      enabled: true,
      initialDelay: 24 * 60 * 60 * 1000, // 24 hours
      maxFollowUps: 5,
      间隔: [24, 48, 72, 168, 336], // hours: 1d, 2d, 3d, 7d, 14d
      reengagementMessage: 'Dear {name},\n\nI wanted to follow up on my previous message. Have you had a chance to review?\n\nBest regards,\n{company}',
      expiryAfter: 30 * 24 * 60 * 60 * 1000, // 30 days
    },

    /**
     * Load Email-only conversation memory.
     * Filters messages to ONLY Email channel — never returns WhatsApp or SMS.
     * 
     * @param {string} conversationId
     * @param {Object} options
     * @returns {Promise<Array>} only Email messages
     */
    async loadConversationMemory(conversationId, { workspaceId: wsId } = {}) {
      const ws = wsId || this.workspaceId;
      const messages = await conversationStorage.getMessages(conversationId, { workspaceId: ws });

      // CRITICAL: Filter to ONLY Email messages — no cross-channel contamination
      const emailMessages = (messages || []).filter(
        m => m.channel === 'email' || m.messageType === 'email'
      );

      return emailMessages.sort(
        (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
      );
    },

    /**
     * Build email thread headers from conversation history.
     * 
     * @param {Array} messages - Email-only messages
     * @returns {Object} thread headers
     */
    buildThreadHeaders(messages) {
      const emailMsgs = messages.filter(m => m.channel === 'email' || m.messageType === 'email');
      const lastInbound = [...emailMsgs].reverse().find(m => m.direction === 'inbound');
      const lastEmail = [...emailMsgs].reverse().find(
        m => m.metadata?.rfcMessageId || m.metadata?.messageId || m.metadata?.gmailThreadId
      );
      return {
        lastInbound,
        lastEmail,
        threadId: lastEmail?.metadata?.gmailThreadId || null,
        inReplyTo: lastInbound?.metadata?.rfcMessageId || lastInbound?.metadata?.messageId || lastEmail?.metadata?.rfcMessageId || null,
        references: [
          ...(Array.isArray(lastEmail?.metadata?.references) ? lastEmail.metadata.references : []),
          lastEmail?.metadata?.rfcMessageId,
          lastEmail?.metadata?.messageId,
          lastInbound?.metadata?.rfcMessageId,
          lastInbound?.metadata?.messageId,
        ].filter(Boolean).join(' '),
      };
    },

    /**
     * Generate an Email-optimized prompt with context.
     * Only includes Email message history — never WhatsApp/SMS.
     * 
     * @param {Array} messages - Email-only messages (already filtered)
     * @param {Object} lead
     * @param {Object} agentConfig
     * @returns {string} prompt
     */
    buildPrompt(messages, lead, agentConfig) {
      const businessName = agentConfig?.businessName || 'NovaCore Technologies';
      const niche = lead?.niche || 'business';
      const name = lead?.name || 'there';
      const company = lead?.company || '';

      let prompt = `You are an email sales assistant for ${businessName}.\n\n`;
      prompt += `RECIPIENT: ${name}\n`;
      prompt += `COMPANY: ${company}\n`;
      prompt += `BUSINESS TYPE: ${niche}\n`;
      prompt += `CITY: ${lead?.city || 'Unknown'}\n\n`;
      prompt += `EMAIL CONVERSATION HISTORY (Email only):\n`;

      for (const msg of messages) {
        const sender = msg.direction === 'inbound' ? 'CUSTOMER' : 'YOU';
        prompt += `${sender}: ${msg.body || ''}\n`;
      }

      prompt += `\nGenerate a professional email reply. Use proper email format with greeting and signature. No emojis.`;
      
      return prompt;
    },

    /**
     * Get the Email-specific system prompt.
     */
    getSystemPrompt() {
      return EMAIL_SYSTEM_PROMPT;
    },

    /**
     * Generate an AI reply for Email using only Email context.
     * 
     * @param {Array} messages - ALL messages (will filter to Email only)
     * @param {Object} lead
     * @param {Object} options
     * @returns {Promise<Object>} { body, intent, model, requiresHuman }
     */
    async generateReply(messages, lead, options = {}) {
      const { config, agentConfig, workspaceId: wsId } = options;
      const ws = wsId || this.workspaceId;

      // Filter to Email-only messages (isolation guarantee)
      const filteredMessages = (messages || []).filter(
        m => m.channel === 'email' || m.messageType === 'email'
      );

      const chronological = filteredMessages.sort(
        (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
      );

      const lastInbound = [...chronological].reverse().find(m => m.direction === 'inbound');
      if (!lastInbound) return { body: 'Thank you for your message. How can I help you today?', intent: 'greeting', model: 'template' };

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
            channel: 'email',
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
          console.warn('[EmailBrain] OpenAI reply failed, falling back to template:', err.message);
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
     * Send the reply through Email transport.
     * 
     * @param {Object} lead
     * @param {string} body
     * @param {Object} options
     * @returns {Promise<Object>} send result
     */
    async sendReply(lead, body, options = {}) {
      const ws = options.workspaceId || this.workspaceId;
      const email = resolveDeliveryEmail(lead) || lead.email;
      if (!email) throw new Error('No email address available for this lead');

      const thread = this.buildThreadHeaders(options.messages || []);
      const replySubject = options.subject && /^re:/i.test(options.subject)
        ? options.subject
        : `Re: ${options.subject || 'Outreach'}`;

      return emailService.sendEmailToLead(lead, {
        message: body,
        subject: replySubject,
        workspaceId: ws,
        threadId: thread.threadId,
        inReplyTo: thread.inReplyTo,
        references: thread.references,
      });
    },

    /**
     * Save the reply to conversation storage (Email-only).
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
        channel: 'email',
        source: 'auto-ai',
        status: 'sent',
        messageType: 'email',
        externalMessageId: metadata.messageId || null,
        metadata: {
          ...metadata,
          aiGenerated: true,
          autoReply: true,
          intent: metadata.intent || 'ai_generated',
          brain: 'email',
          channel: 'email',
          workspaceId: ws,
          conversationId,
        },
      }, { workspaceId: ws });
    },

    /**
     * Update campaign stage for Email.
     * 
     * @param {string} leadId
     * @param {Object} options
     */
    async updateCampaign(leadId, options = {}) {
      const ws = options.workspaceId || this.workspaceId;
      await campaignStorage.recordReply(leadId, { workspaceId: ws, channel: 'email' }).catch(() => null);
      await campaignStorage.cancelFollowUps(leadId, { workspaceId: ws }).catch(() => null);
    },

    /**
     * Update timeline for Email.
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
        channel: 'email',
        conversationId,
        referenceId: reply.messageId || null,
        payload: {
          action: 'auto_reply',
          intent: reply.intent,
          requiresHuman: reply.requiresHuman,
          preview: String(reply.body || '').slice(0, 120),
          brain: 'email',
        },
      }, { workspaceId: ws }).catch(() => null);
    },
  };

  return brain;
}

module.exports = { getEmailBrain, EMAIL_SYSTEM_PROMPT };