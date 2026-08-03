/**
 * Channel Brain Factory — creates and returns the appropriate AI brain for a channel.
 * 
 * Each brain is a completely independent module with its own:
 * - Conversation memory (only reads its own channel's messages)
 * - Prompt template
 * - Tone configuration
 * - Follow-up strategy
 * - Reply generation
 * - Context management
 * - Campaign state tracking
 * 
 * No cross-channel data sharing occurs. WhatsApp never reads Email history,
 * Email never reads SMS history, SMS never reads WhatsApp memory.
 */

const { getWhatsAppBrain } = require('./whatsappBrain');
const { getEmailBrain } = require('./emailBrain');
const { getSmsBrain } = require('./smsBrain');

const brainCache = new Map(); // key: "channel:workspaceId" -> brain instance

/**
 * Get the AI brain for a specific channel.
 * Each channel gets its own brain instance per workspace — fully isolated.
 * 
 * @param {'whatsapp'|'email'|'sms'} channel
 * @param {string} workspaceId
 * @returns {Object} channel brain with { generateReply, loadContext, saveContext, getCampaignState, updateCampaignState, getFollowUpStrategy, getTone, getPromptTemplate }
 */
function getBrain(channel, workspaceId = 'default') {
  const key = `${channel}:${workspaceId}`;
  if (brainCache.has(key)) return brainCache.get(key);

  let brain;
  switch (channel) {
    case 'whatsapp':
      brain = getWhatsAppBrain(workspaceId);
      break;
    case 'email':
      brain = getEmailBrain(workspaceId);
      break;
    case 'sms':
      brain = getSmsBrain(workspaceId);
      break;
    default:
      throw new Error(`Unknown channel: ${channel}. Supported: whatsapp, email, sms`);
  }

  brainCache.set(key, brain);
  return brain;
}

/**
 * Clear all cached brains (useful for testing or config changes).
 */
function clearBrainCache() {
  brainCache.clear();
}

/**
 * Get the identifiers for a message context.
 * Every message must carry these identifiers to prevent cross-channel contamination.
 * 
 * @param {Object} options
 * @param {string} options.workspaceId
 * @param {string} options.leadId
 * @param {string} [options.contactId]
 * @param {'whatsapp'|'email'|'sms'} options.channel
 * @param {string} [options.campaignId]
 * @param {string} options.conversationId
 * @param {string} [options.workflowId]
 * @param {string} [options.automationId]
 * @returns {Object} messageContext
 */
function buildMessageContext({ workspaceId, leadId, contactId, channel, campaignId, conversationId, workflowId, automationId }) {
  return {
    workspaceId: String(workspaceId || 'default'),
    leadId: String(leadId || ''),
    contactId: contactId ? String(contactId) : null,
    channel: String(channel),
    campaignId: campaignId ? String(campaignId) : null,
    conversationId: String(conversationId || ''),
    workflowId: workflowId ? String(workflowId) : null,
    automationId: automationId ? String(automationId) : null,
    // Composite key for isolation enforcement
    isolationKey: `${channel}:${workspaceId}:${leadId || 'unknown'}`,
    // Timestamp for ordering
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validate that a message context matches the expected channel.
 * Throws if channel mismatch is detected (cross-channel contamination prevention).
 * 
 * @param {Object} ctx - message context from buildMessageContext
 * @param {string} expectedChannel
 * @throws {Error} if channel mismatch
 */
function assertChannelMatch(ctx, expectedChannel) {
  if (ctx.channel !== expectedChannel) {
    throw new Error(
      `Cross-channel contamination detected: expected channel "${expectedChannel}" but got "${ctx.channel}". ` +
      `This is a bug — ${expectedChannel} brain should never process ${ctx.channel} messages.`
    );
  }
}

module.exports = {
  getBrain,
  clearBrainCache,
  buildMessageContext,
  assertChannelMatch,
};