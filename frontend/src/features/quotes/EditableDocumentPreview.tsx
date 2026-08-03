import { CSSProperties } from 'react';
import { SalesDocument, SalesLineItem } from '../../lib/apiClient';

type PreviewDoc = Partial<SalesDocument> & {
  lineItems?: SalesLineItem[];
  company?: SalesDocument['company'];
  customer?: SalesDocument['customer'];
};

export type EditorSections = {
  intro?: boolean;
  paymentTerms?: boolean;
  notes?: boolean;
  terms?: boolean;
  discount?: boolean;
  tax?: boolean;
  shipping?: boolean;
  footer?: boolean;
};

const DEFAULT_SECTIONS: Required<EditorSections> = {
  intro: true,
  paymentTerms: true,
  notes: true,
  terms: true,
  discount: true,
  tax: true,
  shipping: true,
  footer: true,
};

function money(n: number | undefined | null, currency = 'MYR') {
  return `${currency} ${Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDate(value?: string | null) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

function lineTotal(it: SalesLineItem) {
  const qty = Number(it.quantity) || 0;
  const unit = Number(it.unitPrice) || 0;
  const disc = Number(it.discount) || 0;
  return Math.max(0, qty * unit - disc);
}

function readSections(doc: PreviewDoc): Required<EditorSections> {
  const raw = (doc.meta?.editorSections || {}) as EditorSections;
  return { ...DEFAULT_SECTIONS, ...raw };
}

function EditableField({
  value,
  onChange,
  className = '',
  placeholder = '',
  multiline = false,
  type = 'text',
}: {
  value: string | number;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  type?: 'text' | 'number' | 'date';
}) {
  if (multiline) {
    return (
      <textarea
        className={`qdoc-editable ${className}`}
        value={String(value || '')}
        placeholder={placeholder}
        rows={2}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className={`qdoc-editable ${className}`}
      type={type}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Shared Quote + Invoice document editor.
 * Behaviour is identical; only labels/fields differ by doc.docType.
 */
export default function EditableDocumentPreview({
  doc,
  onPatch,
  onPatchItem,
  onAddItem,
  onRemoveItem,
  onDuplicateItem,
  onMoveItem,
}: {
  doc: PreviewDoc;
  onPatch: (patch: Partial<SalesDocument>) => void;
  onPatchItem: (idx: number, patch: Partial<SalesLineItem>) => void;
  onAddItem: () => void;
  onRemoveItem: (idx: number) => void;
  onDuplicateItem?: (idx: number) => void;
  onMoveItem?: (from: number, to: number) => void;
}) {
  const company = doc.company || {};
  const customer = doc.customer || {};
  const currency = doc.currency || 'MYR';
  const isInvoice = doc.docType === 'invoice';
  const title = isInvoice ? 'INVOICE' : 'QUOTATION';
  const issueDate = fmtDate(doc.createdAt || new Date().toISOString());
  const dueOrValid = isInvoice ? doc.dueDate : doc.validUntil;
  const dueLabel = isInvoice ? 'Due Date' : 'Valid Until';
  const sections = readSections(doc);

  const items = doc.lineItems || [];
  const subtotal = Number(doc.subtotal) || items.reduce((s, it) => s + lineTotal(it), 0);
  const discountAmount = Number(doc.discountAmount) || 0;
  const taxAmount = Number(doc.taxAmount) || 0;
  const shipping = Number(doc.shipping) || 0;
  const total = Number(doc.total) || (subtotal - discountAmount + taxAmount + shipping);
  const introText = String(doc.meta?.introText || '');
  const footerText = String(doc.meta?.footerText || company.footerText || 'Thank you for your business.');

  const patchCompany = (patch: Record<string, string>) =>
    onPatch({ company: { ...company, ...patch } });
  const patchCustomer = (patch: Record<string, string>) =>
    onPatch({ customer: { ...customer, ...patch } });
  const patchSections = (key: keyof EditorSections, value: boolean) => {
    onPatch({
      meta: {
        ...(doc.meta || {}),
        editorSections: { ...sections, [key]: value },
      },
    });
  };
  const patchMeta = (patch: Record<string, unknown>) => {
    onPatch({ meta: { ...(doc.meta || {}), ...patch } });
  };

  return (
    <article className="qdoc-page qdoc-editable-page" style={{ '--qdoc-accent': '#111827' } as CSSProperties}>
      <div className="qdoc-section-toggles" aria-label="Document sections">
        {(
          [
            ['intro', 'Intro'],
            ['paymentTerms', 'Payment terms'],
            ['notes', 'Notes'],
            ['terms', 'Terms'],
            ['discount', 'Discount'],
            ['tax', 'Tax'],
            ['shipping', 'Shipping'],
            ['footer', 'Footer'],
          ] as Array<[keyof EditorSections, string]>
        ).map(([key, label]) => (
          <label key={key} className="qdoc-section-toggle">
            <input
              type="checkbox"
              checked={sections[key]}
              onChange={(e) => patchSections(key, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>

      <header className="qdoc-header">
        <div className="qdoc-from">
          {company.logoUrl ? (
            <img src={company.logoUrl} alt="" className="qdoc-logo" />
          ) : (
            <div className="qdoc-logo-initial">
              {(company.companyName || company.name || 'C').slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="qdoc-from-info">
            <EditableField
              className="qdoc-company-name"
              value={company.companyName || company.name || ''}
              placeholder="Company name"
              onChange={(v) => patchCompany({ companyName: v })}
            />
            <EditableField
              value={company.address || ''}
              placeholder="Address"
              onChange={(v) => patchCompany({ address: v })}
            />
            <EditableField
              value={company.email || ''}
              placeholder="Email"
              onChange={(v) => patchCompany({ email: v })}
            />
            <EditableField
              value={company.phone || ''}
              placeholder="Phone"
              onChange={(v) => patchCompany({ phone: v })}
            />
          </div>
        </div>

        <div className="qdoc-title-block">
          <div className="qdoc-title">{title}</div>
          <div className="qdoc-meta-grid">
            <span className="qdoc-meta-key">Number</span>
            <EditableField
              className="qdoc-meta-val"
              value={doc.number || ''}
              placeholder="Auto"
              onChange={(v) => onPatch({ number: v })}
            />
            <span className="qdoc-meta-key">Date</span>
            <span className="qdoc-meta-val">{issueDate || '—'}</span>
            <span className="qdoc-meta-key">{dueLabel}</span>
            <EditableField
              className="qdoc-meta-val"
              type="date"
              value={String(dueOrValid || '').slice(0, 10)}
              onChange={(v) => onPatch(isInvoice ? { dueDate: v } : { validUntil: v })}
            />
          </div>
        </div>
      </header>

      <div className="qdoc-divider" />

      <section className="qdoc-bill-section">
        <div className="qdoc-bill-label">Bill To</div>
        <EditableField
          className="qdoc-bill-name"
          value={customer.company || customer.name || ''}
          placeholder="Customer company"
          onChange={(v) => patchCustomer({ company: v })}
        />
        <EditableField
          value={customer.name || ''}
          placeholder="Contact name"
          onChange={(v) => patchCustomer({ name: v })}
        />
        <EditableField
          value={customer.address || ''}
          placeholder="Address"
          onChange={(v) => patchCustomer({ address: v })}
        />
        <EditableField
          value={customer.email || ''}
          placeholder="Email"
          onChange={(v) => patchCustomer({ email: v })}
        />
        <EditableField
          value={customer.phone || ''}
          placeholder="Phone"
          onChange={(v) => patchCustomer({ phone: v })}
        />
      </section>

      {sections.intro && (
        <section className="qdoc-intro-section">
          <label className="qdoc-notes-label">Intro / custom text</label>
          <EditableField
            multiline
            value={introText}
            placeholder="Optional intro message for the customer…"
            onChange={(v) => patchMeta({ introText: v })}
          />
        </section>
      )}

      <table className="qdoc-table qdoc-table-editable">
        <thead>
          <tr>
            <th className="qdoc-th qdoc-th-product">Product</th>
            <th className="qdoc-th qdoc-th-desc">Description</th>
            <th className="qdoc-th qdoc-th-num">Qty</th>
            <th className="qdoc-th qdoc-th-num">Unit Price</th>
            <th className="qdoc-th qdoc-th-num">Total</th>
            <th className="qdoc-th qdoc-th-action" />
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={6} className="qdoc-empty-row">No products yet — add one below</td>
            </tr>
          ) : (
            items.map((it, i) => (
              <tr key={it.id || i} className={i % 2 === 1 ? 'qdoc-row-alt' : ''}>
                <td className="qdoc-td qdoc-td-product">
                  <EditableField
                    value={it.description || ''}
                    placeholder="Product name"
                    onChange={(v) => onPatchItem(i, { description: v })}
                  />
                </td>
                <td className="qdoc-td qdoc-td-desc">
                  <EditableField
                    value={it.unit || ''}
                    placeholder="Description"
                    onChange={(v) => onPatchItem(i, { unit: v })}
                  />
                </td>
                <td className="qdoc-td qdoc-td-num">
                  <EditableField
                    type="number"
                    value={it.quantity ?? 1}
                    onChange={(v) => onPatchItem(i, { quantity: Number(v) || 0 })}
                  />
                </td>
                <td className="qdoc-td qdoc-td-num">
                  <EditableField
                    type="number"
                    value={it.unitPrice ?? 0}
                    onChange={(v) => onPatchItem(i, { unitPrice: Number(v) || 0 })}
                  />
                </td>
                <td className="qdoc-td qdoc-td-num qdoc-td-total">{money(lineTotal(it), currency)}</td>
                <td className="qdoc-td qdoc-td-action">
                  <div className="qdoc-row-actions">
                    {onMoveItem && i > 0 && (
                      <button type="button" className="qdoc-row-btn" onClick={() => onMoveItem(i, i - 1)} title="Move up">↑</button>
                    )}
                    {onMoveItem && i < items.length - 1 && (
                      <button type="button" className="qdoc-row-btn" onClick={() => onMoveItem(i, i + 1)} title="Move down">↓</button>
                    )}
                    {onDuplicateItem && (
                      <button type="button" className="qdoc-row-btn" onClick={() => onDuplicateItem(i)} title="Duplicate">⧉</button>
                    )}
                    <button type="button" className="qdoc-row-delete" onClick={() => onRemoveItem(i)} title="Remove">×</button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="qdoc-table-actions">
        <button type="button" className="qdoc-add-row" onClick={onAddItem}>+ Add product</button>
      </div>

      <div className="qdoc-lower">
        <div className="qdoc-notes-col">
          <div className="qdoc-notes qdoc-notes-editable">
            {sections.paymentTerms && (
              <>
                <label className="qdoc-notes-label">Payment terms</label>
                <EditableField
                  multiline
                  value={doc.paymentTerms || ''}
                  placeholder="Payment due within 14 days."
                  onChange={(v) => onPatch({ paymentTerms: v })}
                />
              </>
            )}
            {sections.notes && (
              <>
                <label className="qdoc-notes-label">Notes</label>
                <EditableField
                  multiline
                  value={doc.notes || ''}
                  placeholder="Add notes…"
                  onChange={(v) => onPatch({ notes: v })}
                />
              </>
            )}
            {sections.terms && (
              <>
                <label className="qdoc-notes-label">Terms &amp; conditions</label>
                <EditableField
                  multiline
                  value={doc.terms || ''}
                  placeholder="Add terms…"
                  onChange={(v) => onPatch({ terms: v })}
                />
              </>
            )}
          </div>
        </div>

        <div className="qdoc-totals qdoc-totals-editable">
          <div className="qdoc-total-row">
            <span>Subtotal</span>
            <span>{money(subtotal, currency)}</span>
          </div>
          {sections.discount && (
            <>
              <div className="qdoc-total-edit-row">
                <span>Discount %</span>
                <EditableField
                  type="number"
                  value={doc.discountPct || 0}
                  onChange={(v) => onPatch({ discountPct: Number(v) || 0, discountAmount: 0 })}
                />
              </div>
              {(discountAmount > 0 || Number(doc.discountPct) > 0) && (
                <div className="qdoc-total-row">
                  <span>Discount</span>
                  <span>−{money(discountAmount, currency)}</span>
                </div>
              )}
            </>
          )}
          {sections.tax && (
            <>
              <div className="qdoc-total-edit-row">
                <span>Tax %</span>
                <EditableField
                  type="number"
                  value={doc.taxPct || 0}
                  onChange={(v) => onPatch({ taxPct: Number(v) || 0 })}
                />
              </div>
              {(taxAmount > 0 || Number(doc.taxPct) > 0) && (
                <div className="qdoc-total-row">
                  <span>Tax</span>
                  <span>{money(taxAmount, currency)}</span>
                </div>
              )}
            </>
          )}
          {sections.shipping && (
            <>
              <div className="qdoc-total-edit-row">
                <span>Shipping</span>
                <EditableField
                  type="number"
                  value={doc.shipping || 0}
                  onChange={(v) => onPatch({ shipping: Number(v) || 0 })}
                />
              </div>
              {shipping > 0 && (
                <div className="qdoc-total-row">
                  <span>Shipping total</span>
                  <span>{money(shipping, currency)}</span>
                </div>
              )}
            </>
          )}
          <div className="qdoc-divider-thin" />
          <div className="qdoc-grand-total">
            <span>Total</span>
            <span>{money(total, currency)}</span>
          </div>
        </div>
      </div>

      {sections.footer && (
        <footer className="qdoc-footer qdoc-footer-editable">
          <EditableField
            multiline
            value={footerText}
            placeholder="Footer text…"
            onChange={(v) => {
              patchMeta({ footerText: v });
              patchCompany({ footerText: v });
            }}
          />
        </footer>
      )}
    </article>
  );
}
