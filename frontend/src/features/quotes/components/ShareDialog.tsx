import { useEffect, useMemo, useState } from 'react';
import { SalesDocument, salesDocumentPdfUrl, sendSalesDocument, shareSalesDocument } from '../../../lib/apiClient';
import { mailtoShareUrl, resolvePublicShareUrl, smsShareUrl, whatsAppShareUrl } from '../utils/shareUrl';

type Channel = 'whatsapp' | 'email' | 'sms';

export default function ShareDialog({
  open,
  document,
  conversationId,
  onClose,
  onSent,
  onError,
}: {
  open: boolean;
  document: SalesDocument | null;
  conversationId?: string;
  onClose: () => void;
  onSent?: (doc: SalesDocument, channel: Channel) => void;
  onError?: (msg: string) => void;
}) {
  const [busy, setBusy] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !document?.id) return;
    let cancelled = false;
    (async () => {
      setBusy('Preparing share link…');
      try {
        const res = await shareSalesDocument(document.id);
        if (cancelled) return;
        setShareUrl(res.shareUrl || '');
        setToken(res.token || '');
      } catch (e: any) {
        onError?.(e?.response?.data?.error || e.message || 'Could not create share link');
      } finally {
        if (!cancelled) setBusy('');
      }
    })();
    return () => { cancelled = true; };
  }, [open, document?.id, onError]);

  const publicLink = useMemo(
    () => (token ? resolvePublicShareUrl(shareUrl, token) : ''),
    [shareUrl, token],
  );

  const label = document?.docType === 'invoice' ? 'Invoice' : 'Quotation';
  const shareText = document
    ? `${label} ${document.number} — ${document.currency} ${Number(document.total || 0).toFixed(2)}\n${publicLink}`
    : publicLink;

  const copyLink = async () => {
    if (!publicLink) return;
    await navigator.clipboard.writeText(publicLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadPdf = () => {
    if (!document?.id) return;
    window.open(salesDocumentPdfUrl(document.id), '_blank', 'noopener');
  };

  const printDoc = () => {
    if (!document?.id) return;
    const w = window.open(salesDocumentPdfUrl(document.id), '_blank', 'noopener');
    w?.addEventListener('load', () => w.print());
  };

  const sendVia = async (channel: Channel) => {
    if (!document?.id) return;
    setBusy(`Sending via ${channel}…`);
    try {
      const res = await sendSalesDocument(document.id, { channel, conversationId });
      onSent?.(res.document, channel);
      onClose();
    } catch (e: any) {
      onError?.(e?.response?.data?.error || e.message || 'Send failed');
    } finally {
      setBusy('');
    }
  };

  if (!open || !document) return null;

  return (
    <div className="qi-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="qi-share-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="qi-share-header">
          <div>
            <h3>Share {label}</h3>
            <p className="qi-share-sub">{document.number} · {document.customer?.company || document.customer?.name || 'Customer'}</p>
          </div>
          <button type="button" className="qi-share-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {busy && <div className="qi-share-busy">{busy}</div>}

        <div className="qi-share-grid">
          <button type="button" className="qi-share-action" disabled={!!busy} onClick={() => void sendVia('whatsapp')}>
            <span className="qi-share-icon wa">WA</span>
            <span>WhatsApp</span>
          </button>
          <button type="button" className="qi-share-action" disabled={!!busy} onClick={() => void sendVia('email')}>
            <span className="qi-share-icon em">@</span>
            <span>Email</span>
          </button>
          <button type="button" className="qi-share-action" disabled={!!busy} onClick={() => void sendVia('sms')}>
            <span className="qi-share-icon sms">SMS</span>
            <span>SMS</span>
            <small className="qi-share-hint">Link only — no PDF attachment</small>
          </button>
          <button type="button" className="qi-share-action" disabled={!!busy || !publicLink} onClick={() => void copyLink()}>
            <span className="qi-share-icon link">⎘</span>
            <span>{copied ? 'Copied!' : 'Copy public link'}</span>
          </button>
          <button type="button" className="qi-share-action" disabled={!!busy} onClick={downloadPdf}>
            <span className="qi-share-icon pdf">PDF</span>
            <span>Download PDF</span>
          </button>
          <button type="button" className="qi-share-action" disabled={!!busy} onClick={printDoc}>
            <span className="qi-share-icon pr">⎙</span>
            <span>Print</span>
          </button>
        </div>

        <div className="qi-share-external">
          <span className="qi-field-label">Open in apps</span>
          <div className="qi-share-external-row">
            <a className="qi-btn ghost" href={whatsAppShareUrl(shareText)} target="_blank" rel="noreferrer">WhatsApp Web</a>
            <a className="qi-btn ghost" href={mailtoShareUrl(`${label} ${document.number}`, shareText)}>Email app</a>
            <a className="qi-btn ghost" href={smsShareUrl(shareText)}>SMS app</a>
          </div>
        </div>

        {publicLink && copied && (
          <p className="qi-share-copied-note">Public link copied to clipboard.</p>
        )}
      </div>
    </div>
  );
}
