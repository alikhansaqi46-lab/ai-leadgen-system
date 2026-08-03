import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SalesDocument,
  SalesLineItem,
  aiFromConversationSalesDocument,
  aiGenerateSalesDocument,
  convertQuoteToInvoice,
  createSalesDocument,
  getQuoteBillingProfile,
  getSalesDocument,
  saveQuoteCustomer,
  sendSalesDocument,
  updateSalesDocument,
} from '../../../lib/apiClient';
import EditableDocumentPreview from '../EditableDocumentPreview';
import DocumentTimeline from './DocumentTimeline';
import ShareDialog from './ShareDialog';
import SegmentedControl from './SegmentedControl';
import {
  EMPTY_ITEM,
  WorkflowMode,
  WORKFLOW_KEY,
  baseCompany,
  calcTotals,
  formatSaveSuccess,
  isRealLeadId,
  normalizeSendChannel,
  readWorkflowMode,
} from '../quoteWorkflowUtils';
import '../quotes.css';

export type QuoteDrawerContext = {
  conversationId?: string;
  leadId?: string;
  leadName?: string;
  channel?: string;
  /** Document type to create when opening a fresh drawer */
  docType?: 'quote' | 'invoice';
  /** Open an existing quote/invoice in the shared editor */
  documentId?: string;
};

export default function QuoteFromConversationDrawer({
  open,
  context,
  onClose,
  onComplete,
  onRefresh,
}: {
  open: boolean;
  context: QuoteDrawerContext | null;
  onClose: () => void;
  onComplete?: (doc: SalesDocument) => void;
  onRefresh?: () => void;
}) {
  const [doc, setDoc] = useState<Partial<SalesDocument> | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [profile, setProfile] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>(readWorkflowMode);
  const [aiPrompt, setAiPrompt] = useState('');
  const [createMode, setCreateMode] = useState<'conversation' | 'prompt'>('conversation');
  const [docKind, setDocKind] = useState<'quote' | 'invoice'>(context?.docType || 'quote');

  const live = useMemo(() => (doc ? { ...doc, ...calcTotals(doc) } : null), [doc]);
  const isInvoice = live ? live.docType === 'invoice' : docKind === 'invoice';
  const kindLabel = isInvoice ? 'Invoice' : 'Quotation';
  const canConvert =
    Boolean(doc?.id) &&
    doc?.docType === 'quote' &&
    ['sent', 'viewed', 'accepted'].includes(String(doc?.status || '')) &&
    !doc?.meta?.convertedInvoiceId;

  const showApprove =
    Boolean(live) &&
    (pendingApproval || live?.status === 'draft') &&
    !['sent', 'converted', 'paid', 'partially_paid'].includes(String(live?.status || ''));

  useEffect(() => {
    if (!open) return;
    setWorkflowMode(readWorkflowMode());
    getQuoteBillingProfile().then((r) => setProfile(r.profile || null)).catch(() => null);
  }, [open]);

  useEffect(() => {
    if (!open || !context) return;
    setMsg('');
    setError('');
    setShareOpen(false);
    setPendingApproval(false);
    setAiPrompt('');
    setCreateMode('conversation');
    setDocKind(context.docType || 'quote');

    if (context.documentId) {
      setBusy('Loading document…');
      getSalesDocument(context.documentId)
        .then((res) => {
          setDoc(res.document);
          setEvents(res.events || []);
          setPendingApproval(res.document.status === 'draft');
        })
        .catch((e: any) => {
          setDoc(null);
          setError(e?.response?.data?.error || e.message || 'Failed to load document');
        })
        .finally(() => setBusy(''));
      return;
    }

    setDoc(null);
    setEvents([]);
  }, [open, context?.conversationId, context?.leadId, context?.documentId]);

  const patchDoc = (patch: Partial<SalesDocument>) => setDoc((d) => (d ? { ...d, ...patch } : d));

  const patchItem = (idx: number, patch: Partial<SalesLineItem>) => {
    setDoc((d) => {
      if (!d) return d;
      const lineItems = [...(d.lineItems || [])];
      lineItems[idx] = { ...lineItems[idx], ...patch };
      return { ...d, lineItems };
    });
  };

  const duplicateItem = (idx: number) => {
    setDoc((d) => {
      if (!d) return d;
      const lineItems = [...(d.lineItems || [])];
      lineItems.splice(idx + 1, 0, { ...lineItems[idx], id: undefined });
      return { ...d, lineItems };
    });
  };

  const moveItem = (from: number, to: number) => {
    setDoc((d) => {
      if (!d) return d;
      const lineItems = [...(d.lineItems || [])];
      const [row] = lineItems.splice(from, 1);
      lineItems.splice(to, 0, row);
      return { ...d, lineItems };
    });
  };

  const persistDoc = useCallback(async (current: Partial<SalesDocument>) => {
    const totals = calcTotals(current);
    const body = {
      ...current,
      ...totals,
      status: current.status || 'draft',
      meta: {
        ...(current.meta || {}),
        ...(context?.conversationId ? { sourceConversationId: context.conversationId } : {}),
      },
    };
    const isNew = !current.id;
    const res = isNew
      ? await createSalesDocument(body as any)
      : await updateSalesDocument(current.id!, body);

    let saved = res.document;
    if (saved.id) {
      const link = await saveQuoteCustomer(saved.id, saved.customer || current.customer);
      saved = link.document || saved;
      const detail = await getSalesDocument(saved.id);
      setEvents(detail.events || []);
    }
    setDoc(saved);
    return { saved, isNew };
  }, [context?.conversationId]);

  const finishSent = useCallback(async (updated: SalesDocument, channel: string) => {
    setDoc(updated);
    setPendingApproval(false);
    setShareOpen(false);
    if (updated.id) {
      const detail = await getSalesDocument(updated.id);
      setEvents(detail.events || []);
    }
    setMsg(`${updated.docType === 'invoice' ? 'Invoice' : 'Quotation'} ${updated.number} sent via ${channel}`);
    onComplete?.(updated);
    window.setTimeout(() => onClose(), 900);
  }, [onClose, onComplete]);

  const applyGenerated = (generated: Partial<SalesDocument>, messageCount?: number) => {
    const mergedCompany = { ...(generated.company || {}), ...baseCompany(profile) };
    setDoc({
      ...generated,
      docType: generated.docType === 'invoice' ? 'invoice' : 'quote',
      company: mergedCompany,
      leadId: generated.leadId || context?.leadId,
      meta: {
        ...(generated.meta || {}),
        ...(context?.conversationId ? { sourceConversationId: context.conversationId } : {}),
      },
      lineItems: generated.lineItems?.length ? generated.lineItems : [EMPTY_ITEM()],
    });
    setEvents([]);
    setPendingApproval(workflowMode === 'approval');
    setMsg(
      messageCount
        ? `Generated from ${messageCount} conversation messages — review and send`
        : 'Document generated — review, edit, then Approve & Send',
    );
  };

  const generateFromConversation = async () => {
    if (!context?.conversationId && !isRealLeadId(context?.leadId)) {
      setError('Open a conversation to generate a quotation');
      return;
    }
    if (!context?.conversationId) {
      setError('Documents must be generated from an Inbox conversation');
      return;
    }
    const autoMode = workflowMode === 'auto';
    setBusy('AI is reading the conversation…');
    setError('');
    setMsg('');
    try {
      const res = await aiFromConversationSalesDocument({
        conversationId: context.conversationId,
        docType: docKind,
        autoMode,
      });
      const generated = res.document || {};

      if (autoMode && (res.autoSent || generated.id)) {
        if (res.autoSent) {
          await finishSent(generated as SalesDocument, res.primaryChannel || context.channel || 'email');
          return;
        }
        const channel = normalizeSendChannel(res.primaryChannel || context.channel);
        setBusy(`Sending via ${channel}…`);
        const sendRes = await sendSalesDocument(generated.id!, {
          channel,
          conversationId: context.conversationId,
        });
        await finishSent(sendRes.document, channel);
        return;
      }

      applyGenerated(generated, res.messageCount);
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Generation failed');
    } finally {
      setBusy('');
    }
  };

  const generateWithPrompt = async () => {
    if (!aiPrompt.trim()) {
      setError('Write a prompt describing the quotation');
      return;
    }
    if (!context?.conversationId) {
      setError('Documents must be created inside an Inbox conversation');
      return;
    }
    setBusy(`AI is generating your ${docKind === 'invoice' ? 'invoice' : 'quotation'}…`);
    setError('');
    setMsg('');
    try {
      const res = await aiGenerateSalesDocument({
        prompt: aiPrompt.trim(),
        docType: docKind,
        leadId: isRealLeadId(context.leadId) ? context.leadId : undefined,
        conversationId: context.conversationId,
      });
      applyGenerated(res.document || {});
      if (workflowMode === 'auto' && res.document?.id) {
        const channel = normalizeSendChannel(context.channel);
        setBusy(`Sending via ${channel}…`);
        const sendRes = await sendSalesDocument(res.document.id, {
          channel,
          conversationId: context.conversationId,
        });
        await finishSent(sendRes.document, channel);
      }
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Generation failed');
    } finally {
      setBusy('');
    }
  };

  const saveDoc = async () => {
    if (!doc) return;
    setBusy('Saving…');
    setError('');
    try {
      const { saved, isNew } = await persistDoc(doc);
      setMsg(formatSaveSuccess(saved, isNew));
      setPendingApproval(true);
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Save failed');
    } finally {
      setBusy('');
    }
  };

  const approveAndSend = async () => {
    if (!doc) return;
    const channel = normalizeSendChannel(context?.channel);
    setBusy(`Saving ${kindLabel.toLowerCase()}…`);
    setError('');
    try {
      const { saved } = await persistDoc(doc);
      setBusy(`Sending via ${channel}…`);
      const sendRes = await sendSalesDocument(saved.id, {
        channel,
        conversationId: context?.conversationId || saved.meta?.sourceConversationId,
      });
      await finishSent(sendRes.document, channel);
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Approve & Send failed');
      setBusy('');
      onRefresh?.();
    }
  };

  const handleConvert = async () => {
    if (!doc?.id || doc.docType !== 'quote') return;
    setBusy('Converting to invoice…');
    setError('');
    try {
      const res = await convertQuoteToInvoice(doc.id, {
        conversationId: context?.conversationId || doc.meta?.sourceConversationId,
      });
      const invoice = res.invoice as SalesDocument;
      const detail = await getSalesDocument(invoice.id);
      setDoc(detail.document);
      setEvents(detail.events || []);
      setPendingApproval(true);
      setMsg(`Invoice ${invoice.number} created from quotation — review and send`);
      onRefresh?.();
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Convert failed');
    } finally {
      setBusy('');
    }
  };

  if (!open || !context) return null;

  const title = context.leadName || 'Customer';
  const showEditorActions = Boolean(live);

  return (
    <>
      <div className="qi-drawer-backdrop" role="presentation" onClick={onClose}>
        <aside className="qi-conversation-drawer" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <header className="qi-drawer-header">
            <div>
              <h3>{kindLabel} for {title}</h3>
              <p className="qi-share-sub">
                {live?.docType === 'invoice' && doc?.quoteId
                  ? 'Converted from quotation — edit anything, then Approve & Send'
                  : `Create, edit, and send ${isInvoice ? 'invoices' : 'quotations'} from this Inbox conversation`}
              </p>
            </div>
            <button type="button" className="qi-share-close" onClick={onClose} aria-label="Close">×</button>
          </header>

          {msg && <div className="lf-alert qi-success-alert qi-drawer-alert">{msg}</div>}
          {error && <div className="lf-alert-error qi-drawer-alert">{error}</div>}
          {busy && <div className="lf-alert qi-busy-banner qi-drawer-alert">{busy}</div>}

          {!doc && !context.documentId && (
            <div className="qi-drawer-setup">
              <div className="qi-builder-field">
                <span className="qi-field-label">Document type</span>
                <SegmentedControl
                  options={[
                    { value: 'quote' as const, label: 'Quotation' },
                    { value: 'invoice' as const, label: 'Invoice' },
                  ]}
                  value={docKind}
                  onChange={setDocKind}
                />
              </div>
              <div className="qi-builder-field">
                <span className="qi-field-label">Create {docKind === 'invoice' ? 'invoice' : 'quotation'}</span>
                <SegmentedControl
                  options={[
                    { value: 'conversation' as const, label: 'From conversation' },
                    { value: 'prompt' as const, label: 'With AI prompt' },
                  ]}
                  value={createMode}
                  onChange={setCreateMode}
                />
              </div>
              <div className="qi-builder-field">
                <span className="qi-field-label">Workflow</span>
                <SegmentedControl
                  options={[
                    { value: 'auto' as WorkflowMode, label: 'Auto Mode' },
                    { value: 'approval' as WorkflowMode, label: 'Human Approval' },
                  ]}
                  value={workflowMode}
                  onChange={(v) => {
                    setWorkflowMode(v);
                    localStorage.setItem(WORKFLOW_KEY, v);
                  }}
                />
              </div>

              {createMode === 'prompt' && (
                <div className="qi-builder-field">
                  <span className="qi-field-label">AI prompt</span>
                  <textarea
                    className="qi-ai-prompt"
                    rows={4}
                    value={aiPrompt}
                    placeholder="Describe products, prices, taxes, payment terms, validity…"
                    onChange={(e) => setAiPrompt(e.target.value)}
                  />
                </div>
              )}

              <button
                type="button"
                className="qi-generate-btn qi-drawer-generate"
                disabled={!!busy}
                onClick={() => void (createMode === 'prompt' ? generateWithPrompt() : generateFromConversation())}
              >
                {busy
                  ? 'Generating…'
                  : createMode === 'prompt'
                    ? 'Generate with AI'
                    : 'Generate from conversation'}
              </button>
            </div>
          )}

          {showEditorActions && live && (
            <>
              <div className="qi-drawer-toolbar">
                <span className={`qi-status ${live.status || 'draft'}`}>{live.status || 'draft'}</span>
                <div className="qi-drawer-toolbar-actions">
                  {showApprove && (
                    <button type="button" className="qi-btn primary qi-approve-btn" disabled={!!busy} onClick={() => void approveAndSend()}>
                      Approve &amp; Send
                    </button>
                  )}
                  {canConvert && (
                    <button type="button" className="qi-btn primary" disabled={!!busy} onClick={() => void handleConvert()}>
                      Convert to Invoice
                    </button>
                  )}
                  {doc?.id && (
                    <button type="button" className="qi-btn ghost" disabled={!!busy} onClick={() => setShareOpen(true)}>Share</button>
                  )}
                  {live.status !== 'converted' && (
                    <button type="button" className="qi-btn primary" disabled={!!busy} onClick={() => void saveDoc()}>Save</button>
                  )}
                </div>
              </div>

              <div className="qi-drawer-body">
                <div className="qi-drawer-preview">
                  <EditableDocumentPreview
                    doc={live}
                    onPatch={patchDoc}
                    onPatchItem={patchItem}
                    onAddItem={() => patchDoc({ lineItems: [...(live.lineItems || []), EMPTY_ITEM()] })}
                    onRemoveItem={(idx) => patchDoc({ lineItems: (live.lineItems || []).filter((_, i) => i !== idx) })}
                    onDuplicateItem={duplicateItem}
                    onMoveItem={moveItem}
                  />
                </div>
                <DocumentTimeline events={events} status={live.status} />
              </div>
            </>
          )}
        </aside>
      </div>

      <ShareDialog
        open={shareOpen}
        document={doc?.id ? (live as SalesDocument) : null}
        conversationId={context.conversationId}
        onClose={() => setShareOpen(false)}
        onSent={(updated, channel) => {
          void finishSent(updated, channel);
        }}
        onError={(m) => setError(m)}
      />
    </>
  );
}
