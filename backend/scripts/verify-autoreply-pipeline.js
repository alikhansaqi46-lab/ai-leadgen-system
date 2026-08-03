/**
 * Non-invasive diagnostic: inspects conversation state and calls
 * maybeAutoReplyToInboundEmail() directly to see the exact reason it
 * does or does not send, without going through HTTP/frontend.
 *
 * Usage: node backend/scripts/verify-autoreply-pipeline.js <conversationId>
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const WORKSPACE_ID = process.env.TRACE_WORKSPACE_ID || 'usr_super_admin_1783323507243';
const CONVERSATION_ID = process.argv[2] || '98ede80e-82ba-4c77-ad0b-956d4fdf9104';

async function main() {
  const conversationStorage = require('../utils/conversationStorage');
  const userStorage = require('../utils/userStorage');
  const { mergeAiAgentConfig } = require('../utils/aiAgentConfig');
  const autonomousReplyService = require('../services/autonomousReplyService');

  const conv = await conversationStorage.getConversation(CONVERSATION_ID, { workspaceId: WORKSPACE_ID });
  console.log('[VERIFY] conversation:', JSON.stringify({ id: conv?.id, channel: conv?.channel, status: conv?.status, leadId: conv?.leadId, unreadCount: conv?.unreadCount }, null, 2));

  const messages = await conversationStorage.getMessages(CONVERSATION_ID, { workspaceId: WORKSPACE_ID });
  const chronological = [...messages].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  console.log('[VERIFY] last 5 messages:');
  for (const m of chronological.slice(-5)) {
    console.log('  -', JSON.stringify({
      id: m.id, direction: m.direction, source: m.source, createdAt: m.createdAt,
      autoReply: m.metadata?.autoReply, aiGenerated: m.metadata?.aiGenerated,
    }));
  }

  const user = await userStorage.findById(WORKSPACE_ID).catch(() => null);
  const agentConfig = mergeAiAgentConfig(await userStorage.getAiAgentConfig(WORKSPACE_ID), user);
  console.log('[VERIFY] emailAutoReplyEnabled:', agentConfig.emailAutoReplyEnabled);

  console.log('[VERIFY] calling maybeAutoReplyToInboundEmail()...');
  const result = await autonomousReplyService.maybeAutoReplyToInboundEmail({
    workspaceId: WORKSPACE_ID,
    conversationId: CONVERSATION_ID,
    userId: WORKSPACE_ID,
  });
  console.log('[VERIFY] result:', JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('[VERIFY FATAL]', err);
  process.exit(1);
});
