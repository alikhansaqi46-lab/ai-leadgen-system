import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import axios from 'axios';
import PageHeader from '../common/PageHeader';
import MessageContent, { BidiTextArea } from '../../components/MessageContent';
import {
  getEmailStatus,
  getIntegrationStatus,
  getScores,
  getCampaigns,
  updateCampaignStatus,
  getCampaignStats,
  sendCampaignWithPreview,
  getPreviewSettings,
  generateAIMessage as generateAIMessageApi,
  uploadImage,
  Lead,
  EmailStatus,
  IntegrationStatus,
  ScoredLead,
  CampaignRecord,
} from '../../lib/apiClient';
import {
  buildInitialSelection,
  clearBulkCampaign,
  getTransferredLeadsForChannel,
  hasTransferredLeads,
  isContactsSource,
} from '../../lib/bulkCampaign';
import { useAuth } from '../auth/AuthContext';

function emailKey(userId: string | null, suffix: string) {
  return userId ? `lf_email_${suffix}_${userId}` : `lf_email_${suffix}`;
}

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
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const userId = user?.id || null;
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [integration, setIntegration] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [previewMode, setPreviewMode] = useState(false);
  const [previewSettings, setPreviewSettings] = useState<any>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<any>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [scores, setScores] = useState<ScoredLead[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([]);
  const [campaignStats, setCampaignStats] = useState<any>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    buildInitialSelection(getTransferredLeadsForChannel('email'))
  );
  const [pipelineFilter, setPipelineFilter] = useState<string | null>(null);

  const [scoreFilter, setScoreFilter] = useState<'all' | 'hot' | 'warm' | 'cold'>('all');
  const [search, setSearch] = useState('');

  // Stats
  const emailsSent = campaignStats?.channels?.email?.sent ?? campaignStats?.messagesSent ?? 0;
  const repliesReceived = campaignStats?.channels?.email?.replies ?? campaignStats?.repliesReceived ?? 0;
  const dealsClosed = campaignStats?.deal ?? 0;
  const followUpsSent = campaignStats?.followUpsPending ?? 0;
  const meetingsBooked = campaignStats?.meeting ?? 0;
  const leadsWithEmail = leads.filter(hasEmail).length;

  // Image upload
  const [imageAttachment, setImageAttachment] = useState<{ dataUrl: string; url: string; uploading: boolean } | null>(null);

  const [showPreview, setShowPreview] = useState(false);

  // Bulk campaign mode — read from sessionStorage once during initial render (survives StrictMode)
  const [bulkMode] = useState(() => hasTransferredLeads('email'));
  const contactsOnlyMode = isContactsSource('email');

  // Auto-fill message/subject from URL params — mount only
  useEffect(() => {
    const msg = searchParams.get('msg');
    const subj = searchParams.get('subject');
    if (msg) setMessage(decodeURIComponent(msg));
    if (subj) setSubject(decodeURIComponent(subj));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle leadId from URL when leads load (skip if bulk mode already active)
  useEffect(() => {
    const leadId = searchParams.get('lead');
    if (leadId && leads.length > 0 && !bulkMode) {
      const target = leads.find((l) => l.id === leadId);
      if (target) setSelected({ [target.id]: true });
      const next = new URLSearchParams(searchParams);
      next.delete('lead'); next.delete('msg'); next.delete('subject');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads.length, bulkMode]);

  // Image compression helper
  const compressImage = async (file: File): Promise<string> => {
    const img = new Image();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    img.src = dataUrl;
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = reject; });

    const maxDim = 1200;
    const canvas = document.createElement('canvas');
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (w > maxDim || h > maxDim) {
      const ratio = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(img, 0, 0, w, h);

    let quality = 0.85;
    let compressed = canvas.toDataURL('image/jpeg', quality);
    while (compressed.length > 3 * 1024 * 1024 && quality > 0.3) {
      quality -= 0.1;
      compressed = canvas.toDataURL('image/jpeg', quality);
    }
    return compressed;
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      setError('Please upload JPG, JPEG, PNG, or WEBP only.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('File too large. Max 10 MB.');
      return;
    }
    setImageAttachment((prev) => prev ? { ...prev, uploading: true } : { dataUrl: '', url: '', uploading: true });
    try {
      const compressed = file.size > 1 * 1024 * 1024 ? await compressImage(file) : await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { url } = await uploadImage(compressed, file.name);
      setImageAttachment({ dataUrl: compressed, url, uploading: false });
    } catch (err) {
      const msg = errMessage(err, 'Image upload failed');
      console.error('[Image Upload Error]', msg, err);
      setError(msg);
      setImageAttachment(null);
    }
  };
  const removeImage = () => setImageAttachment(null);

  async function load() {
    try {
      setLoading(true);
      const transferredLeads = getTransferredLeadsForChannel('email');
      const hasRecipients = transferredLeads.length > 0;
      const fromContacts = isContactsSource('email');
      const [s, int, scoresRes, campaignsRes] = await Promise.all([
        getEmailStatus().catch(() => ({ configured: false, sendable: true } as EmailStatus)),
        getIntegrationStatus('email').catch(() => null),
        hasRecipients && !fromContacts ? getScores().catch(() => ({ scores: [] })) : Promise.resolve({ scores: [] }),
        hasRecipients && !fromContacts ? getCampaigns().catch(() => ({ campaigns: [] })) : Promise.resolve({ campaigns: [] }),
      ]);
      setStatus(s);
      setIntegration(int || null);
      setLeads(transferredLeads);
      setScores(scoresRes?.scores || []);
      setCampaigns(campaignsRes?.campaigns || []);
    } catch (err) {
      setError(errMessage(err, 'Failed to load email module'));
    } finally {
      setLoading(false);
    }
  }

  const refreshCampaigns = async () => {
    try {
      const [statsRes, campsRes] = await Promise.all([getCampaignStats(), getCampaigns()]);
      setCampaignStats(statsRes?.stats ?? null);
      setCampaigns(campsRes?.campaigns ?? []);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    let active = true;
    load();
    (async () => {
      try {
        const res = await getPreviewSettings();
        if (active && res.settings) setPreviewSettings(res.settings);
      } catch { /* ignore */ }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    refreshCampaigns();
  }, []);

  // Campaign Draft Persistence
  const DRAFT_KEY = userId ? `lf_draft_email_${userId}` : 'lf_draft_email';

  // Load draft on mount. In bulk mode, only restore message/subject/image/preview,
  // NOT selected leads (those come from sessionStorage bulkCampaign).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft.message !== undefined) setMessage(draft.message);
        if (draft.subject !== undefined) setSubject(draft.subject);
        if (draft.imageUrl) {
          setImageAttachment({ dataUrl: draft.imageUrl, url: draft.imageUrl, uploading: false });
        }
        if (draft.previewMode !== undefined) setPreviewMode(draft.previewMode);
        if (!bulkMode && draft.selected && typeof draft.selected === 'object') {
          setSelected(draft.selected);
        }
      }
    } catch { /* ignore corrupt draft */ }
    setDraftLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save draft whenever composer state changes
  // Store only the server URL for images (not base64 dataUrl) to avoid localStorage quota errors.
  useEffect(() => {
    if (!draftLoaded) return;
    const draft = {
      message,
      subject,
      imageUrl: imageAttachment?.url || null,
      previewMode,
      selected: bulkMode ? undefined : selected,
      timestamp: Date.now(),
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch { /* localStorage may be full */ }
  }, [message, subject, imageAttachment, previewMode, selected, bulkMode, DRAFT_KEY, draftLoaded]);

  const clearDraft = () => {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    setDraftLoaded(false);
  };

  const scoreMap = useMemo(() => {
    const m = new Map<string, string>();
    (scores ?? []).forEach((s) => { if (s?.priority) m.set(s.leadId, s.priority); });
    return m;
  }, [scores]);

  const campaignMap = useMemo(() => {
    const m = new Map<string, CampaignRecord>();
    (campaigns ?? []).forEach((c) => { if (c?.leadId) m.set(c.leadId, c); });
    return m;
  }, [campaigns]);

  const filteredLeads = useMemo(() => {
    let list = (leads ?? []).filter(hasEmail);
    if (bulkMode) {
      list = list.filter((l) => selected[l.id]);
    } else {
      if (pipelineFilter) {
        list = list.filter((l) => {
          const c = campaignMap.get(l.id);
          if (pipelineFilter === 'new') return !c || c.status === 'new';
          return c?.status === pipelineFilter;
        });
      }
      if (scoreFilter !== 'all') {
        list = list.filter((l) => scoreMap.get(l.id) === scoreFilter);
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        list = list.filter((l) =>
          (l.name || '').toLowerCase().includes(q) ||
          (l.city || '').toLowerCase().includes(q) ||
          (l.niche || '').toLowerCase().includes(q)
        );
      }
    }
    return list;
  }, [leads, scoreFilter, search, scoreMap, pipelineFilter, campaignMap, bulkMode, selected]);

  const configured = Boolean(status?.configured);
  const sendable = Boolean(status?.sendable ?? status?.configured);
  const selectedLeads = useMemo(() => filteredLeads.filter((l) => selected[l.id]), [filteredLeads, selected]);
  const allSelected = filteredLeads.length > 0 && selectedLeads.length === filteredLeads.length;

  const toggleAll = () => {
    if (allSelected) {
      const next = { ...selected };
      filteredLeads.forEach((l) => { delete (next as any)[l.id]; });
      setSelected(next);
    } else {
      const next = { ...selected };
      filteredLeads.forEach((l) => { (next as any)[l.id] = true; });
      setSelected(next);
    }
  };

  const sendBulk = async () => {
    console.log('[Email Send] clicked. sendable:', sendable, 'configured:', configured, 'selected:', selectedLeads.length, 'message:', message.trim().length, 'subject:', subject.trim().length);
    if (!sendable) {
      setError('Email sending is not configured. Please connect Gmail via OAuth in Settings → Integrations to enable live sending.');
      return;
    }
    setBusy(true); setError(null); setBulkResult(null);
    try {
      const res = await sendCampaignWithPreview({
        channel: 'email',
        leads: selectedLeads.map((l: any) => ({ id: l.id, contactId: l.contactId, source: l.source, email: l.email, name: l.name || 'Lead', city: l.city, niche: l.niche })),
        message: message.trim(),
        subject: subject.trim(),
        previewMode,
        imageUrl: imageAttachment?.url || undefined,
      });
      setBulkResult({
        sent: res.sent,
        failed: res.failed,
        skipped: res.total - res.sent - res.failed,
        total: res.total,
        previewSent: res.previewSent,
        previewError: res.previewError,
        testMode: false,
        results: res.results.map((r: any) => ({
          status: r.status,
          message: r.status === 'sent'
            ? `Sent to ${r.recipientEmail || 'recipient'}. ID: ${r.messageId || '—'}${r.deliveryVerified === false ? ' (delivery unverified)' : ''}`
            : r.error || 'Failed',
        })),
      });
      // If nothing was sent, surface the first failure as an error
      if (res.sent === 0 && res.failed > 0) {
        const firstFail = res.results.find((r: any) => r.status === 'failed');
        setError(firstFail?.error || `All ${res.failed} emails failed. Check backend logs for details.`);
      }
      if (res.sent > 0) {
        clearDraft();
        clearBulkCampaign();
        setLeads([]);
        setSelected({});
        await refreshCampaigns();
      }
    } catch (err) {
      setError(errMessage(err, 'Campaign send failed'));
    } finally {
      setBusy(false);
    }
  };

  const renderPreview = (lead: Lead) => {
    return message
      .replace(/\{name\}/g, lead.name || 'there')
      .replace(/\{city\}/g, lead.city || 'your city')
      .replace(/\{niche\}/g, lead.niche || 'business');
  };

  // Button is only disabled while actively sending so the user always gets
  // a real backend error or validation message instead of a silent block.

  const markStatus = async (leadId: string, st: string) => {
    const valid: CampaignRecord['status'][] = ['new', 'sent', 'replied', 'interested', 'meeting', 'deal', 'lost'];
    if (!valid.includes(st as any)) return;
    // Optimistic update
    setCampaigns((prev) => {
      const idx = prev.findIndex((c) => c.leadId === leadId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], status: st as CampaignRecord['status'] };
        return next;
      }
      return prev;
    });
    try {
      await updateCampaignStatus(leadId, st);
      await refreshCampaigns();
    } catch (e) {
      setError(errMessage(e, 'Failed to update status'));
      await refreshCampaigns();
    }
  };

  return (
    <div className="lf-page">
      <PageHeader
        title="Email CRM"
        subtitle="AI-powered email outreach, campaigns & pipeline"
        actions={sendable ? <span className="lf-pill lf-pill-on">● Ready</span> : <span className="lf-pill">Not ready</span>}
      />

      {loading ? (
        <div className="lf-skeleton-grid">{[0,1,2,3].map((i) => <div key={i} className="lf-card lf-skeleton" />)}</div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="lf-kpi-grid">
            <KpiCard label="Connected Emails" value={configured ? 1 : 0} icon="@" iconClass="lf-kpi-icon-emerald" cardClass="lf-card-emerald"
              gradient="linear-gradient(145deg, rgba(16, 185, 129, 0.12) 0%, rgba(15, 23, 42, 0.7) 60%)" />
            <KpiCard label="Emails Sent" value={emailsSent} icon="✉" iconClass="lf-kpi-icon-cyan" cardClass="lf-card-cyan"
              gradient="linear-gradient(145deg, rgba(6, 182, 212, 0.12) 0%, rgba(15, 23, 42, 0.7) 60%)" />
            <KpiCard label="Replies Received" value={repliesReceived} icon="↩" iconClass="lf-kpi-icon-purple" cardClass="lf-card-purple"
              gradient="linear-gradient(145deg, rgba(139, 92, 246, 0.12) 0%, rgba(15, 23, 42, 0.7) 60%)" />
            <KpiCard label="Deals Closed" value={dealsClosed} icon="🏆" iconClass="lf-kpi-icon-amber" cardClass="lf-card-gold"
              gradient="linear-gradient(145deg, rgba(245, 158, 11, 0.12) 0%, rgba(15, 23, 42, 0.7) 60%)" />
          </div>

          {/* Email Connection Status */}
          <div className="lf-card" style={{ marginBottom: 20, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 12, height: 12, borderRadius: '50%',
                  background: status?.configured ? '#34d399' : status?.sendable ? '#fbbf24' : '#ef4444',
                  boxShadow: `0 0 8px ${status?.configured ? '#34d39960' : status?.sendable ? '#fbbf2460' : '#ef444460'}`
                }} />
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>
                    {status?.configured ? 'Gmail OAuth Connected' : 'Email Not Connected'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--lf-text-secondary)', marginTop: 2 }}>
                    {status?.senderEmail ? (
                      <span>Sender: <strong style={{ color: '#34d399' }}>{status.senderEmail}</strong> · OAuth</span>
                    ) : (
                      <span style={{ color: '#fbbf24' }}>Sender email not set · <a href="/app/settings" style={{ color: '#a78bfa' }}>Connect Gmail →</a></span>
                    )}
                  </div>
                  {integration?.connectedAt && (
                    <div style={{ fontSize: 11, color: 'var(--lf-text-secondary)', marginTop: 2 }}>
                      Auth account: {integration?.account || status?.account || 'Unknown'} · Last connected: {new Date(integration.connectedAt).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
              <div>
                {status?.configured ? (
                  <span className="lf-pill" style={{ fontSize: 12 }}>OAuth</span>
                ) : (
                  <span className="lf-pill" style={{ fontSize: 12, background: '#ef444420', color: '#ef4444' }}>Not Connected</span>
                )}
                <Link to="/app/settings" className="lf-link" style={{ marginLeft: 8, fontSize: 12 }}>Manage in Settings →</Link>
              </div>
            </div>
          </div>

          {/* Sales Pipeline */}
          <div className="lf-card-premium" style={{ padding: 22, marginBottom: 20 }}>
            <div className="lf-card-accent" />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Sales Pipeline</div>
              {pipelineFilter && (
                <button className="lf-pill" style={{ fontSize: 11, cursor: 'pointer' }} onClick={() => setPipelineFilter(null)}>
                  Clear: {pipelineFilter}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(['new', 'sent', 'replied', 'interested', 'meeting', 'deal', 'lost'] as const).map((stage) => {
                const byStatus = campaignStats?.byStatus;
                const count = byStatus
                  ? (byStatus[stage] ?? 0)
                  : campaigns.filter((c) => (stage === 'new' ? (!c || c.status === 'new') : c?.status === stage)).length;
                const colors: Record<string, string> = { new: '#94a3b8', sent: '#22d3ee', replied: '#a78bfa', interested: '#fbbf24', meeting: '#f472b6', deal: '#34d399', lost: '#64748b' };
                return (
                  <button key={stage} className="lf-pill" style={{ fontSize: 12, cursor: 'pointer', background: `${colors[stage]}20`, color: colors[stage], border: `1px solid ${colors[stage]}40`, padding: '4px 10px' }}
                    onClick={() => setPipelineFilter(stage === 'new' ? 'new' : stage)}>
                    {stage.charAt(0).toUpperCase() + stage.slice(1)} <span style={{ fontWeight: 700 }}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* AI Message Generator + Campaign Analytics */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
            <AiMessageGenerator onUseMessage={(msg) => setMessage(msg)} />
            <CampaignAnalytics total={leads.length} withChannel={leadsWithEmail} sent={emailsSent} replies={repliesReceived} followUpsSent={followUpsSent} meetings={meetingsBooked} deals={dealsClosed} channelLabel="Email" entityLabel={contactsOnlyMode ? 'Contacts' : 'Leads'} />
          </div>

          {/* Campaign Composer */}
          <div className="lf-card-premium" style={{ padding: 22 }}>
            <div className="lf-card-accent" />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Campaign Composer</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {pipelineFilter && (
                  <button className="lf-pill" style={{ fontSize: 11, cursor: 'pointer' }} onClick={() => setPipelineFilter(null)}>
                    Clear: {pipelineFilter}
                  </button>
                )}
                <label className="lf-switch" title="Preview Mode sends you a copy so you can verify before going live">
                  <input type="checkbox" checked={previewMode} onChange={(e) => setPreviewMode(e.target.checked)} />
                  Preview Mode {previewMode ? '(on)' : '(off)'}
                </label>
              </div>
            </div>

            {previewMode && previewSettings && (
              <div className="lf-alert lf-alert-info" style={{ marginBottom: 12 }}>
                Preview Mode ON — you will receive a copy on {previewSettings.emailPreview ? `Email (${previewSettings.previewEmail || 'your email'})` : 'Email (enable in Settings)'}
                <div style={{ fontSize: 11, marginTop: 4, opacity: 0.8 }}>Enable previews per channel in Settings → Preview & Testing.</div>
              </div>
            )}
            {!sendable && (
              <div className="lf-alert lf-alert-error" style={{ marginBottom: 12 }}>
                <strong>Email sending is not configured.</strong> Please connect Gmail via OAuth in Settings → Integrations to enable live sending.
              </div>
            )}

            {/* Subject */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Subject</label>
              <input className="lf-input" style={{ marginTop: 6, width: '100%' }} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Enter subject line…" />
            </div>

            {/* Message */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Message — supports {'{name}'}, {'{city}'}, {'{niche}'}</label>
              <BidiTextArea className="lf-textarea" style={{ marginTop: 6, minHeight: 100, fontSize: 14 }} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Paste your AI-generated message or type a custom one…" />
            </div>

            {/* Image Upload */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Campaign Image (Optional)
              </label>
              {!imageAttachment ? (
                <label className="lf-btn" style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
                  📷 Upload Banner / Image
                </label>
              ) : (
                <div style={{ marginTop: 6, position: 'relative', display: 'inline-block' }}>
                  <img src={imageAttachment.dataUrl} alt="Campaign" style={{ width: '100%', maxHeight: 280, objectFit: 'contain', objectPosition: 'center', borderRadius: 8, border: '1px solid var(--lf-card-border)', display: 'block' }} />
                  <button className="lf-btn lf-btn-danger" style={{ position: 'absolute', top: 4, right: 4, padding: '2px 8px', fontSize: 11 }} onClick={removeImage}>✕</button>
                </div>
              )}
              {imageAttachment?.uploading && <span style={{ fontSize: 12, marginLeft: 8, color: 'var(--lf-text-secondary)' }}>Uploading…</span>}
              {imageAttachment && (
                <div className="lf-note" style={{ marginTop: 6, fontSize: 12 }}>
                  Image will appear inline at the top of every email.
                </div>
              )}
            </div>

            {bulkMode && (
              <div className="lf-alert lf-alert-info" style={{ marginBottom: 12 }}>
                🎯 <strong>Bulk Campaign Mode</strong> — Only selected {contactsOnlyMode ? 'contacts' : 'leads'} are shown.
              </div>
            )}

            {draftLoaded && (
              <div className="lf-alert lf-alert-info" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>📝 Draft restored from previous session.</span>
                <button className="lf-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={clearDraft}>Clear Draft</button>
              </div>
            )}

            {error && <div className="lf-alert lf-alert-error" style={{ marginBottom: 12 }}>{error}</div>}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              {!bulkMode && !contactsOnlyMode && (
                <>
                  <select className="scraper-input" style={{ width: 140 }} value={scoreFilter} onChange={(e) => setScoreFilter(e.target.value as 'all' | 'hot' | 'warm' | 'cold')}>
                    <option value="all">All Leads</option>
                    <option value="hot">🔥 Hot Leads</option>
                    <option value="warm">🌤 Warm Leads</option>
                    <option value="cold">❄ Cold Leads</option>
                  </select>
                  <input className="scraper-input" style={{ flex: 1, minWidth: 200 }} placeholder="Search leads by name, city, or niche…" value={search} onChange={(e) => setSearch(e.target.value)} />
                </>
              )}
              <span className="lf-pill">{selectedLeads.length} selected</span>
              {selectedLeads.length > MAX_BATCH && <span className="lf-pill lf-pill-warn">max {MAX_BATCH}</span>}
              <button className="scraper-search-btn" style={{ background: '#64748b' }} onClick={() => setShowPreview((s) => !s)} disabled={busy || message.trim() === '' || selectedLeads.length === 0}>
                {showPreview ? 'Hide Preview' : 'Preview'}
              </button>
              <button className="scraper-search-btn" onClick={sendBulk} disabled={busy}>
                {busy ? 'Sending…' : previewMode ? '🚀 Send with Preview' : '🚀 Send Campaign'}
              </button>
            </div>

            {showPreview && selectedLeads.length > 0 && (
              <div style={{ marginBottom: 14, background: 'rgba(15,23,42,0.5)', border: '1px solid var(--lf-card-border)', borderRadius: 12, padding: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--lf-text-secondary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Message Preview</div>
                {(() => {
                  const lead = selectedLeads[0];
                  return (
                    <div style={{ marginBottom: 10, padding: 10, background: 'rgba(15,23,42,0.6)', borderRadius: 8, fontSize: 13, lineHeight: 1.5 }}>
                      <div style={{ fontSize: 11, color: '#22d3ee', marginBottom: 4 }}>To: {lead.name || lead.email} ({lead.city || '—'})</div>
                      <div style={{ fontSize: 11, color: 'var(--lf-text-secondary)', marginBottom: 4 }}>Subject: {subject}</div>
                      {imageAttachment && (
                        <div style={{ marginBottom: 8 }}>
                          <img src={imageAttachment.dataUrl} alt="Campaign" style={{ width: '100%', maxHeight: 280, objectFit: 'contain', objectPosition: 'center', borderRadius: 6, border: '1px solid var(--lf-card-border)', display: 'block', marginBottom: 4 }} />
                        </div>
                      )}
                      <MessageContent content={renderPreview(lead)} format="text" />
                    </div>
                  );
                })()}
                <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.25)', borderRadius: 8, fontSize: 13 }}>
                  <strong style={{ color: '#22d3ee' }}>Selected Recipients:</strong>
                  <span style={{ marginLeft: 8 }}>✓ {selectedLeads.length} {contactsOnlyMode ? 'Contact' : 'Lead'}{selectedLeads.length !== 1 ? 's' : ''} Selected</span>
                </div>
              </div>
            )}

            {bulkResult && (
              <div className="lf-alert lf-alert-success" style={{ marginBottom: 12 }}>
                {bulkResult.sent} sent · {bulkResult.failed} failed · {bulkResult.skipped} skipped (of {bulkResult.total}).
                {previewMode && bulkResult.previewSent && (
                  <span style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                    ✅ Preview copy sent to your account.
                  </span>
                )}
                {previewMode && bulkResult.sent === 0 && !bulkResult.previewSent && (
                  <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: 'var(--lf-warning)' }}>
                    ⚠ Preview not sent: {bulkResult.previewError || 'Check Settings → Preview & Testing and ensure preview email is configured.'}
                  </span>
                )}
              </div>
            )}

            {/* Lead Table */}
            <div className="lf-card lf-table-wrap" style={{ padding: 0 }}>
              <table className="lf-table">
                <thead>
                  <tr>
                    <th className="lf-row-check"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" /></th>
                    <th>Name</th><th>Email</th><th>City</th><th>Niche</th><th>Score</th><th>Status</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLeads.length === 0 ? (
                    <tr><td colSpan={8} className="lf-muted" style={{ textAlign: 'center', padding: 24 }}>
                      {contactsOnlyMode ? 'No selected contacts with email addresses.' : leads.length === 0 ? 'No recipients yet. Select leads on the Lead Page, then open Email CRM.' : scoreFilter !== 'all' ? `No ${scoreFilter} leads with emails.` : pipelineFilter ? `No leads in "${pipelineFilter}" stage.` : 'No transferred leads with email addresses.'}
                    </td></tr>
                  ) : (
                    filteredLeads.map((l) => (
                      <tr key={l.id}>
                        <td className="lf-row-check">
                          <input type="checkbox" checked={Boolean(selected[l.id])} onChange={(e) => setSelected((s) => ({ ...s, [l.id]: e.target.checked }))} aria-label={`Select ${l.name || l.id}`} />
                        </td>
                        <td>{l.name || '—'}</td>
                        <td>{l.email || '—'}</td>
                        <td>{l.city || '—'}</td>
                        <td>{l.niche || '—'}</td>
                        <td>{scoreMap.get(l.id) ? <span className="lf-pill" style={{ background: `${{hot:'#fb7185',warm:'#fbbf24',cold:'#94a3b8'}[scoreMap.get(l.id)!]}20`, color: {hot:'#fb7185',warm:'#fbbf24',cold:'#94a3b8'}[scoreMap.get(l.id)!], fontSize: 10, fontWeight: 700 }}>{scoreMap.get(l.id)!.toUpperCase()}</span> : <span className="lf-pill" style={{ fontSize: 10 }}>—</span>}</td>
                        <td>{(() => {
                          const c = campaignMap.get(l.id);
                          if (!c || c.status === 'new') return <span className="lf-pill" style={{ fontSize: 10 }}>NEW</span>;
                          const colors: Record<string,string> = { sent: '#22d3ee', replied: '#a78bfa', interested: '#fbbf24', meeting: '#f472b6', deal: '#34d399', lost: '#64748b' };
                          return <span className="lf-pill" style={{ background: `${colors[c.status]}20`, color: colors[c.status], fontSize: 10, fontWeight: 700 }}>{c.status.toUpperCase()}</span>;
                        })()}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            <button onClick={() => markStatus(l.id, 'interested')} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #fbbf24', background: '#fbbf2420', color: '#fbbf24', cursor: 'pointer', whiteSpace: 'nowrap' }}>★ Interested</button>
                            <button onClick={() => markStatus(l.id, 'meeting')} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #f472b6', background: '#f472b620', color: '#f472b6', cursor: 'pointer', whiteSpace: 'nowrap' }}>📅 Meeting</button>
                            <button onClick={() => markStatus(l.id, 'deal')} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #34d399', background: '#34d39920', color: '#34d399', cursor: 'pointer', whiteSpace: 'nowrap' }}>🏆 Deal</button>
                            <button onClick={() => markStatus(l.id, 'lost')} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #64748b', background: '#64748b20', color: '#64748b', cursor: 'pointer', whiteSpace: 'nowrap' }}>✕ Lost</button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function KpiCard({ label, value, icon, iconClass, cardClass, suffix = '', gradient }: {
  label: string; value: number; icon: string; iconClass: string; cardClass: string; suffix?: string; gradient?: string;
}) {
  return (
    <div className={`lf-card-premium ${cardClass}`} style={gradient ? { background: gradient } : undefined}>
      <div className="lf-card-accent" />
      <div className={`lf-kpi-icon-wrap ${iconClass}`}>{icon}</div>
      <div className="lf-kpi-value-premium">{value.toLocaleString()}{suffix}</div>
      <div className="lf-kpi-label-premium">{label}</div>
    </div>
  );
}

function AiMessageGenerator({ onUseMessage }: { onUseMessage: (msg: string) => void }) {
  const AI_DRAFT_KEY = 'lf_draft_ai_email';
  const [businessType, setBusinessType] = useState(() => {
    try { const d = JSON.parse(localStorage.getItem(AI_DRAFT_KEY) || '{}'); return d.businessType || 'gym'; } catch { return 'gym'; }
  });
  const [goal, setGoal] = useState(() => {
    try { const d = JSON.parse(localStorage.getItem(AI_DRAFT_KEY) || '{}'); return d.goal || 'booking'; } catch { return 'booking'; }
  });
  const [language, setLanguage] = useState(() => {
    try { const d = JSON.parse(localStorage.getItem(AI_DRAFT_KEY) || '{}'); return d.language || 'en'; } catch { return 'en'; }
  });
  const [tone, setTone] = useState(() => {
    try { const d = JSON.parse(localStorage.getItem(AI_DRAFT_KEY) || '{}'); return d.tone || 'professional'; } catch { return 'professional'; }
  });
  const [length, setLength] = useState(() => {
    try { const d = JSON.parse(localStorage.getItem(AI_DRAFT_KEY) || '{}'); return d.length || 'medium'; } catch { return 'medium'; }
  });
  const [writingStyle, setWritingStyle] = useState(() => {
    try { const d = JSON.parse(localStorage.getItem(AI_DRAFT_KEY) || '{}'); return d.writingStyle || 'native'; } catch { return 'native'; }
  });
  const [generated, setGenerated] = useState(() => {
    try { const d = JSON.parse(localStorage.getItem(AI_DRAFT_KEY) || '{}'); return d.generated || ''; } catch { return ''; }
  });
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-save AI settings + generated message
  useEffect(() => {
    const draft = { businessType, goal, language, tone, length, writingStyle, generated, timestamp: Date.now() };
    try { localStorage.setItem(AI_DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
  }, [businessType, goal, language, tone, length, writingStyle, generated]);

  const generate = async () => {
    setLoading(true); setError(null);
    try {
      const res = await generateAIMessageApi({ businessType, goal, language, tone, length, writingStyle });
      setGenerated(res.message); setCopied(false);
    } catch (err) {
      setError(errMessage(err, 'Failed to generate message'));
    } finally {
      setLoading(false);
    }
  };

  const copy = () => {
    if (!generated) return;
    navigator.clipboard.writeText(generated);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  const useMessage = () => {
    if (!generated) return;
    onUseMessage(generated);
    setCopied(false);
  };

  return (
    <div className="lf-card-premium" style={{ padding: 22 }}>
      <div className="lf-card-accent" />
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>AI Message Generator</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Business Type</label>
            <input className="scraper-input" style={{ marginTop: 6, width: '100%' }} list="business-types" value={businessType} onChange={(e) => setBusinessType(e.target.value)} placeholder="Type or select..." />
            <datalist id="business-types">
              <option value="gym" /><option value="dentist" /><option value="lawyer" /><option value="restaurant" /><option value="salon" /><option value="realtor" /><option value="plumber" /><option value="hvac" />
              <option value="marketing agency" /><option value="coffee shop" /><option value="auto repair" /><option value="consulting firm" />
            </datalist>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Goal</label>
            <select className="scraper-input" style={{ marginTop: 6, width: '100%' }} value={goal} onChange={(e) => setGoal(e.target.value)}>
              <option value="booking">Book Appointment</option><option value="demo">Request Demo</option><option value="followup">Follow Up</option><option value="offer">Special Offer</option><option value="meeting">Schedule Meeting</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Language</label>
            <select className="scraper-input" style={{ marginTop: 6, width: '100%' }} value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="en">🇺🇸 English (US)</option>
              <option value="en-GB">🇬🇧 English (UK)</option>
              <option value="ar">🇸🇦 Arabic</option>
              <option value="ur">🇵🇰 Urdu</option>
              <option value="hi">🇮🇳 Hindi</option>
              <option value="bn">🇧🇩 Bengali</option>
              <option value="pa">🇮🇳 Punjabi</option>
              <option value="ta">🇮🇳 Tamil</option>
              <option value="te">🇮🇳 Telugu</option>
              <option value="ml">🇮🇳 Malayalam</option>
              <option value="mr">🇮🇳 Marathi</option>
              <option value="gu">🇮🇳 Gujarati</option>
              <option value="kn">🇮🇳 Kannada</option>
              <option value="zh">🇨🇳 Chinese (Simplified)</option>
              <option value="zh-TW">🇹🇼 Chinese (Traditional)</option>
              <option value="ja">🇯🇵 Japanese</option>
              <option value="ko">🇰🇷 Korean</option>
              <option value="th">🇹🇭 Thai</option>
              <option value="vi">🇻🇳 Vietnamese</option>
              <option value="id">🇮🇩 Indonesian</option>
              <option value="ms">🇲🇾 Malay</option>
              <option value="tr">🇹🇷 Turkish</option>
              <option value="fa">🇮🇷 Persian</option>
              <option value="ru">🇷🇺 Russian</option>
              <option value="uk">🇺🇦 Ukrainian</option>
              <option value="de">🇩🇪 German</option>
              <option value="fr">🇫🇷 French</option>
              <option value="es">🇪🇸 Spanish</option>
              <option value="pt">🇵🇹 Portuguese</option>
              <option value="it">🇮🇹 Italian</option>
              <option value="nl">🇳🇱 Dutch</option>
              <option value="pl">🇵� Polish</option>
              <option value="ro">🇷🇴 Romanian</option>
              <option value="el">🇬🇷 Greek</option>
              <option value="sv">🇸🇪 Swedish</option>
              <option value="no">🇳🇴 Norwegian</option>
              <option value="da">🇩🇰 Danish</option>
              <option value="fi">🇫🇮 Finnish</option>
              <option value="cs">🇨🇿 Czech</option>
              <option value="hu">🇭🇺 Hungarian</option>
              <option value="he">🇮🇱 Hebrew</option>
              <option value="bg">🇧🇬 Bulgarian</option>
              <option value="hr">🇭🇷 Croatian</option>
              <option value="sr">🇷🇸 Serbian</option>
              <option value="sk">🇸🇰 Slovak</option>
              <option value="sl">🇸🇮 Slovenian</option>
              <option value="lt">🇱🇹 Lithuanian</option>
              <option value="lv">🇱🇻 Latvian</option>
              <option value="et">🇪🇪 Estonian</option>
              <option value="tl">🇵🇭 Tagalog</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tone</label>
            <select className="scraper-input" style={{ marginTop: 6, width: '100%' }} value={tone} onChange={(e) => setTone(e.target.value)}>
              <option value="professional">Professional</option><option value="friendly">Friendly</option><option value="urgent">Urgent</option><option value="casual">Casual</option><option value="formal">Formal</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Length</label>
            <select className="scraper-input" style={{ marginTop: 6, width: '100%' }} value={length} onChange={(e) => setLength(e.target.value)}>
              <option value="short">Short</option><option value="medium">Medium</option><option value="long">Long</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Style</label>
            <select className="scraper-input" style={{ marginTop: 6, width: '100%' }} value={writingStyle} onChange={(e) => setWritingStyle(e.target.value)}>
              <option value="native">Native</option><option value="simple">Simple English</option><option value="direct">Direct</option><option value="salesy">Salesy</option><option value="question">Question-based</option>
            </select>
          </div>
        </div>
        <button className="lf-btn lf-btn-primary" onClick={generate} disabled={loading}>{loading ? 'Generating…' : '✦ Generate Message'}</button>
        {error && <div className="lf-alert lf-alert-error" style={{ fontSize: 12 }}>{error}</div>}
        {generated && (
          <div style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--lf-card-border)', borderRadius: 10, padding: 12 }}>
            <MessageContent content={generated} format="text" />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="lf-btn lf-btn-primary" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={useMessage}>Use Message</button>
              <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
              <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={generate}>Regenerate</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CampaignAnalytics({ total, withChannel, sent, replies, followUpsSent, meetings, deals, channelLabel, entityLabel = 'Leads' }: { total: number; withChannel: number; sent: number; replies: number; followUpsSent: number; meetings: number; deals: number; channelLabel: string; entityLabel?: string }) {
  const replyRate = sent > 0 ? Math.round((replies / sent) * 100) : 0;
  const closeRate = replies > 0 ? Math.round((deals / Math.max(replies, 1)) * 100) : 0;
  const rows = [
    { label: `Total ${entityLabel}`, value: total, color: '#94a3b8' },
    { label: `${channelLabel} Available`, value: withChannel, color: '#22d3ee' },
    { label: 'Messages Sent', value: sent, color: '#a78bfa' },
    { label: 'Replies Received', value: replies, color: '#fbbf24' },
    { label: 'Follow Ups Sent', value: followUpsSent, color: '#f472b6' },
    { label: 'Meetings Booked', value: meetings, color: '#818cf8' },
    { label: 'Deals Closed', value: deals, color: '#34d399' },
  ];
  return (
    <div className="lf-card-premium" style={{ padding: 22 }}>
      <div className="lf-card-accent" />
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Campaign Analytics</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: 'var(--lf-text-secondary)' }}>{r.label}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: r.color }}>{r.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--lf-card-border)', display: 'flex', gap: 16 }}>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#fbbf24' }}>{replyRate}%</div>
          <div style={{ fontSize: 11, color: 'var(--lf-text-secondary)', marginTop: 2 }}>Reply Rate</div>
        </div>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#34d399' }}>{closeRate}%</div>
          <div style={{ fontSize: 11, color: 'var(--lf-text-secondary)', marginTop: 2 }}>Close Rate</div>
        </div>
      </div>
    </div>
  );
}
