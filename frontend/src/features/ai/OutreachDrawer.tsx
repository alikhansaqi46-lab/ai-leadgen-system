import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import MessageContent, { BidiTextArea } from '../../components/MessageContent';
import {
  generateOutreach,
  getDrafts,
  approveDraft,
  rejectDraft,
  startConversationFromDraft,
  OutreachDraft,
  DraftStatus,
  Lead,
} from '../../lib/apiClient';

const CHANNEL_ICON: Record<string, string> = { email: '@', whatsapp: '◉', sms: '✆' };
const STATUS_BADGE: Record<DraftStatus, string> = {
  draft: 'lf-badge-none',
  approved: 'lf-badge-hot',
  rejected: 'lf-badge-cold',
};

function DraftCard({
  draft,
  busy,
  moved,
  onApprove,
  onReject,
  onMoveToInbox,
  onSend,
  onCopy,
  onRegenerate,
}: {
  draft: OutreachDraft;
  busy: boolean;
  moved: boolean;
  onApprove: () => void;
  onReject: () => void;
  onMoveToInbox: () => void;
  onSend: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(draft.body);
  const [editSubject, setEditSubject] = useState(draft.subject || '');

  const saveEdit = () => {
    draft.body = editBody;
    if (draft.subject !== undefined) draft.subject = editSubject;
    setEditing(false);
  };

  return (
    <div className="lf-draft">
      <div className="lf-draft-head">
        <span className="lf-draft-channel">
          {CHANNEL_ICON[draft.channel] || '•'} {draft.channel}
          {draft.kind === 'followup' ? ` · follow-up (+${draft.waitDays}d)` : ' · initial'}
        </span>
        <span className={`lf-badge ${STATUS_BADGE[draft.status]}`}>{draft.status}</span>
      </div>
      {editing ? (
        <>
          {draft.subject !== undefined && (
            <input className="lf-input" style={{ marginBottom: 8, fontSize: 13 }} value={editSubject} onChange={(e) => setEditSubject(e.target.value)} />
          )}
          <BidiTextArea className="lf-textarea" style={{ minHeight: 80, fontSize: 13, marginBottom: 8 }} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button className="lf-btn lf-btn-primary" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={saveEdit}>Save</button>
            <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={() => { setEditing(false); setEditBody(draft.body); setEditSubject(draft.subject || ''); }}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          {draft.subject && <div className="lf-draft-subject">{draft.subject}</div>}
          <MessageContent content={draft.body} format="text" className="lf-draft-body" />
        </>
      )}
      <div className="lf-draft-actions">
        <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={() => setEditing(!editing)} disabled={busy}>
          {editing ? 'Editing…' : 'Edit'}
        </button>
        <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={onCopy} disabled={busy}>Copy</button>
        <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={onRegenerate} disabled={busy}>Regenerate</button>
        <button className="lf-btn lf-btn-primary" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={onApprove} disabled={busy || draft.status === 'approved'}>
          Approve
        </button>
        <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={onReject} disabled={busy || draft.status === 'rejected'}>
          Reject
        </button>
        {draft.status === 'approved' && (
          <>
            <button className="lf-btn lf-btn-primary" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={onSend} disabled={busy || moved}>
              {moved ? 'Sent ✓' : 'Send Now'}
            </button>
            <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={onMoveToInbox} disabled={busy || moved}>
              {moved ? 'In Inbox ✓' : 'Move to Inbox'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function OutreachDrawer({
  leadId,
  lead,
  onClose,
}: {
  leadId: string;
  lead: Lead | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState<OutreachDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [moved, setMoved] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      const res = await getDrafts(leadId);
      setDrafts(res.drafts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load drafts');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  async function generate() {
    try {
      setGenerating(true);
      setError(null);
      const res = await generateOutreach(leadId);
      setDrafts(res.drafts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }

  async function regenerateSingle(draft: OutreachDraft) {
    try {
      setBusyId(draft.id);
      setError(null);
      const res = await generateOutreach(leadId);
      const matching = res.drafts.find((d) => d.channel === draft.channel && d.kind === draft.kind);
      if (matching) {
        setDrafts((prev) => prev.map((d) => (d.id === draft.id ? { ...d, body: matching.body, subject: matching.subject || d.subject } : d)));
        setNotice(`Regenerated ${draft.channel} ${draft.kind} draft.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Regeneration failed');
    } finally {
      setBusyId(null);
    }
  }

  async function setStatus(id: string, action: 'approve' | 'reject') {
    try {
      setBusyId(id);
      const updated = action === 'approve' ? await approveDraft(id) : await rejectDraft(id);
      setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...updated } : d)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  }

  async function moveToInbox(id: string) {
    try {
      setBusyId(id);
      setError(null);
      await startConversationFromDraft(id);
      setMoved((prev) => new Set(prev).add(id));
      setNotice('Added to the Inbox — view it under Inbox.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move to inbox');
    } finally {
      setBusyId(null);
    }
  }

  function sendDraft(draft: OutreachDraft) {
    const msg = encodeURIComponent(draft.body);
    const subj = draft.subject ? encodeURIComponent(draft.subject) : '';
    if (draft.channel === 'whatsapp') {
      navigate(`/app/whatsapp?lead=${encodeURIComponent(leadId)}&msg=${msg}`);
    } else if (draft.channel === 'email') {
      navigate(`/app/email?lead=${encodeURIComponent(leadId)}&msg=${msg}&subject=${subj}`);
    } else if (draft.channel === 'sms') {
      navigate(`/app/sms?lead=${encodeURIComponent(leadId)}&msg=${msg}`);
    }
    setSent((prev) => new Set(prev).add(draft.id));
    setNotice(`Opening ${draft.channel} CRM with draft pre-filled…`);
  }

  function copyDraft(draft: OutreachDraft) {
    const text = draft.subject ? `${draft.subject}\n\n${draft.body}` : draft.body;
    navigator.clipboard.writeText(text);
    setNotice('Draft copied to clipboard.');
    setTimeout(() => setNotice(null), 2000);
  }

  return (
    <>
      <div className="lf-drawer-backdrop" onClick={onClose} />
      <aside className="lf-drawer" role="dialog" aria-label="Outreach drafts">
        <div className="lf-drawer-head">
          <div>
            <h2 className="lf-card-title">{lead?.name || 'Lead'}</h2>
            <div className="lf-muted" style={{ fontSize: 13 }}>
              {[lead?.niche, lead?.city, lead?.country].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
          <button className="lf-icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="lf-note">
          AI drafts personalized outreach across WhatsApp, Email and SMS with follow-up sequences.
          Review, edit, approve and send directly from here.
        </div>

        <button className="lf-btn lf-btn-primary" onClick={generate} disabled={generating} style={{ marginBottom: 14 }}>
          {generating ? 'Generating…' : drafts.length ? 'Regenerate all drafts' : 'Generate outreach'}
        </button>

        {notice && (
          <div className="lf-alert">
            {notice} {notice.includes('Inbox') && <Link className="lf-link" to="/app/inbox">Open Inbox</Link>}
          </div>
        )}
        {error && <div className="lf-alert lf-alert-error">{error}</div>}
        {loading && <div className="lf-card lf-skeleton" style={{ height: 160 }} />}

        {!loading && drafts.length === 0 && (
          <div className="lf-empty">
            <span className="lf-empty-badge">No drafts yet</span>
            <p className="lf-empty-text">Generate personalized WhatsApp, Email and SMS outreach for this lead.</p>
          </div>
        )}

        {!loading &&
          drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              busy={busyId === d.id}
              moved={moved.has(d.id) || sent.has(d.id)}
              onApprove={() => setStatus(d.id, 'approve')}
              onReject={() => setStatus(d.id, 'reject')}
              onMoveToInbox={() => moveToInbox(d.id)}
              onSend={() => sendDraft(d)}
              onCopy={() => copyDraft(d)}
              onRegenerate={() => regenerateSingle(d)}
            />
          ))}
      </aside>
    </>
  );
}
