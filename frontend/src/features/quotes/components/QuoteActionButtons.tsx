import type { QuoteDrawerContext } from './QuoteFromConversationDrawer';
import { isRealLeadId } from '../quoteWorkflowUtils';

/** Inbox-only entry: create a Quotation or Invoice directly from a conversation. */
export default function QuoteActionButtons({
  conversationId,
  leadId,
  leadName,
  channel,
  onOpen,
  compact,
}: {
  conversationId?: string | null;
  leadId?: string | null;
  leadName?: string;
  channel?: string;
  onOpen: (ctx: QuoteDrawerContext) => void;
  compact?: boolean;
}) {
  const canQuote = Boolean(conversationId) || isRealLeadId(leadId);
  if (!canQuote || !conversationId) return null;

  const style = compact
    ? { height: 28, padding: '0 10px', fontSize: 11 }
    : { height: 32, padding: '0 10px', fontSize: 12 };

  const openFor = (docType: 'quote' | 'invoice') => onOpen({
    conversationId: conversationId || undefined,
    leadId: isRealLeadId(leadId) ? leadId! : undefined,
    leadName,
    channel,
    docType,
  });

  return (
    <>
      <button
        type="button"
        className="lf-btn qi-quote-action"
        style={style}
        onClick={() => openFor('quote')}
        title="Create quotation in this conversation"
      >
        Quote
      </button>
      <button
        type="button"
        className="lf-btn qi-quote-action"
        style={style}
        onClick={() => openFor('invoice')}
        title="Create invoice in this conversation"
      >
        Invoice
      </button>
    </>
  );
}
