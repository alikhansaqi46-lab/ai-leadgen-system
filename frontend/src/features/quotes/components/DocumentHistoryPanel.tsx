import { useCallback, useEffect, useState } from 'react';
import {
  SalesDocument,
  convertQuoteToInvoice,
  duplicateSalesDocument,
  listSalesDocuments,
} from '../../../lib/apiClient';
import type { QuoteDrawerContext } from './QuoteFromConversationDrawer';
import { money } from '../quoteWorkflowUtils';

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function customerOf(doc: SalesDocument) {
  return doc.customer?.company || doc.customer?.name || '—';
}

export default function DocumentHistoryPanel({
  refreshEpoch = 0,
  onOpenDocument,
}: {
  refreshEpoch?: number;
  onOpenDocument: (ctx: QuoteDrawerContext) => void;
}) {
  const [quotes, setQuotes] = useState<SalesDocument[]>([]);
  const [invoices, setInvoices] = useState<SalesDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [q, i] = await Promise.all([
        listSalesDocuments({ docType: 'quote', limit: 200 }),
        listSalesDocuments({ docType: 'invoice', limit: 200 }),
      ]);
      setQuotes(q.items || []);
      setInvoices(i.items || []);
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshEpoch]);

  const openDoc = (doc: SalesDocument) => {
    onOpenDocument({
      documentId: doc.id,
      leadId: doc.leadId || undefined,
      leadName: customerOf(doc),
      conversationId: doc.meta?.sourceConversationId || undefined,
      channel: 'email',
      docType: doc.docType === 'invoice' ? 'invoice' : 'quote',
    });
  };

  const handleDuplicate = async (doc: SalesDocument) => {
    setBusyId(doc.id!);
    setNotice('');
    setError('');
    try {
      const res = await duplicateSalesDocument(doc.id!);
      setNotice(`${res.document.docType === 'invoice' ? 'Invoice' : 'Quotation'} duplicated as ${res.document.number} (draft)`);
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Duplicate failed');
    } finally {
      setBusyId('');
    }
  };

  const handleConvert = async (doc: SalesDocument) => {
    setBusyId(doc.id!);
    setNotice('');
    setError('');
    try {
      const res = await convertQuoteToInvoice(doc.id!, {
        conversationId: doc.meta?.sourceConversationId || undefined,
      });
      setNotice(`Invoice ${res.invoice.number} created from quotation ${doc.number}`);
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Convert failed');
    } finally {
      setBusyId('');
    }
  };

  const renderRow = (doc: SalesDocument, kind: 'quote' | 'invoice') => {
    const canConvert = kind === 'quote'
      && ['sent', 'viewed', 'accepted'].includes(String(doc.status || ''))
      && !doc.meta?.convertedInvoiceId;
    return (
      <tr key={doc.id}>
        <td><strong>{doc.number}</strong></td>
        <td>{customerOf(doc)}</td>
        <td>{fmtDate(doc.sentAt || doc.createdAt)}</td>
        <td><span className={`qi-status ${doc.status || 'draft'}`}>{doc.status || 'draft'}</span></td>
        <td>{money(doc.total || 0, doc.currency || 'MYR')}</td>
        <td>
          <div className="qi-doc-actions">
            <button type="button" className="lf-btn" style={{ height: 26, padding: '0 8px', fontSize: 11 }} disabled={busyId === doc.id} onClick={() => openDoc(doc)}>View</button>
            <a className="lf-btn" style={{ height: 26, padding: '0 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center' }} href={`/api/quotes/${doc.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
            {kind === 'quote' && (
              <button type="button" className="lf-btn" style={{ height: 26, padding: '0 8px', fontSize: 11 }} disabled={busyId === doc.id} onClick={() => void handleDuplicate(doc)}>Duplicate</button>
            )}
            {canConvert && (
              <button type="button" className="lf-btn" style={{ height: 26, padding: '0 8px', fontSize: 11 }} disabled={busyId === doc.id} onClick={() => void handleConvert(doc)}>Convert to Invoice</button>
            )}
          </div>
        </td>
      </tr>
    );
  };

  const renderTable = (docs: SalesDocument[], kind: 'quote' | 'invoice') => (
    docs.length === 0 ? (
      <div className="lf-muted" style={{ padding: '12px 4px', fontSize: 12 }}>
        {kind === 'quote' ? 'No quotations yet.' : 'No invoices yet.'}
      </div>
    ) : (
      <table className="qi-doc-table">
        <thead>
          <tr>
            <th>{kind === 'quote' ? 'Quote Number' : 'Invoice Number'}</th>
            <th>Customer</th>
            <th>Date</th>
            <th>Status</th>
            <th>Total</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>{docs.map((d) => renderRow(d, kind))}</tbody>
      </table>
    )
  );

  return (
    <div className="qi-doc-history">
      {error && <div className="lf-alert-error" style={{ marginBottom: 10 }}>{error}</div>}
      {notice && <div className="lf-alert qi-success-alert" style={{ marginBottom: 10 }}>{notice}</div>}
      <div className="lf-card" style={{ marginBottom: 14 }}>
        <div className="lf-card-header">
          <h2 className="lf-card-title">Sent Quotations</h2>
          <span className="lf-muted" style={{ fontSize: 12 }}>{quotes.length} total</span>
        </div>
        {loading ? <div className="lf-muted" style={{ padding: 12 }}>Loading…</div> : renderTable(quotes, 'quote')}
      </div>
      <div className="lf-card">
        <div className="lf-card-header">
          <h2 className="lf-card-title">Sent Invoices</h2>
          <span className="lf-muted" style={{ fontSize: 12 }}>{invoices.length} total</span>
        </div>
        {loading ? <div className="lf-muted" style={{ padding: 12 }}>Loading…</div> : renderTable(invoices, 'invoice')}
      </div>
    </div>
  );
}
