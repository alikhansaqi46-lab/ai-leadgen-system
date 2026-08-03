import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getPublicSalesDocument, SalesDocument } from '../../lib/apiClient';
import DocumentPreview from './DocumentPreview';
import './quotes.css';

/** Customer-facing quote/invoice view — no owner/admin controls. */
export default function ShareQuotePage() {
  const { token } = useParams<{ token: string }>();
  const [doc, setDoc] = useState<SalesDocument | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    getPublicSalesDocument(token)
      .then((res) => setDoc(res.document))
      .catch((e) => setError(e?.response?.data?.error || e.message || 'Unable to load document'))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="qi-share-page qi-customer-page">
        <p className="qi-customer-loading">Loading your document…</p>
      </div>
    );
  }
  if (error || !doc) {
    return (
      <div className="qi-share-page qi-customer-page">
        <p className="lf-alert-error">{error || 'Document not found'}</p>
      </div>
    );
  }

  const kind = doc.docType === 'invoice' ? 'Invoice' : 'Quotation';
  const company = doc.company?.companyName || doc.company?.name || 'LeadFlow AI';

  return (
    <div className="qi-share-page qi-customer-page">
      <header className="qi-customer-header">
        <div className="qi-customer-brand">{company}</div>
        <div className="qi-customer-subtitle">{kind} {doc.number}</div>
      </header>

      <DocumentPreview doc={doc} />

      <div className="qi-share-actions qi-customer-actions">
        <a
          className="lf-btn primary"
          href={`/api/public/quotes/${token}/pdf`}
          target="_blank"
          rel="noreferrer"
        >
          Download PDF
        </a>
      </div>

      <p className="qi-customer-footnote">
        This is your official {kind.toLowerCase()}. For questions, reply to the email you received.
      </p>
    </div>
  );
}
