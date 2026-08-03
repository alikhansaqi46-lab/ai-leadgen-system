import { SalesDocument, SalesLineItem } from '../../lib/apiClient';

export type WorkflowMode = 'auto' | 'approval';
export type DocType = 'quote' | 'invoice';

export const WORKFLOW_KEY = 'quoteWorkflowMode';

export const EMPTY_ITEM = (): SalesLineItem => ({
  description: '',
  unit: '',
  quantity: 1,
  unitPrice: 0,
  discount: 0,
});

export function money(n: number, currency = 'MYR') {
  return `${currency} ${Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function calcTotals(doc: Partial<SalesDocument>) {
  const items = doc.lineItems || [];
  const dPct = Number(doc.discountPct) || 0;

  // Document-level % discount wins. Clear line discounts to avoid double application.
  let subtotal = 0;
  const lineItems = items.map((it) => {
    const qty = Number(it.quantity) || 0;
    const unit = Number(it.unitPrice) || 0;
    const disc = dPct > 0 ? 0 : (Number(it.discount) || 0);
    const amount = Math.max(0, qty * unit - disc);
    subtotal += amount;
    return { ...it, discount: disc, amount };
  });

  const discountFromPct = Math.round(subtotal * dPct) / 100;
  const dAmtInput = Number(doc.discountAmount) || 0;
  const discountAmount = dPct > 0
    ? discountFromPct
    : (dAmtInput > 0 ? dAmtInput : 0);

  const taxable = Math.max(0, subtotal - discountAmount);
  const taxPct = Number(doc.taxPct) || 0;
  const taxAmount = Math.round(taxable * taxPct) / 100;
  const shipping = Number(doc.shipping) || 0;
  const total = Math.round((taxable + taxAmount + shipping) * 100) / 100;
  return { lineItems, subtotal, discountAmount, taxAmount, shipping, total };
}

export function mapLeadToCustomer(lead: any) {
  if (!lead) return {};
  return {
    name: lead.name || '',
    company: lead.company || lead.name || '',
    email: lead.email || '',
    phone: lead.phone || '',
    address: [lead.city, lead.country].filter(Boolean).join(', '),
  };
}

export function baseCompany(profile: any) {
  return {
    companyName: profile?.companyName || '',
    logoUrl: profile?.logoUrl || '',
    signatureUrl: profile?.signatureUrl || '',
    address: profile?.address || '',
    phone: profile?.phone || '',
    email: profile?.email || '',
    website: profile?.website || '',
    footerText: 'Thank you for your business.',
  };
}

export function formatSaveSuccess(doc: SalesDocument, isNew: boolean) {
  const kind = doc.docType === 'invoice' ? 'Invoice' : 'Quotation';
  const customer = doc.customer?.company || doc.customer?.name || 'customer';
  const verb = isNew ? 'created and saved' : 'updated';
  return `${kind} ${doc.number || ''} ${verb} for ${customer} — ${money(doc.total, doc.currency)} (${doc.status || 'draft'})`;
}

export function readWorkflowMode(): WorkflowMode {
  try {
    return localStorage.getItem(WORKFLOW_KEY) === 'auto' ? 'auto' : 'approval';
  } catch {
    return 'approval';
  }
}

export function isRealLeadId(leadId?: string | null) {
  if (!leadId) return false;
  return !leadId.startsWith('contact:') && !leadId.startsWith('preview_');
}

export function normalizeSendChannel(channel?: string): 'email' | 'whatsapp' | 'sms' {
  if (channel === 'whatsapp' || channel === 'sms' || channel === 'email') return channel;
  return 'email';
}
