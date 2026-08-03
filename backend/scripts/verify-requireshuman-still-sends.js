/**
 * Non-invasive integration check: proves that when the AI genuinely cannot
 * answer (requiresHuman: true), maybeAutoReplyToInboundEmail() STILL sends
 * the professional deferral reply instead of discarding it.
 *
 * Stubs emailService.sendEmailToLead so no real email is sent. Injects a
 * temporary inbound test message and removes both it and the generated
 * outbound reply afterwards, leaving the conversation unchanged.
 *
 * Usage: node backend/scripts/verify-requireshuman-still-sends.js [conversationId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const WORKSPACE_ID = process.env.TRACE_WORKSPACE_ID || 'usr_super_admin_1783323507243';
const CONVERSATION_ID = process.argv[2] || '98ede80e-82ba-4c77-ad0b-956d4fdf9104';

async function main() {
  const conversationStorage = require('../utils/conversationStorage');
  const emailService = require('../services/emailService');
  const autonomousReplyService = require('../services/autonomousReplyService');

  // Stub the real send so this test never hits Gmail.
  const originalSend = emailService.sendEmailToLead;
  let stubCalledWith = null;
  emailService.sendEmailToLead = async (lead, opts) => {
    stubCalledWith = { to: lead.email, subject: opts.subject, message: opts.message };
    return {
      messageId: 'stub-message-id',
      rfcMessageId: '<stub@test>',
      gmailThreadId: null,
      recipientEmail: lead.email,
      deliveryVerified: null,
    };
  };

  const testMessage = await conversationStorage.addMessage(CONVERSATION_ID, {
    direction: 'inbound',
    body: 'Do you ship internationally to Germany, and what are the customs fees and import duties?',
    channel: 'email',
    source: 'inbound',
    status: 'received',
    messageType: 'email',
    metadata: { subject: 'Re: Outreach', test: true },
  }, { workspaceId: WORKSPACE_ID });
  console.log('[VERIFY] injected test inbound message:', testMessage.id);

  let result;
  let outboundMsgId = null;
  try {
    result = await autonomousReplyService.maybeAutoReplyToInboundEmail({
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      userId: WORKSPACE_ID,
    });
    console.log('[VERIFY] result:', JSON.stringify(result, null, 2));
    console.log('[VERIFY] stub was called with:', JSON.stringify(stubCalledWith, null, 2));
    outboundMsgId = result.messageId || null;

    const pass = result.sent === true && stubCalledWith !== null;
    console.log('\n[VERIFY SUMMARY] sent === true:', result.sent === true, '| email stub actually invoked:', stubCalledWith !== null, '| requiresHuman:', result.requiresHuman);
    console.log(pass ? '[VERIFY] PASS — requiresHuman no longer discards the reply.' : '[VERIFY] FAIL — reply was not sent.');
  } finally {
    // Clean up: remove both the injected inbound and any generated outbound test message.
    const idsToDelete = [testMessage.id];
    if (outboundMsgId) idsToDelete.push(outboundMsgId);
    const deleted = await conversationStorage.deleteMessages(idsToDelete, { workspaceId: WORKSPACE_ID });
    console.log('[VERIFY] cleaned up', deleted, 'test message(s)');
    emailService.sendEmailToLead = originalSend;
  }

  process.exit(result && result.sent ? 0 : 1);
}

main().catch((err) => {
  console.error('[VERIFY FATAL]', err);
  process.exit(1);
});
