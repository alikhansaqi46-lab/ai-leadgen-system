import { useEffect, useRef, useState } from 'react';
import {
  SalesDocument,
  convertQuoteToInvoice,
  deleteSalesDocument,
  duplicateSalesDocument,
  getSalesDocument,
  salesDocumentPdfUrl,
  shareSalesDocument,
} from '../../../lib/apiClient';
import type { QuoteDrawerContext } from './QuoteFromConversationDrawer';
import ShareDialog from './ShareDialog';
import DocumentTimeline from './DocumentTimeline';
import { extractShareToken, salesDocumentPublicPdfUrl } from '../utils/shareUrl';

type QuoteCardMeta = {
  quoteCard?: boolean;
  quoteId?: string;
  docType?: string;
  number?: string;
  total?: number;
  currency?: string;
  status?: string;
  shareUrl?: string;
  customerName?: string;
  sendError?: string;
  publicToken?: string;
  items?: Array<{ name: string; qty: number; total: number }>;
  itemCount?: number;
  subtotal?: number;
  discountTotal?: number;
  taxTotal?: number;
  sentAt?: string;
};

function downloadCsv(doc: SalesDocument) {
  const rows = [
    ['Number', 'Type', 'Status', 'Customer', 'Currency', 'Subtotal', 'Tax', 'Discount', 'Total'],
    [
      doc.number,
      doc.docType,
      doc.status,
      doc.customer?.company || doc.customer?.name || '',
      doc.currency,
      String(doc.subtotal ?? ''),
      String(doc.taxAmount ?? ''),
      String(doc.discountAmount ?? ''),
      String(doc.total ?? ''),
    ],
    [],
    ['Product', 'Description', 'Qty', 'Unit Price', 'Discount', 'Amount'],
    ...(doc.lineItems || []).map((it) => [
      it.description || '',
      it.unit || '',
      String(it.quantity ?? ''),
      String(it.unitPrice ?? ''),
      String(it.discount ?? ''),
      String(it.amount ?? ''),
    ]),
  ];
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${doc.number || doc.id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ThreadDocumentActions({
  meta,
  conversationId,
  channel,
  leadId,
  leadName,
  onOpenDrawer,
  onRefresh,
}: {
  meta: QuoteCardMeta;
  conversationId?: string;
  channel?: string;
  leadId?: string;
  leadName?: string;
  onOpenDrawer: (ctx: QuoteDrawerContext) => void;
  onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [doc, setDoc] = useState<SalesDocument | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const quoteId = meta.quoteId;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const loadDoc = async () => {
    if (!quoteId) throw new Error('Missing document id');
    const res = await getSalesDocument(quoteId);
    setDoc(res.document);
    setEvents(res.events || []);
    return res.document;
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try {
      await fn();
      setOpen(false);
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Action failed');
    } finally {
      setBusy('');
    }
  };

  if (!quoteId) return null;

  const isQuote = meta.docType !== 'invoice';
  const canConvert = isQuote && meta.status !== 'converted';
  const shareToken = extractShareToken(meta);
  const pdfHref = shareToken ? salesDocumentPublicPdfUrl(shareToken) : salesDocumentPdfUrl(quoteId);

  return (
    <div className="qi-thread-actions-wrap" ref={menuRef}>
      <div className="qi-thread-quote-actions">
        {meta.shareUrl && (
          <a className="lf-btn" href={meta.shareUrl} target="_blank" rel="noreferrer" style={{ height: 28, padding: '0 10px', fontSize: 11 }}>
            Open link
          </a>
        )}
        <a className="lf-btn" href={pdfHref} target="_blank" rel="noreferrer" style={{ height: 28, padding: '0 10px', fontSize: 11 }}>
          PDF
        </a>
        <button
          type="button"
          className="lf-btn"
          style={{ height: 28, padding: '0 10px', fontSize: 11 }}
          onClick={() => setOpen((v) => !v)}
        >
          Actions ▾
        </button>
      </div>
      <div className="qi-thread-owner-hint">Owner tools — not visible to customer</div>

      {open && (
        <div className="qi-thread-actions-menu">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenDrawer({
                conversationId,
                leadId,
                leadName,
                channel,
                documentId: quoteId,
              });
            }}
          >
            Edit
          </button>
          {canConvert && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void run('Converting…', async () => {
                const res = await convertQuoteToInvoice(quoteId, { conversationId });
                onRefresh?.();
                onOpenDrawer({
                  conversationId,
                  leadId,
                  leadName,
                  channel,
                  documentId: res.invoice.id,
                });
              })}
            >
              Convert to Invoice
            </button>
          )}
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('Duplicating…', async () => {
              const res = await duplicateSalesDocument(quoteId);
              onRefresh?.();
              onOpenDrawer({
                conversationId,
                leadId,
                leadName,
                channel,
                documentId: res.document.id,
              });
            })}
          >
            Duplicate
          </button>
          <button
            type="button"
            onClick={() => {
              window.open(pdfHref, '_blank', 'noopener,noreferrer');
              setOpen(false);
            }}
          >
            Download PDF
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('Exporting…', async () => {
              const d = doc || (await loadDoc());
              downloadCsv(d);
            })}
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => {
              const w = window.open(pdfHref, '_blank', 'noopener,noreferrer');
              if (w) {
                w.addEventListener('load', () => {
                  try { w.print(); } catch { /* ignore */ }
                });
              }
              setOpen(false);
            }}
          >
            Print
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('Preparing share…', async () => {
              await shareSalesDocument(quoteId);
              const d = await loadDoc();
              setDoc(d);
              setShareOpen(true);
            })}
          >
            Share
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('Loading history…', async () => {
              await loadDoc();
              setHistoryOpen(true);
            })}
          >
            View History
          </button>
          <button
            type="button"
            className="qi-thread-action-danger"
            disabled={!!busy}
            onClick={() => void run('Deleting…', async () => {
              if (!window.confirm(`Delete ${meta.number || 'this document'}?`)) return;
              await deleteSalesDocument(quoteId);
              onRefresh?.();
            })}
          >
            Delete
          </button>
        </div>
      )}

      {(busy || error) && (
        <div className="qi-thread-action-status">
          {busy || error}
        </div>
      )}

      {historyOpen && (
        <div className="qi-history-modal-backdrop" onClick={() => setHistoryOpen(false)}>
          <div className="qi-history-modal" onClick={(e) => e.stopPropagation()}>
            <header className="qi-drawer-header">
              <h3>Document history — {meta.number}</h3>
              <button type="button" className="qi-share-close" onClick={() => setHistoryOpen(false)}>×</button>
            </header>
            <DocumentTimeline events={events} status={doc?.status || meta.status} />
          </div>
        </div>
      )}

      <ShareDialog
        open={shareOpen}
        document={doc}
        conversationId={conversationId}
        onClose={() => setShareOpen(false)}
        onSent={() => {
          setShareOpen(false);
          onRefresh?.();
        }}
        onError={(m) => setError(m)}
      />
    </div>
  );
}
