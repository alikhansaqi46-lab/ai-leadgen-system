import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import PageHeader from '../common/PageHeader';
import {
  getWhatsAppStatus,
  getWhatsAppCredentials,
  validateWhatsAppCredentials,
  saveWhatsAppCredentials,
  deleteWhatsAppCredentials,
  getWhatsAppTemplates,
  sendWhatsAppMessage,
  sendWhatsAppBulk,
  getLeads,
  Lead,
  WhatsAppStatus,
  WhatsAppCredentialsInfo,
  WhatsAppTemplate,
  WhatsAppSendResult,
  WhatsAppBulkResponse,
} from '../../lib/apiClient';

const MAX_BATCH = 50;

function errMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { message?: string; error?: string } | undefined;
    return data?.message || data?.error || err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

function hasPhone(l: Lead): boolean {
  const p = (l.phone || '').toString().trim();
  return p !== '' && p !== 'N/A' && p !== 'Not Available';
}

export default function WhatsAppPage() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [credInfo, setCredInfo] = useState<WhatsAppCredentialsInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshStatus = useCallback(async () => {
    const [s, c] = await Promise.all([getWhatsAppStatus(), getWhatsAppCredentials()]);
    setStatus(s);
    setCredInfo(c);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [s, c] = await Promise.all([getWhatsAppStatus(), getWhatsAppCredentials()]);
        if (active) {
          setStatus(s);
          setCredInfo(c);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const configured = Boolean(status?.configured);

  return (
    <div className="lf-page">
      <PageHeader
        title="WhatsApp"
        subtitle="Connect a Meta WhatsApp number and run outreach"
        actions={
          configured ? <span className="lf-pill lf-pill-on">● Connected</span> : <span className="lf-pill">Not connected</span>
        }
      />

      <div className="lf-note">
        Credentials and sends are scoped to your workspace. Keep <strong>Test Mode</strong> on to preview
        sends without delivering real messages.
      </div>

      {loading ? (
        <div className="lf-card lf-skeleton" style={{ height: 200 }} />
      ) : (
        <div className="lf-stack">
          <ConnectionCard status={status} credInfo={credInfo} onChange={refreshStatus} />
          <ComposeCard configured={configured} />
        </div>
      )}
    </div>
  );
}

function ConnectionCard({
  status,
  credInfo,
  onChange,
}: {
  status: WhatsAppStatus | null;
  credInfo: WhatsAppCredentialsInfo | null;
  onChange: () => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const configured = Boolean(status?.configured);
  const canSubmit = token.trim() !== '' && phoneNumberId.trim() !== '' && !busy;

  const validate = async () => {
    setBusy(true); setOk(null); setError(null);
    try {
      const res = await validateWhatsAppCredentials({ token: token.trim(), phoneNumberId: phoneNumberId.trim() });
      if (res.valid) setOk(res.message || 'Credentials are valid');
      else setError(res.error || 'Credentials are invalid');
    } catch (err) {
      setError(errMessage(err, 'Validation failed'));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true); setOk(null); setError(null);
    try {
      await saveWhatsAppCredentials({ token: token.trim(), phoneNumberId: phoneNumberId.trim(), wabaId: wabaId.trim() || undefined });
      setOk('Connected — credentials saved for your workspace.');
      setToken(''); setPhoneNumberId(''); setWabaId('');
      await onChange();
    } catch (err) {
      setError(errMessage(err, 'Failed to save credentials'));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true); setOk(null); setError(null);
    try {
      await deleteWhatsAppCredentials();
      setOk('Disconnected.');
      await onChange();
    } catch (err) {
      setError(errMessage(err, 'Failed to disconnect'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lf-card">
      <div className="lf-card-header">
        <h2 className="lf-card-title">Connection</h2>
        {status?.envFallback && <span className="lf-pill lf-pill-warn">env fallback</span>}
      </div>

      {ok && <div className="lf-alert lf-alert-success">{ok}</div>}
      {error && <div className="lf-alert lf-alert-error">{error}</div>}

      {configured ? (
        <div>
          <p className="lf-muted" style={{ marginTop: 0 }}>
            Connected via Meta Cloud API{credInfo?.phoneNumberId ? ` · Phone Number ID ${credInfo.phoneNumberId}` : ''}.
          </p>
          <button className="lf-btn" onClick={disconnect} disabled={busy}>
            {busy ? 'Working…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <div>
          <div className="lf-field">
            <label>Access Token</label>
            <input className="lf-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Permanent or temporary Meta token" />
          </div>
          <div className="lf-field">
            <label>Phone Number ID</label>
            <input className="lf-input" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="e.g. 123456789012345" />
          </div>
          <div className="lf-field">
            <label>WhatsApp Business Account ID (optional, for templates)</label>
            <input className="lf-input" value={wabaId} onChange={(e) => setWabaId(e.target.value)} placeholder="WABA ID" />
          </div>
          <div className="lf-toolbar" style={{ marginBottom: 0 }}>
            <button className="lf-btn" onClick={validate} disabled={!canSubmit}>Validate</button>
            <button className="lf-btn lf-btn-primary" onClick={save} disabled={!canSubmit}>
              {busy ? 'Saving…' : 'Save & connect'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ComposeCard({ configured }: { configured: boolean }) {
  const [mode, setMode] = useState<'single' | 'bulk'>('single');
  const [testMode, setTestMode] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // single
  const [phone, setPhone] = useState('');
  const [singleResult, setSingleResult] = useState<WhatsAppSendResult | null>(null);

  // bulk
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [bulkResult, setBulkResult] = useState<WhatsAppBulkResponse | null>(null);

  // templates (reference)
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [leadsRes, tpl] = await Promise.all([getLeads({ limit: 1000 }), getWhatsAppTemplates()]);
        if (active) {
          setLeads(leadsRes.leads.filter(hasPhone));
          setTemplates(tpl.templates || []);
        }
      } catch {
        /* non-fatal: compose still works without lead list/templates */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const selectedLeads = useMemo(() => leads.filter((l) => selected[l.id]), [leads, selected]);
  const allSelected = leads.length > 0 && selectedLeads.length === leads.length;

  const toggleAll = () => {
    if (allSelected) setSelected({});
    else setSelected(Object.fromEntries(leads.map((l) => [l.id, true])));
  };

  const sendSingle = async () => {
    setBusy(true); setError(null); setSingleResult(null);
    try {
      const res = await sendWhatsAppMessage({ phone: phone.trim(), message: message.trim(), testMode });
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
      const res = await sendWhatsAppBulk({
        leads: selectedLeads.map((l) => ({ id: l.id, phone: l.phone, name: l.name, city: l.city, niche: l.niche })),
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

  const singleDisabled = busy || phone.trim() === '' || message.trim() === '';
  const bulkDisabled = busy || message.trim() === '' || selectedLeads.length === 0 || selectedLeads.length > MAX_BATCH;

  return (
    <div className="lf-card">
      <div className="lf-card-header">
        <h2 className="lf-card-title">Compose & send</h2>
        <label className="lf-switch" title="Test Mode previews sends without delivering real messages">
          <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
          Test Mode {testMode ? '(on)' : '(off — live send)'}
        </label>
      </div>

      {!testMode && (
        <div className="lf-alert" style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#b45309' }}>
          Test Mode is off — messages will be delivered to real recipients.
        </div>
      )}
      {!configured && (
        <div className="lf-note">
          No credentials connected yet. You can still preview with Test Mode on; live sends require a connection above.
        </div>
      )}

      <div className="lf-segmented" style={{ marginBottom: 14 }}>
        <button className={mode === 'single' ? 'is-active' : ''} onClick={() => setMode('single')}>Single</button>
        <button className={mode === 'bulk' ? 'is-active' : ''} onClick={() => setMode('bulk')}>Bulk</button>
      </div>

      <div className="lf-field">
        <label>Message{mode === 'bulk' ? ' — supports {name}, {city}, {niche}' : ''}</label>
        <textarea className="lf-textarea" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={mode === 'bulk' ? 'Hi {name}, we help {niche} businesses in {city}…' : 'Type your message…'} />
      </div>

      {error && <div className="lf-alert lf-alert-error">{error}</div>}

      {mode === 'single' ? (
        <>
          <div className="lf-field">
            <label>Recipient phone</label>
            <input className="lf-input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. +1 512 555 0148" />
          </div>
          <button className="lf-btn lf-btn-primary" onClick={sendSingle} disabled={singleDisabled}>
            {busy ? 'Sending…' : testMode ? 'Preview send' : 'Send message'}
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
                  <th>Name</th><th>Phone</th><th>City</th><th>Niche</th>
                </tr>
              </thead>
              <tbody>
                {leads.length === 0 ? (
                  <tr><td colSpan={5} className="lf-muted" style={{ textAlign: 'center', padding: 24 }}>No leads with phone numbers yet. Capture some in the Scraper.</td></tr>
                ) : (
                  leads.map((l) => (
                    <tr key={l.id}>
                      <td className="lf-row-check">
                        <input type="checkbox" checked={Boolean(selected[l.id])} onChange={(e) => setSelected((s) => ({ ...s, [l.id]: e.target.checked }))} aria-label={`Select ${l.name || l.id}`} />
                      </td>
                      <td>{l.name || '—'}</td>
                      <td>{l.phone || '—'}</td>
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

      {templates.length > 0 && (
        <p className="lf-muted" style={{ fontSize: 12, marginTop: 12 }}>
          Approved templates: {templates.map((t) => t.name).join(', ')}
        </p>
      )}
    </div>
  );
}
