/**
 * Non-invasive verification: confirms that once maybeAutoReplyToInboundEmail
 * successfully sends a reply, deriveNotificationStatus-equivalent logic would
 * show "AI Replied" (the metadata flags it depends on are present).
 *
 * This does NOT send a real email — it inspects an already-answered
 * conversation from today's real pipeline runs to confirm the badge
 * conditions are met end-to-end.
 *
 * Usage: node backend/scripts/verify-autoreply-badge.js <conversationId>
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const WORKSPACE_ID = process.env.TRACE_WORKSPACE_ID || 'usr_super_admin_1783323507243';
const CONVERSATION_ID = process.argv[2] || '98ede80e-82ba-4c77-ad0b-956d4fdf9104';

function deriveNotificationStatus(conv, messages, last) {
  const unread = conv.unreadCount || 0;
  const lastMsg = last || messages[messages.length - 1] || null;
  const lastDir = lastMsg?.direction;
  const lastOutbound = [...messages].reverse().find((m) => m.direction === 'outbound');

  if (conv.status === 'needs_human') return { type: 'human_required', label: 'Human Required' };
  if (unread > 0 && lastDir === 'inbound') return { type: 'new_reply', label: 'New Reply' };
  if (lastOutbound?.metadata?.sending) return { type: 'sending', label: 'Sending...' };
  if (lastDir === 'outbound' && (lastOutbound?.metadata?.autoReply || lastOutbound?.metadata?.aiGenerated)) {
    return { type: 'ai_replied', label: 'AI Replied' };
  }
  if (lastDir === 'outbound' && unread === 0) return { type: 'waiting', label: 'Waiting for Customer' };
  return null;
}

async function main() {
  const conversationStorage = require('../utils/conversationStorage');
  const conv = await conversationStorage.getConversation(CONVERSATION_ID, { workspaceId: WORKSPACE_ID });
  const messages = await conversationStorage.getMessages(CONVERSATION_ID, { workspaceId: WORKSPACE_ID });
  const chronological = [...messages].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  const last = chronological[chronological.length - 1];

  console.log('[VERIFY] conversation status:', conv.status, '| unreadCount:', conv.unreadCount);
  console.log('[VERIFY] last message direction:', last?.direction, '| autoReply:', last?.metadata?.autoReply);
  console.log('[VERIFY] derived badge:', JSON.stringify(deriveNotificationStatus(conv, chronological, last)));
  process.exit(0);
}

main().catch((err) => {
  console.error('[VERIFY FATAL]', err);
  process.exit(1);
});
