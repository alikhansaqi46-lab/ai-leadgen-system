import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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

const CHANNEL_ICON: Record<string, string> = { email: '@', whatsapp: '◉' };
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
}: {
  draft: OutreachDraft;
  busy: boolean;
  moved: boolean;
  onApprove: () => void;
  onReject: () => void;
  onMoveToInbox: () => void;
}) {
  return (
    <div className="lf-draft">
      <div className="lf-draft-head">
        <span className="lf-draft-channel">
          {CHANNEL_ICON[draft.channel] || '•'} {draft.channel}
          {draft.kind === 'followup' ? ` · follow-up (+${draft.waitDays}d)` : ' · initial'}
        </span>
        <span className={`lf-badge ${STATUS_BADGE[draft.status]}`}>{draft.status}</span>
      </div>
      {draft.subject && <div className="lf-draft-subject">{draft.subject}</div>}
      <pre className="lf-draft-body">{draft.body}</pre>
      <div className="lf-draft-actions">
        <button
          className="lf-btn lf-btn-primary"
          onClick={onApprove}
          disabled={busy || draft.status === 'approved'}
        >
          Approve
        </button>
        <button
          className="lf-btn"
          onClick={onReject}
          disabled={busy || draft.status === 'rejected'}
        >
          Reject
        </button>
        {draft.status === 'approved' && (
          <button className="lf-btn" onClick={onMoveToInbox} disabled={busy || moved}>
            {moved ? 'In Inbox ✓' : 'Move to Inbox'}
          </button>
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
  const [drafts, setDrafts] = useState<OutreachDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [moved, setMoved] = useState<Set<string>>(new Set());
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
          AI drafts personalized cold outreach + a follow-up sequence. Nothing is ever sent
          automatically — review and <strong>approve</strong> each message, then send it from the
          existing WhatsApp / Email flows. (Sending wiring lands in S5.3.)
        </div>

        <button className="lf-btn lf-btn-primary" onClick={generate} disabled={generating} style={{ marginBottom: 14 }}>
          {generating ? 'Generating…' : drafts.length ? 'Regenerate drafts' : 'Generate outreach'}
        </button>

        {notice && (
          <div className="lf-alert">
            {notice} <Link className="lf-link" to="/app/inbox">Open Inbox</Link>
          </div>
        )}
        {error && <div className="lf-alert lf-alert-error">{error}</div>}
        {loading && <div className="lf-card lf-skeleton" style={{ height: 160 }} />}

        {!loading && drafts.length === 0 && (
          <div className="lf-empty">
            <span className="lf-empty-badge">No drafts yet</span>
            <p className="lf-empty-text">Generate a personalized email, WhatsApp message and follow-ups for this lead.</p>
          </div>
        )}

        {!loading &&
          drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              busy={busyId === d.id}
              moved={moved.has(d.id)}
              onApprove={() => setStatus(d.id, 'approve')}
              onReject={() => setStatus(d.id, 'reject')}
              onMoveToInbox={() => moveToInbox(d.id)}
            />
          ))}
      </aside>
    </>
  );
}
