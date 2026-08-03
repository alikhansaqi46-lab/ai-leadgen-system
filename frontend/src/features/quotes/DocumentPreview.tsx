import { CSSProperties } from 'react';
import { SalesDocument, SalesLineItem } from '../../lib/apiClient';

type PreviewDoc = Partial<SalesDocument> & {
  lineItems?: SalesLineItem[];
  company?: SalesDocument['company'];
  customer?: SalesDocument['customer'];
};

function money(n: number | undefined | null, currency = 'MYR') {
  return `${currency} ${Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDate(value?: string | null) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

function lineTotal(it: SalesLineItem) {
  const qty = Number(it.quantity) || 0;
  const unit = Number(it.unitPrice) || 0;
  const disc = Number(it.discount) || 0;
  return Math.max(0, qty * unit - disc);
}

export default function DocumentPreview({ doc }: { doc: PreviewDoc; shareUrl?: string; paymentLink?: string }) {
  const company = doc.company || {};
  const customer = doc.customer || {};
  const currency = doc.currency || 'MYR';
  const isInvoice = doc.docType === 'invoice';
  const title = isInvoice ? 'INVOICE' : 'QUOTATION';
  const issueDate = fmtDate(doc.createdAt || new Date().toISOString());
  const dueDate = isInvoice ? fmtDate(doc.dueDate) : fmtDate(doc.validUntil);
  const dueLabel = isInvoice ? 'Due Date' : 'Valid Until';

  const items = doc.lineItems || [];
  const subtotal = Number(doc.subtotal) || items.reduce((s, it) => s + lineTotal(it), 0);
  const discountAmount = Number(doc.discountAmount) || 0;
  const taxAmount = Number(doc.taxAmount) || 0;
  const shipping = Number(doc.shipping) || 0;
  const total = Number(doc.total) || (subtotal - discountAmount + taxAmount + shipping);

  const showDiscount = discountAmount > 0;
  const showTax = taxAmount > 0;
  const showShipping = shipping > 0;

  const companyName = company.companyName || company.name || '';
  const customerName = customer.company || customer.name || '';

  const accentColor = '#111827';

  return (
    <article className="qdoc-page" style={{ '--qdoc-accent': accentColor } as CSSProperties}>

      {/* Header */}
      <header className="qdoc-header">
        <div className="qdoc-from">
          {company.logoUrl ? (
            <img src={company.logoUrl} alt="" className="qdoc-logo" />
          ) : companyName ? (
            <div className="qdoc-logo-initial">{companyName.slice(0, 1).toUpperCase()}</div>
          ) : null}
          <div className="qdoc-from-info">
            {companyName && <div className="qdoc-company-name">{companyName}</div>}
            {company.address && <div className="qdoc-meta-line">{company.address}</div>}
            {company.email && <div className="qdoc-meta-line">{company.email}</div>}
            {company.phone && <div className="qdoc-meta-line">{company.phone}</div>}
          </div>
        </div>

        <div className="qdoc-title-block">
          <div className="qdoc-title">{title}</div>
          <div className="qdoc-meta-grid">
            <span className="qdoc-meta-key">Number</span>
            <span className="qdoc-meta-val">{doc.number || '—'}</span>
            <span className="qdoc-meta-key">Date</span>
            <span className="qdoc-meta-val">{issueDate || '—'}</span>
            {dueDate && (
              <>
                <span className="qdoc-meta-key">{dueLabel}</span>
                <span className="qdoc-meta-val">{dueDate}</span>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="qdoc-divider" />

      {/* Customer */}
      {(customerName || customer.email || customer.phone) && (
        <section className="qdoc-bill-section">
          <div className="qdoc-bill-label">Bill To</div>
          {customerName && <div className="qdoc-bill-name">{customerName}</div>}
          {customer.name && customer.company && customer.name !== customerName && (
            <div className="qdoc-bill-line">{customer.name}</div>
          )}
          {customer.address && <div className="qdoc-bill-line">{customer.address}</div>}
          {customer.email && <div className="qdoc-bill-line">{customer.email}</div>}
          {customer.phone && <div className="qdoc-bill-line">{customer.phone}</div>}
        </section>
      )}

      {/* Line Items */}
      <table className="qdoc-table">
        <thead>
          <tr>
            <th className="qdoc-th qdoc-th-product">Product</th>
            <th className="qdoc-th qdoc-th-desc">Description</th>
            <th className="qdoc-th qdoc-th-num">Qty</th>
            <th className="qdoc-th qdoc-th-num">Unit Price</th>
            <th className="qdoc-th qdoc-th-num">Total</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={5} className="qdoc-empty-row">Add products to get started</td>
            </tr>
          ) : (
            items.map((it, i) => (
              <tr key={it.id || i} className={i % 2 === 1 ? 'qdoc-row-alt' : ''}>
                <td className="qdoc-td qdoc-td-product">{it.description || '—'}</td>
                <td className="qdoc-td qdoc-td-desc">{it.unit || ''}</td>
                <td className="qdoc-td qdoc-td-num">{it.quantity ?? 1}</td>
                <td className="qdoc-td qdoc-td-num">{money(it.unitPrice, currency)}</td>
                <td className="qdoc-td qdoc-td-num qdoc-td-total">{money(lineTotal(it), currency)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* Totals + Notes */}
      <div className="qdoc-lower">
        <div className="qdoc-notes-col">
          {(doc.notes || doc.terms || doc.paymentTerms) && (
            <div className="qdoc-notes">
              {doc.paymentTerms && <p>{doc.paymentTerms}</p>}
              {doc.notes && <p>{doc.notes}</p>}
              {doc.terms && <p>{doc.terms}</p>}
            </div>
          )}
        </div>

        <div className="qdoc-totals">
          <div className="qdoc-total-row">
            <span>Subtotal</span>
            <span>{money(subtotal, currency)}</span>
          </div>
          {showDiscount && (
            <div className="qdoc-total-row">
              <span>Discount{doc.discountPct ? ` (${doc.discountPct}%)` : ''}</span>
              <span>−{money(discountAmount, currency)}</span>
            </div>
          )}
          {showTax && (
            <div className="qdoc-total-row">
              <span>Tax{doc.taxPct ? ` (${doc.taxPct}%)` : ''}</span>
              <span>{money(taxAmount, currency)}</span>
            </div>
          )}
          {showShipping && (
            <div className="qdoc-total-row">
              <span>Shipping</span>
              <span>{money(shipping, currency)}</span>
            </div>
          )}
          <div className="qdoc-divider-thin" />
          <div className="qdoc-grand-total">
            <span>Total</span>
            <span>{money(total, currency)}</span>
          </div>
          {isInvoice && Number(doc.amountPaid || 0) > 0 && (
            <>
              <div className="qdoc-total-row qdoc-paid-row">
                <span>Amount Paid</span>
                <span>{money(doc.amountPaid, currency)}</span>
              </div>
              <div className="qdoc-total-row qdoc-balance-row">
                <span>Balance Due</span>
                <span>{money(Math.max(0, total - Number(doc.amountPaid || 0)), currency)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="qdoc-footer">
        Thank you for your business.
      </footer>
    </article>
  );
}
