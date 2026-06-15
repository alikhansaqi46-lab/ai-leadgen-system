import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import PageHeader from '../common/PageHeader';
import {
  getEmailStatus,
  sendEmail,
  sendEmailBulk,
  getLeads,
  Lead,
  EmailStatus,
  EmailSendResult,
  EmailBulkResponse,
} from '../../lib/apiClient';

const MAX_BATCH = 50;

function errMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { message?: string; error?: string } | undefined;
    return data?.message || data?.error || err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

function hasEmail(l: Lead): boolean {
  const e = (l.email || '').toString().trim();
  return e !== '' && e !== 'N/A' && e.includes('@');
}

export default function EmailPage() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState<'single' | 'bulk'>('single');
  const [testMode, setTestMode] = useState(true);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // single
  const [toEmail, setToEmail] = useState('');
  const [singleResult, setSingleResult] = useState<EmailSendResult | null>(null);

  // bulk
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [bulkResult, setBulkResult] = useState<EmailBulkResponse | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [s, leadsRes] = await Promise.all([getEmailStatus(), getLeads({ limit: 1000 })]);
        if (active) {
          setStatus(s);
          setLeads(leadsRes.leads.filter(hasEmail));
        }
      } catch (err) {
        if (active) setError(errMessage(err, 'Failed to load email module'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const configured = Boolean(status?.configured);
  const selectedLeads = useMemo(() => leads.filter((l) => selected[l.id]), [leads, selected]);
  const allSelected = leads.length > 0 && selectedLeads.length === leads.length;

  const toggleAll = () => {
    if (allSelected) setSelected({});
    else setSelected(Object.fromEntries(leads.map((l) => [l.id, true])));
  };

  const sendSingle = async () => {
    setBusy(true); setError(null); setSingleResult(null);
    try {
      const res = await sendEmail({
        lead: { email: toEmail.trim() },
        subject: subject.trim(),
        message: message.trim(),
        testMode,
      });
      setSingleResult(res);
    } catch (err) {
      setError(errMessage(err, 'Send failed'));
    } finally {
      setBusy(false);
    }
  };

  const sendBulk = async () => {
    setBusy(true); setError(null); setBulkResult(null);
    try {
      const res = await sendEmailBulk({
        leads: selectedLeads.map((l) => ({ id: l.id, email: l.email, name: l.name, city: l.city, niche: l.niche })),
        subject: subject.trim(),
        message: message.trim(),
        testMode,
      });
      setBulkResult(res);
    } catch (err) {
      setError(errMessage(err, 'Bulk send failed'));
    } finally {
      setBusy(false);
    }
  };

  const singleDisabled = busy || toEmail.trim() === '' || message.trim() === '';
  const bulkDisabled = busy || message.trim() === '' || selectedLeads.length === 0 || selectedLeads.length > MAX_BATCH;

  return (
    <div className="lf-page">
      <PageHeader
        title="Email"
        subtitle="Send and sequence email outreach to your leads"
        actions={
          configured ? <span className="lf-pill lf-pill-on">● Configured</span> : <span className="lf-pill">Not configured</span>
        }
      />

      <div className="lf-note">
        Emails are sent from the backend mailbox and scoped to your workspace's leads. Keep{' '}
        <strong>Test Mode</strong> on to preview without delivering.
      </div>

      {loading ? (
        <div className="lf-card lf-skeleton" style={{ height: 200 }} />
      ) : (
        <div className="lf-card">
          <div className="lf-card-header">
            <h2 className="lf-card-title">Compose & send</h2>
            <label className="lf-switch" title="Test Mode previews sends without delivering real emails">
              <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
              Test Mode {testMode ? '(on)' : '(off — live send)'}
            </label>
          </div>

          {!testMode && (
            <div className="lf-alert" style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#b45309' }}>
              Test Mode is off — emails will be delivered to real recipients.
            </div>
          )}
          {!configured && (
            <div className="lf-note">
              Email delivery isn't configured on this backend (set <code>EMAIL_USER</code> / <code>EMAIL_PASS</code>).
              You can still preview with Test Mode on; live sends require configuration.
            </div>
          )}

          <div className="lf-segmented" style={{ marginBottom: 14 }}>
            <button className={mode === 'single' ? 'is-active' : ''} onClick={() => setMode('single')}>Single</button>
            <button className={mode === 'bulk' ? 'is-active' : ''} onClick={() => setMode('bulk')}>Bulk</button>
          </div>

          <div className="lf-field">
            <label>Subject (optional)</label>
            <input className="lf-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Quick question about {name}" />
          </div>
          <div className="lf-field">
            <label>Message{mode === 'bulk' ? ' — supports {name}, {city}, {niche}' : ''}</label>
            <textarea className="lf-textarea" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={mode === 'bulk' ? 'Hi {name}, we help {niche} businesses in {city}…' : 'Type your message…'} />
          </div>

          {error && <div className="lf-alert lf-alert-error">{error}</div>}

          {mode === 'single' ? (
            <>
              <div className="lf-field">
                <label>Recipient email</label>
                <input className="lf-input" value={toEmail} onChange={(e) => setToEmail(e.target.value)} placeholder="owner@business.com" />
              </div>
              <button className="lf-btn lf-btn-primary" onClick={sendSingle} disabled={singleDisabled}>
                {busy ? 'Sending…' : testMode ? 'Preview send' : 'Send email'}
              </button>
              {singleResult && (
                <div className="lf-alert lf-alert-success" style={{ marginTop: 12 }}>
                  {singleResult.message}{singleResult.messageId ? ` (id ${singleResult.messageId})` : ''}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="lf-toolbar">
                <span className="lf-pill">{selectedLeads.length} selected</span>
                {selectedLeads.length > MAX_BATCH && <span className="lf-pill lf-pill-warn">max {MAX_BATCH} per batch</span>}
                <div className="lf-toolbar-spacer" />
                <button className="lf-btn lf-btn-primary" onClick={sendBulk} disabled={bulkDisabled}>
                  {busy ? 'Sending…' : testMode ? `Preview ${selectedLeads.length}` : `Send ${selectedLeads.length}`}
                </button>
              </div>

              {bulkResult && (
                <div className="lf-alert lf-alert-success">
                  {bulkResult.testMode ? 'Preview: ' : ''}{bulkResult.sent} sent · {bulkResult.failed} failed · {bulkResult.skipped} skipped (of {bulkResult.total}).
                </div>
              )}

              <div className="lf-card lf-table-wrap" style={{ padding: 0 }}>
                <table className="lf-table">
                  <thead>
                    <tr>
                      <th className="lf-row-check"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" /></th>
                      <th>Name</th><th>Email</th><th>City</th><th>Niche</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.length === 0 ? (
                      <tr><td colSpan={5} className="lf-muted" style={{ textAlign: 'center', padding: 24 }}>No leads with email addresses yet. Capture some in the Scraper.</td></tr>
                    ) : (
                      leads.map((l) => (
                        <tr key={l.id}>
                          <td className="lf-row-check">
                            <input type="checkbox" checked={Boolean(selected[l.id])} onChange={(e) => setSelected((s) => ({ ...s, [l.id]: e.target.checked }))} aria-label={`Select ${l.name || l.id}`} />
                          </td>
                          <td>{l.name || '—'}</td>
                          <td>{l.email || '—'}</td>
                          <td>{l.city || '—'}</td>
                          <td>{l.niche || '—'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
