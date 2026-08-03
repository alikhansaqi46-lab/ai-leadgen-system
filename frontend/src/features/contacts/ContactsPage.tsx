import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import PageHeader from '../common/PageHeader';
import {
  bulkImportContacts,
  createContact,
  deleteContactsBulk,
  downloadContactsCsv,
  getContacts,
  Lead,
  PersonalContact,
  PersonalContactInput,
} from '../../lib/apiClient';
import {
  getTransferredLeadsForChannel,
  writeBulkCampaign,
} from '../../lib/bulkCampaign';

const PAGE_SIZE = 50;

function emptyForm(): PersonalContactInput {
  return { name: '', whatsappNumber: '', smsNumber: '', email: '', company: '', notes: '' };
}

function friendlyError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : '';
  if (/status code|request failed|400|500/i.test(message)) return fallback;
  return message || fallback;
}

function validateContactForm(input: PersonalContactInput): string | null {
  if (!String(input.name || '').trim()) return 'Name is required.';
  if (!String(input.email || input.whatsappNumber || input.smsNumber || '').trim()) {
    return 'Please enter at least one contact method (Email, WhatsApp, or SMS).';
  }
  return null;
}

function contactToCampaignRecipient(contact: PersonalContact, channel: 'email' | 'whatsapp' | 'sms') {
  return {
    id: `contact:${contact.id}`,
    contactId: contact.id,
    name: contact.name || contact.email || contact.whatsappNumber || contact.smsNumber || 'Contact',
    email: contact.email || '',
    phone: channel === 'sms' ? (contact.smsNumber || contact.whatsappNumber || '') : (contact.whatsappNumber || contact.smsNumber || ''),
    city: '',
    niche: contact.company || 'Contact',
    source: 'contacts',
  };
}

function spreadsheetRowsToContacts(rows: any[][]): PersonalContactInput[] {
  if (!rows.length) return [];
  const header = rows[0].map((v) => String(v || '').trim().toLowerCase());
  const hasHeader = header.some((h) => ['name', 'email', 'whatsapp', 'whatsapp number', 'sms', 'sms number', 'phone', 'company', 'notes'].includes(h));
  const dataRows = hasHeader ? rows.slice(1) : rows;

  function value(row: any[], names: string[], fallbackIndex?: number) {
    for (const name of names) {
      const idx = header.indexOf(name);
      if (idx >= 0 && row[idx] != null) return String(row[idx]).trim();
    }
    if (fallbackIndex != null && row[fallbackIndex] != null) return String(row[fallbackIndex]).trim();
    return '';
  }

  return dataRows
    .map((row) => ({
      name: value(row, ['name', 'full name'], 0),
      whatsappNumber: value(row, ['whatsapp', 'whatsapp number', 'phone'], hasHeader ? undefined : 1),
      smsNumber: value(row, ['sms', 'sms number', 'phone'], hasHeader ? undefined : 1),
      email: value(row, ['email', 'email address'], hasHeader ? undefined : 2),
      company: value(row, ['company', 'business']),
      notes: value(row, ['notes', 'note']),
    }))
    .filter((c) => c.name || c.whatsappNumber || c.smsNumber || c.email);
}

function leadToContact(lead: Lead): PersonalContact {
  return {
    id: lead.id,
    name: lead.name || '',
    email: lead.email || '',
    whatsappNumber: lead.phone || '',
    smsNumber: lead.phone || '',
    company: lead.niche || lead.city || '',
    notes: 'Transferred from Lead Page',
    source: 'leads',
  };
}

export default function ContactsPage() {
  const navigate = useNavigate();
  const transferredFromLeads = getTransferredLeadsForChannel('contacts');
  const [contacts, setContacts] = useState<PersonalContact[]>([]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<PersonalContactInput>(() => emptyForm());
  const [bulkText, setBulkText] = useState('');
  const [bulkEmailText, setBulkEmailText] = useState('');
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  const loadSavedContacts = useCallback(async () => {
    try {
      setLoading(true);
      const res = await getContacts({ search: search || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      const transferred = getTransferredLeadsForChannel('contacts').map(leadToContact);
      const transferredIds = new Set(transferred.map((contact) => contact.id));
      const merged = [
        ...transferred,
        ...res.contacts.filter((contact) => !transferredIds.has(contact.id)),
      ];
      setContacts(merged);
      setTotal(res.total + transferred.filter((contact) =>
        !search.trim() ||
        (contact.name || '').toLowerCase().includes(search.toLowerCase()) ||
        (contact.email || '').toLowerCase().includes(search.toLowerCase()) ||
        (contact.whatsappNumber || '').includes(search) ||
        (contact.smsNumber || '').includes(search)
      ).length);
      if (transferred.length > 0) {
        setSelectedIds((prev) => {
          const next = { ...prev };
          transferred.forEach((contact) => { if (contact.id) next[contact.id] = true; });
          return next;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadSavedContacts();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadSavedContacts]);

  useEffect(() => {
    setPage(0);
  }, [search]);

  const filteredContacts = useMemo(() => {
    if (!search.trim()) return contacts;
    const q = search.toLowerCase();
    return contacts.filter((contact) =>
      (contact.name || '').toLowerCase().includes(q) ||
      (contact.email || '').toLowerCase().includes(q) ||
      (contact.whatsappNumber || '').includes(q) ||
      (contact.smsNumber || '').includes(q) ||
      (contact.company || '').toLowerCase().includes(q)
    );
  }, [contacts, search]);

  const selectedContacts = useMemo(() => filteredContacts.filter((c) => selectedIds[c.id]), [filteredContacts, selectedIds]);
  const allSelected = filteredContacts.length > 0 && filteredContacts.every((c) => selectedIds[c.id]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const visibleContacts = filteredContacts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  async function refresh() {
    await loadSavedContacts();
  }

  async function handleCreate() {
    const validation = validateContactForm(form);
    if (validation) {
      setError(validation);
      setSuccess(null);
      return;
    }
    try {
      setError(null);
      const res = await createContact(form);
      setForm(emptyForm());
      setSuccess(res.contact.isDuplicate ? 'Contact created and marked as duplicate.' : 'Contact created.');
      setContacts((prev) => [res.contact, ...prev]);
      setTotal((prev) => prev + 1);
    } catch (err) {
      setError(friendlyError(err, 'Could not create contact. Please check the contact details and try again.'));
    }
  }

  async function handleBulk(text: string, mode: 'mixed' | 'email') {
    if (!text.trim()) return;
    try {
      setError(null);
      const res = await bulkImportContacts({ text, mode, source: mode === 'email' ? 'bulk_email' : 'bulk_paste' });
      setSuccess(`Imported ${res.created} contacts. ${res.duplicates} duplicate${res.duplicates === 1 ? '' : 's'} detected. ${res.skipped} skipped.`);
      if (mode === 'email') setBulkEmailText('');
      else setBulkText('');
      await loadSavedContacts();
    } catch (err) {
      setError(friendlyError(err, 'Could not import contacts. Please check the pasted values and try again.'));
    }
  }

  async function handleFileImport(file?: File | null) {
    if (!file) return;
    try {
      setError(null);
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: '' });
      const parsed = spreadsheetRowsToContacts(rows);
      const res = await bulkImportContacts({ contacts: parsed, source: file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'excel' });
      setSuccess(`Imported ${res.created} contacts from ${file.name}. ${res.duplicates} duplicate${res.duplicates === 1 ? '' : 's'} detected.`);
      await loadSavedContacts();
    } catch (err) {
      setError(friendlyError(err, 'Could not import file. Please check the CSV or Excel format and try again.'));
    }
  }

  async function handleDeleteSelected() {
    const ids = Object.keys(selectedIds).filter((id) => selectedIds[id]);
    if (!ids.length) return;
    const transferredIds = new Set(getTransferredLeadsForChannel('contacts').map((lead) => lead.id));
    const localOnlyIds = ids.filter((id) => transferredIds.has(id));
    const persistedIds = ids.filter((id) => !transferredIds.has(id));

    if (localOnlyIds.length > 0) {
      setContacts((prev) => prev.filter((contact) => !localOnlyIds.includes(contact.id)));
    }
    if (persistedIds.length > 0) {
      const res = await deleteContactsBulk(persistedIds);
      setSuccess(`Deleted ${res.deleted} contact${res.deleted === 1 ? '' : 's'}.`);
      await refresh();
    } else {
      setSuccess(`Removed ${localOnlyIds.length} transferred recipient${localOnlyIds.length === 1 ? '' : 's'}.`);
    }
    setSelectedIds({});
  }

  function openChannel(channel: 'email' | 'whatsapp' | 'sms') {
    if (!selectedContacts.length) return;
    const recipients = selectedContacts
      .filter((contact) => (channel === 'email' ? contact.email : (channel === 'sms' ? (contact.smsNumber || contact.whatsappNumber) : (contact.whatsappNumber || contact.smsNumber))))
      .map((contact) => contactToCampaignRecipient(contact, channel));
    if (!recipients.length) {
      setError(`Selected contacts do not have ${channel === 'email' ? 'email addresses' : 'phone numbers'} for this channel.`);
      return;
    }
    writeBulkCampaign({ channel, source: 'contacts', leads: recipients as Lead[] });
    navigate(channel === 'whatsapp' ? '/app/whatsapp?tab=composer' : `/app/${channel}`);
  }

  function toggleAll() {
    if (allSelected) {
      setSelectedIds({});
      return;
    }
    const next = { ...selectedIds };
    filteredContacts.forEach((contact) => { next[contact.id] = true; });
    setSelectedIds(next);
  }

  return (
    <div className="lf-page-wide">
      <PageHeader
        title="Contacts"
        subtitle={transferredFromLeads.length > 0
          ? `${transferredFromLeads.length} transferred recipient${transferredFromLeads.length === 1 ? '' : 's'} plus saved contacts`
          : `${total} saved contact${total === 1 ? '' : 's'}`}
        actions={
          <>
            <button className="lf-btn" onClick={() => downloadContactsCsv(search || undefined)}>
              Export contacts CSV
            </button>
          </>
        }
      />

      {error && <div className="lf-alert lf-alert-error">{error}</div>}
      {success && <div className="lf-alert lf-alert-success">{success}</div>}

      <section className="lf-card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Create Contact</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(180px, 1fr))', gap: 10 }}>
          <input className="lf-input" placeholder="Name" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="lf-input" placeholder="WhatsApp Number" value={form.whatsappNumber || ''} onChange={(e) => setForm({ ...form, whatsappNumber: e.target.value })} />
          <input className="lf-input" placeholder="SMS Number" value={form.smsNumber || ''} onChange={(e) => setForm({ ...form, smsNumber: e.target.value })} />
          <input className="lf-input" placeholder="Email Address" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className="lf-input" placeholder="Company (optional)" value={form.company || ''} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          <button className="lf-btn lf-btn-primary" onClick={handleCreate}>Create Contact</button>
        </div>
        <textarea className="lf-textarea" placeholder="Notes" value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ marginTop: 10, minHeight: 70 }} />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 0.8fr', gap: 16, marginBottom: 16 }}>
        <section className="lf-card">
          <h3 style={{ marginTop: 0 }}>Bulk Contact Paste</h3>
          <textarea className="lf-textarea" placeholder="+60123456789&#10;+923001112223&#10;+447123456789&#10;&#10;One phone number per line." value={bulkText} onChange={(e) => setBulkText(e.target.value)} style={{ minHeight: 150 }} />
          <button className="lf-btn lf-btn-primary" style={{ marginTop: 10 }} onClick={() => handleBulk(bulkText, 'mixed')}>Import Pasted Contacts</button>
        </section>

        <section className="lf-card">
          <h3 style={{ marginTop: 0 }}>Bulk Email Paste</h3>
          <textarea className="lf-textarea" placeholder="abc@gmail.com&#10;xyz@gmail.com&#10;hello@gmail.com" value={bulkEmailText} onChange={(e) => setBulkEmailText(e.target.value)} style={{ minHeight: 150 }} />
          <button className="lf-btn lf-btn-primary" style={{ marginTop: 10 }} onClick={() => handleBulk(bulkEmailText, 'email')}>Import Emails</button>
        </section>

        <section className="lf-card">
          <h3 style={{ marginTop: 0 }}>CSV / Excel Import</h3>
          <p className="lf-muted">Supports `.csv`, `.xls`, and `.xlsx`. Headers can include name, email, phone, whatsapp, sms, company, notes.</p>
          <input className="lf-input" type="file" accept=".csv,.xls,.xlsx" onChange={(e) => handleFileImport(e.target.files?.[0])} />
        </section>
      </div>

      <section className="lf-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="lf-toolbar" style={{ padding: 14, borderBottom: '1px solid var(--lf-border)', margin: 0 }}>
          <input
            className="lf-input"
            placeholder="Instant search by name, phone, or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ minWidth: 320 }}
          />
          <span className="lf-pill">{selectedContacts.length} selected</span>
          <button className="lf-btn" onClick={toggleAll}>{allSelected ? 'Deselect All' : 'Select All'}</button>
          <button className="lf-btn" onClick={() => setSelectedIds({})}>Deselect All</button>
          <button className="lf-btn" onClick={handleDeleteSelected} disabled={selectedContacts.length === 0}>Delete Selected</button>
          <button className="lf-btn" onClick={() => openChannel('whatsapp')} disabled={selectedContacts.length === 0}>WhatsApp</button>
          <button className="lf-btn" onClick={() => openChannel('email')} disabled={selectedContacts.length === 0}>Email</button>
          <button className="lf-btn" onClick={() => openChannel('sms')} disabled={selectedContacts.length === 0}>SMS</button>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="lf-table">
            <thead>
              <tr>
                <th style={{ width: 42 }}></th>
                <th>Name</th>
                <th>WhatsApp</th>
                <th>SMS</th>
                <th>Email</th>
                <th>Company</th>
                <th>Notes</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ padding: 24 }}>Loading contacts...</td></tr>
              ) : visibleContacts.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: 24 }}>No contacts yet. Create one manually, import a list, or transfer leads from the Lead Page.</td></tr>
              ) : visibleContacts.map((contact) => (
                <tr key={contact.id}>
                  <td className="lf-row-check">
                    <input type="checkbox" checked={Boolean(selectedIds[contact.id])} onChange={(e) => setSelectedIds((s) => ({ ...s, [contact.id]: e.target.checked }))} />
                  </td>
                  <td><strong>{contact.name || 'Unnamed contact'}</strong></td>
                  <td>{contact.whatsappNumber || '—'}</td>
                  <td>{contact.smsNumber || '—'}</td>
                  <td>{contact.email || '—'}</td>
                  <td>{contact.company || '—'}</td>
                  <td style={{ maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{contact.notes || '—'}</td>
                  <td>{contact.isDuplicate ? <span className="lf-pill lf-pill-warn">Duplicate</span> : <span className="lf-pill">Unique</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="lf-toolbar" style={{ padding: 14, borderTop: '1px solid var(--lf-border)', margin: 0 }}>
          <span className="lf-muted">{total} total contacts · page {page + 1} of {totalPages}</span>
          <button className="lf-btn" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</button>
          <button className="lf-btn" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </section>
    </div>
  );
}
