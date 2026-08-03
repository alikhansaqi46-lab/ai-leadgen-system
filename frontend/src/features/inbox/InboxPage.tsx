import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../common/PageHeader';
import MessageContent, { BidiTextArea } from '../../components/MessageContent';
import QuoteFromConversationDrawer, { QuoteDrawerContext } from '../quotes/components/QuoteFromConversationDrawer';
import QuoteActionButtons from '../quotes/components/QuoteActionButtons';
import ThreadDocumentActions from '../quotes/components/ThreadDocumentActions';
import DocumentHistoryPanel from '../quotes/components/DocumentHistoryPanel';
import { extractShareToken, salesDocumentPublicPdfUrl } from '../quotes/utils/shareUrl';
import {
  getConversations,
  getMessages,
  sendMessage,
  markConversationRead,
  markConversationUnread,
  archiveConversation,
  unarchiveConversation,
  bulkUnarchiveConversations,
  bulkDeleteConversations,
  pinConversation,
  unpinConversation,
  deleteConversation,
  deleteConversationMessages,
  getConversationTimeline,
  generateReply,
  updateCampaignStatus,
  updateLeadNotes,
  getWhatsAppTemplates,
  getEmailTemplates,
  sendConversationReply,
  getOpenAiStatus,
  simulateReply,
  autoReply,
  syncEmail,
  startInboxSession,
  stopInboxSession,
  uploadImage,
  getConversationSettings,
  updateConversationSettings,
  takeOverConversation,
  resumeAiConversation,
  Conversation,
  Message,
  WhatsAppTemplate,
  EmailTemplate,
} from '../../lib/apiClient';

const CHANNEL_ICON: Record<string, string> = { email: '@', whatsapp: '◉', sms: '✆' };

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function getInitials(name: string | undefined): string {
  if (!name) return '?';
  const parts = name.split(' ').filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] || '?').slice(0, 2).toUpperCase();
  const first = parts[0]?.[0] || '';
  const last = parts[parts.length - 1]?.[0] || '';
  return (first + last).toUpperCase() || '?';
}

function getCampaignName(conv: Conversation): string {
  // Use conversation subject as the primary campaign identifier (what the user actually sent)
  if (conv.subject) return conv.subject;
  const niche = conv.lead?.niche;
  if (niche) return `${niche} Campaign`;
  if (conv.channel === 'whatsapp') return 'WhatsApp Outreach';
  if (conv.channel === 'sms') return 'SMS Outreach';
  return 'Email Outreach';
}

function isPreviewConversation(conv: Conversation): boolean {
  return conv.leadId?.startsWith('preview_') || (conv as any).metadata?.isPreview === true || (conv as any).subject?.startsWith('[Preview]');
}

function isContactConversation(conv: Conversation): boolean {
  return conv.entityType === 'contact' || conv.leadId?.startsWith('contact:');
}

function stripQuotedHtmlClient(html: string): string {
  if (!html) return '';
  let cleaned = html;
  cleaned = cleaned.replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/<div[^>]*class="[^"]*gmail_attr[^"]*"[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '');
  cleaned = cleaned.replace(/(<br\s*\/?>|\n)*On .+ wrote:[\s\S]*$/i, '');
  return cleaned.trim();
}

function isInitialCampaignMessage(m: Message): boolean {
  const meta = m.metadata as Record<string, unknown> | null | undefined;
  return Boolean(
    meta?.isInitialCampaign
    || m.source === 'campaign'
    || m.source === 'contact_campaign'
  );
}

function resolveImageUrl(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;
  const candidate = meta.imageUrl || meta.mediaUrl;
  if (candidate) {
    const raw = String(candidate);
    if (raw.startsWith('http')) {
      try { return new URL(raw).pathname; } catch { return raw; }
    }
    return raw;
  }
  const attachments = meta.attachments as Array<{ url?: string; type?: string }> | undefined;
  const imageAtt = attachments?.find((a) => !a.type || a.type === 'image' || String(a.type).startsWith('image'));
  const att = imageAtt || attachments?.[0];
  if (att?.url) {
    const raw = String(att.url);
    if (raw.startsWith('http')) {
      try { return new URL(raw).pathname; } catch { return raw; }
    }
    return raw;
  }
  return null;
}

type MediaAttachment = {
  url: string;
  type: 'image' | 'video' | 'document' | 'audio' | 'file';
  name?: string | null;
  mime?: string | null;
};

function resolveMediaAttachments(m: Message): MediaAttachment[] {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const out: MediaAttachment[] = [];
  const seen = new Set<string>();

  const push = (urlRaw: unknown, typeHint?: string, name?: string | null, mime?: string | null) => {
    if (!urlRaw) return;
    let url = String(urlRaw);
    if (url.startsWith('http')) {
      try { url = new URL(url).pathname; } catch { /* keep */ }
    }
    if (!url || seen.has(url)) return;
    seen.add(url);
    const mimeStr = String(mime || '').toLowerCase();
    const hint = String(typeHint || m.messageType || '').toLowerCase();
    let type: MediaAttachment['type'] = 'file';
    if (hint.includes('image') || mimeStr.startsWith('image/')) type = 'image';
    else if (hint.includes('video') || mimeStr.startsWith('video/')) type = 'video';
    else if (hint.includes('audio') || mimeStr.startsWith('audio/')) type = 'audio';
    else if (hint.includes('document') || hint.includes('pdf') || mimeStr.includes('pdf')) type = 'document';
    else if (/\.(jpg|jpeg|png|gif|webp)$/i.test(url)) type = 'image';
    else if (/\.(mp4|webm|mov)$/i.test(url)) type = 'video';
    else if (/\.(pdf|doc|docx|xls|xlsx)$/i.test(url)) type = 'document';
    out.push({ url, type, name: name || null, mime: mime || null });
  };

  const attachments = meta.attachments as Array<{ url?: string; type?: string; mime?: string; filename?: string; name?: string }> | undefined;
  if (Array.isArray(attachments)) {
    for (const a of attachments) {
      push(a.url, a.type, a.filename || a.name || null, a.mime || null);
    }
  }
  if (meta.imageUrl) push(meta.imageUrl, 'image', null, meta.mime as string | null);
  if (meta.mediaUrl) push(meta.mediaUrl, String(meta.mediaType || m.messageType || 'file'), (meta.filename || meta.fileName) as string | null, meta.mime as string | null);

  return out;
}

function MessageMediaPreview({ attachments }: { attachments: MediaAttachment[] }) {
  if (!attachments.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
      {attachments.map((att) => {
        if (att.type === 'image') {
          return (
            <a key={att.url} href={att.url} target="_blank" rel="noreferrer" style={{ display: 'block' }}>
              <img
                src={att.url}
                alt={att.name || 'Attachment'}
                style={{ maxWidth: '100%', maxHeight: 280, borderRadius: 10, display: '1px solid var(--lf-card-border)', objectFit: 'contain', background: 'rgba(0,0,0,0.2)' }}
              />
            </a>
          );
        }
        if (att.type === 'video') {
          return (
            <video key={att.url} controls src={att.url} style={{ maxWidth: '100%', maxHeight: 280, borderRadius: 10, background: '#000' }}>
              <track kind="captions" />
            </video>
          );
        }
        if (att.type === 'audio') {
          return <audio key={att.url} controls src={att.url} style={{ width: '100%' }} />;
        }
        return (
          <a
            key={att.url}
            href={att.url}
            target="_blank"
            rel="noreferrer"
            className="lf-btn"
            style={{ height: 32, padding: '0 12px', fontSize: 12, alignSelf: 'flex-start', textDecoration: 'none' }}
          >
            {att.type === 'document' ? '📄' : '📎'} {att.name || 'Open attachment'}
          </a>
        );
      })}
    </div>
  );
}

function rewriteCidImages(html: string, meta: Record<string, unknown> | null | undefined): string {
  if (!html.includes('cid:')) return html;
  const imageUrl = resolveImageUrl(meta);
  if (!imageUrl) return html;
  return html.replace(/src="cid:[^"]+"/gi, `src="${imageUrl}"`);
}

function getThreadMessageContent(m: Message): { type: 'html' | 'text'; content: string } {
  const meta = m.metadata as Record<string, unknown> | null | undefined;
  if (m.messageType === 'email') {
    if (m.direction === 'inbound') {
      const display = String(meta?.displayHtml || meta?.replyHtml || '');
      if (display) return { type: 'html', content: display };
      if (meta?.html) {
        const stripped = stripQuotedHtmlClient(String(meta.html));
        if (stripped) return { type: 'html', content: stripped };
      }
      return { type: 'text', content: m.body || '' };
    }
    if (meta?.html && (isInitialCampaignMessage(m) || m.direction === 'outbound')) {
      return { type: 'html', content: rewriteCidImages(String(meta.html), meta) };
    }
    return { type: 'text', content: m.body || '' };
  }
  return { type: 'text', content: m.body || '' };
}

function groupConversationsByLead(list: Conversation[]): Conversation[] {
  const map = new Map<string, Conversation>();
  for (const c of list) {
    const key = c.leadId || c.id;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...c, channels: [c.channel] });
      continue;
    }
    const channels = Array.from(new Set([...(existing.channels || [existing.channel]), c.channel]));
    const unreadCount = (existing.unreadCount || 0) + (c.unreadCount || 0);
    const useCurrent = String(c.lastMessageAt || c.createdAt) > String(existing.lastMessageAt || existing.createdAt);
    const primary = useCurrent ? c : existing;
    map.set(key, { ...primary, channels, unreadCount });
  }
  return Array.from(map.values());
}

function ConversationRow({
  conv,
  active,
  onClick,
  onAction,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  conv: Conversation;
  active: boolean;
  onClick: () => void;
  onAction?: (action: string) => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const hasUnread = (conv.unreadCount || 0) > 0;
  const isPreview = isPreviewConversation(conv);
  const isContact = isContactConversation(conv);
  const last = conv.lastMessage;
  const notify = conv.notificationStatus;
  const showNotifyBadge = notify && !(active && notify.type === 'new_reply');

  // Preview text logic
  let preview = 'No messages yet';
  if (last) {
    if (last.metadata?.subject && !last.body) preview = last.metadata.subject;
    else if (last.body) preview = last.body.slice(0, 60);
    else preview = 'Image received';
  }
  if (last?.metadata?.html && !last?.body) {
    preview = 'HTML email received';
  }

  const isReply = last?.direction === 'inbound';
  const hasImage = last?.metadata?.html?.includes('<img') || last?.metadata?.html?.includes('data:image');
  const hasAttachment = last?.metadata?.attachments && last.metadata.attachments.length > 0;

  return (
    <button
      className={`lf-conv-row${active ? ' lf-conv-row-active' : ''}${hasUnread ? ' lf-conv-row-unread' : ''}`}
      onClick={onClick}
      style={{ position: 'relative' }}
    >
      {hasUnread && <span className="lf-conv-unread-badge">{conv.unreadCount}</span>}
      {showNotifyBadge && (
        <span className={`lf-conv-notify-badge lf-conv-notify-${notify.type}`} title={notify.label}>
          {notify.icon} {notify.label}
        </span>
      )}
      {isPreview && (
        <span className="lf-pill" style={{ position: 'absolute', top: 4, right: 4, fontSize: 9, background: '#22c55e20', color: '#22c55e', border: '1px solid #22c55e40', padding: '1px 6px' }}>
          Preview
        </span>
      )}
      {isContact && !isPreview && (
        <span className="lf-pill" style={{ position: 'absolute', top: 4, right: 4, fontSize: 9, background: '#38bdf820', color: '#38bdf8', border: '1px solid #38bdf840', padding: '1px 6px' }}>
          Contact
        </span>
      )}
      <div className="lf-conv-row-inner">
        {selectable && (
          <label
            className="lf-conv-row-check"
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', alignItems: 'center', paddingRight: 2 }}
          >
            <input type="checkbox" checked={selected} onChange={() => onToggleSelect?.()} />
          </label>
        )}
        <span className="lf-conv-avatar">{getInitials(conv.lead?.name)}</span>
        <div className="lf-conv-row-meta">
          <div className="lf-conv-row-top">
            <span className="lf-conv-name">{conv.lead?.name || conv.leadId}</span>
            <span className="lf-conv-time">{timeAgo(conv.lastMessageAt)}</span>
          </div>
          <div className="lf-conv-preview" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="lf-conv-channel">{CHANNEL_ICON[conv.channel] || '•'}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {isReply && <span style={{ color: '#fbbf24', marginRight: 4 }}>↩</span>}
              {preview}
            </span>
            {hasImage && <span title="Image">🖼</span>}
            {hasAttachment && <span title="Attachment">📎</span>}
            {conv.channels && conv.channels.length > 1 && (
              <span title="Channels" style={{ fontSize: 10, opacity: 0.7 }}>
                {conv.channels.map((ch) => CHANNEL_ICON[ch] || '•').join('')}
              </span>
            )}
          </div>
        </div>
      </div>
      {/* Inline action icons on hover — simple buttons */}
      {onAction && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4, justifyContent: 'flex-end' }}>
          {conv.archived ? (
            <>
              <button className="lf-btn" style={{ height: 22, padding: '0 8px', fontSize: 10 }} onClick={(e) => { e.stopPropagation(); onAction('unarchive'); }} title="Restore">↩ Restore</button>
              <button className="lf-btn lf-btn-danger" style={{ height: 22, padding: '0 8px', fontSize: 10 }} onClick={(e) => { e.stopPropagation(); onAction('delete-permanent'); }} title="Delete permanently">🗑 Delete</button>
            </>
          ) : (
            <>
              <button className="lf-btn" style={{ height: 22, padding: '0 8px', fontSize: 10 }} onClick={(e) => { e.stopPropagation(); onAction('read'); }} title="Mark read">✓</button>
              <button className="lf-btn" style={{ height: 22, padding: '0 8px', fontSize: 10 }} onClick={(e) => { e.stopPropagation(); onAction('archive'); }} title="Archive">🗑</button>
              <button className="lf-btn" style={{ height: 22, padding: '0 8px', fontSize: 10 }} onClick={(e) => { e.stopPropagation(); onAction('pin'); }} title="Pin">📌</button>
            </>
          )}
        </div>
      )}
    </button>
  );
}

function MessageStatus({ status }: { status?: 'sent' | 'delivered' | 'read' | null }) {
  if (!status) return null;
  if (status === 'read') {
    return (
      <span className="lf-wa-status lf-wa-status-read" title="Read">
        <svg className="lf-wa-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/><polyline points="20 6 9 17 4 12" transform="translate(4, 0)"/></svg>
      </span>
    );
  }
  if (status === 'delivered') {
    return (
      <span className="lf-wa-status lf-wa-status-delivered" title="Delivered">
        <svg className="lf-wa-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/><polyline points="20 6 9 17 4 12" transform="translate(4, 0)"/></svg>
      </span>
    );
  }
  return (
    <span className="lf-wa-status lf-wa-status-sent" title="Sent">
      <svg className="lf-wa-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </span>
  );
}

function DateSeparator({ date }: { date: string }) {
  return (
    <div className="lf-wa-date-sep">{new Date(date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
  );
}

const STATUS_OPTIONS = [
  { value: 'new', label: 'New', color: '#94a3b8' },
  { value: 'sent', label: 'Sent', color: '#22d3ee' },
  { value: 'replied', label: 'Replied', color: '#a78bfa' },
  { value: 'interested', label: 'Interested', color: '#fbbf24' },
  { value: 'meeting', label: 'Meeting', color: '#f472b6' },
  { value: 'deal', label: 'Deal', color: '#34d399' },
  { value: 'lost', label: 'Lost', color: '#64748b' },
];

function ContactPanel({
  conversation,
  onStatusChange,
  onOpenQuote,
}: {
  conversation: Conversation;
  onStatusChange?: (leadId: string, status: string) => void;
  onOpenQuote?: (ctx: QuoteDrawerContext) => void;
}) {
  const lead = conversation.lead;
  const isContact = isContactConversation(conversation);
  const [notesDraft, setNotesDraft] = useState(lead?.notes || '');
  const [notesSaving, setNotesSaving] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    contact: true,
    details: false,
    campaign: false,
  });

  useEffect(() => {
    setNotesDraft(lead?.notes || '');
  }, [lead?.id]);

  if (!lead) {
    return (
      <div className="lf-thread-contact">
        <div className="lf-contact-avatar">?</div>
        <div className="lf-contact-name">Unknown Lead</div>
        <div className="lf-contact-meta">ID: {conversation.leadId}</div>
      </div>
    );
  }

  const scoreColors: Record<string, string> = { hot: '#fb7185', warm: '#fbbf24', cold: '#94a3b8' };
  const scoreLabel = lead.score ? (lead.score >= 70 ? 'hot' : lead.score >= 40 ? 'warm' : 'cold') : null;

  const handleStatusChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newStatus = e.target.value;
    if (!lead.id) return;
    setSavingStatus(true);
    try {
      await updateCampaignStatus(lead.id, newStatus);
      onStatusChange?.(lead.id, newStatus);
    } catch (err) {
      console.error('Failed to update status:', err);
    } finally {
      setSavingStatus(false);
    }
  };

  const saveNotes = async () => {
    if (!lead.id) return;
    setNotesSaving(true);
    try {
      await updateLeadNotes(lead.id, notesDraft);
    } catch (err) {
      console.error('Failed to save notes:', err);
    } finally {
      setNotesSaving(false);
    }
  };

  const toggleSection = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const Section = ({ title, sectionKey, children }: { title: string; sectionKey: string; children: React.ReactNode }) => (
    <div className="lf-contact-section">
      <button
        className="lf-contact-section-title"
        onClick={() => toggleSection(sectionKey)}
        style={{ background: 'none', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <span>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--lf-muted)', transition: 'transform 0.2s', transform: expanded[sectionKey] ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
      </button>
      {expanded[sectionKey] && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );

  return (
    <div className="lf-thread-contact">
      {/* Header Card */}
      <div style={{ padding: 16, borderBottom: '1px solid var(--lf-border)', textAlign: 'center' }}>
        <div className="lf-contact-avatar" style={{ width: 56, height: 56, fontSize: 20, margin: '0 auto 10px' }}>{getInitials(lead.name)}</div>
        <div className="lf-contact-name" style={{ fontSize: 16, marginBottom: 4 }}>{lead.name || 'Unnamed'}</div>
        <div className="lf-contact-meta" style={{ fontSize: 12 }}>{isContact ? 'Personal Contact' : (lead.niche || 'No niche')} {lead.city && !isContact ? `· ${lead.city}` : ''}</div>
        <div style={{ marginTop: 10, display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
          {isContact ? (
            <>
              <Link className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 12 }} to="/app/contacts">
                Open Contacts
              </Link>
              {onOpenQuote && (
                <QuoteActionButtons
                  conversationId={conversation.id}
                  leadName={lead.name}
                  channel={conversation.channel}
                  onOpen={onOpenQuote}
                  compact
                />
              )}
            </>
          ) : (
            <>
              <Link className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 12 }} to={`/app/contacts?lead=${lead.id}`}>
                Open contact profile
              </Link>
              {onOpenQuote && (
                <QuoteActionButtons
                  conversationId={conversation.id}
                  leadId={lead.id}
                  leadName={lead.name}
                  channel={conversation.channel}
                  onOpen={onOpenQuote}
                  compact
                />
              )}
            </>
          )}
        </div>
        {scoreLabel && (
          <div style={{ marginTop: 8 }}>
            <span className="lf-contact-pill" style={{ background: `${scoreColors[scoreLabel]}20`, color: scoreColors[scoreLabel], borderColor: `${scoreColors[scoreLabel]}40` }}>
              {scoreLabel.toUpperCase()} {lead.score ? `· ${lead.score}` : ''}
            </span>
          </div>
        )}
      </div>

      {/* Pipeline Status — lead-only. Contact campaigns keep history in the thread. */}
      {!isContact && <div className="lf-contact-section" style={{ borderBottom: '1px solid var(--lf-border)', marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_OPTIONS.find((s) => s.value === (conversation.pipelineStatus || 'new'))?.color || '#94a3b8' }} />
          <div className="lf-contact-section-title" style={{ marginBottom: 0 }}>Pipeline</div>
        </div>
        <select
          className="scraper-input"
          style={{ width: '100%', fontSize: 13 }}
          value={conversation.pipelineStatus || 'new'}
          onChange={handleStatusChange}
          disabled={savingStatus}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>}

      <Section title="Contact Info" sectionKey="contact">
        {lead.phone && (
          <div className="lf-contact-row">
            <span className="lf-contact-row-label">Phone</span>
            <a className="lf-contact-link" href={`tel:${lead.phone}`} target="_blank" rel="noreferrer">{lead.phone}</a>
          </div>
        )}
        {lead.email && (
          <div className="lf-contact-row">
            <span className="lf-contact-row-label">Email</span>
            <a className="lf-contact-link" href={`mailto:${lead.email}`} target="_blank" rel="noreferrer">{lead.email}</a>
          </div>
        )}
        {lead.website && (
          <div className="lf-contact-row">
            <span className="lf-contact-row-label">Website</span>
            <a className="lf-contact-link" href={lead.website} target="_blank" rel="noreferrer">{lead.website.replace(/^https?:\/\//, '').slice(0, 24)}…</a>
          </div>
        )}
        {lead.mapsUrl && (
          <div className="lf-contact-row">
            <span className="lf-contact-row-label">Maps</span>
            <a className="lf-contact-link" href={lead.mapsUrl} target="_blank" rel="noreferrer">Open</a>
          </div>
        )}
      </Section>

      <Section title="Details" sectionKey="details">
        {isContact && <div className="lf-contact-row"><span className="lf-contact-row-label">Type</span><span className="lf-contact-row-value">Personal Contact</span></div>}
        {!isContact && <div className="lf-contact-row"><span className="lf-contact-row-label">Country</span><span className="lf-contact-row-value">{lead.country || '—'}</span></div>}
        <div className="lf-contact-row"><span className="lf-contact-row-label">Source</span><span className="lf-contact-row-value">{lead.source || '—'}</span></div>
        <div className="lf-contact-row"><span className="lf-contact-row-label">Added</span><span className="lf-contact-row-value">{formatDate(lead.createdAt)}</span></div>
      </Section>

      <Section title="Campaign" sectionKey="campaign">
        <div className="lf-contact-row"><span className="lf-contact-row-label">Channel</span><span className="lf-contact-row-value">{conversation.channel}</span></div>
        <div className="lf-contact-row"><span className="lf-contact-row-label">Subject</span><span className="lf-contact-row-value">{conversation.subject || '—'}</span></div>
        <div className="lf-contact-row"><span className="lf-contact-row-label">Messages</span><span className="lf-contact-row-value">{conversation.messageCount || 0}</span></div>
      </Section>

      {/* Notes — lead notes are persisted through Lead CRM; contact notes are read-only here for now. */}
      <div className="lf-contact-section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div className="lf-contact-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          Notes
          {!isContact && <button className="lf-btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }} onClick={saveNotes} disabled={notesSaving}>
            {notesSaving ? 'Saving…' : 'Save'}
          </button>}
        </div>
        <textarea
          className="lf-textarea"
          style={{ width: '100%', flex: 1, minHeight: 80, fontSize: 13, marginTop: 6, resize: 'none' }}
          placeholder={isContact ? 'Contact notes from the Contact Manager.' : 'Add notes about this lead…'}
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          readOnly={isContact}
        />
      </div>
    </div>
  );
}

function Thread({
  conversation,
  onStatusChange,
  onMarkRead,
  onArchive,
  onDeleteConversation,
  onOpenQuote,
  onRefreshThread,
}: {
  conversation: Conversation;
  onStatusChange?: (leadId: string, status: string) => void;
  onMarkRead?: (conversationId: string) => void;
  onArchive?: (conversationId: string) => void;
  onDeleteConversation?: (conversationId: string) => void;
  onOpenQuote?: (ctx: QuoteDrawerContext) => void;
  onRefreshThread?: () => void;
}) {
  const conversationId = conversation.id;
  const isEmail = conversation.channel === 'email';
  const isSms = conversation.channel === 'sms';
  const isWhatsApp = conversation.channel === 'whatsapp';
  const supportsAiAutoReply = isEmail || isWhatsApp || isSms;
  const [messages, setMessages] = useState<Message[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [subject, setSubject] = useState(conversation.subject || '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [freeAiMessages, setFreeAiMessages] = useState<number | null>(null);
  const [aiSource, setAiSource] = useState<string>('master');
  const [simulateBody, setSimulateBody] = useState('');
  const [simulateLoading, setSimulateLoading] = useState(false);
  const [simulateError, setSimulateError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // AI Reply Workflow state
  const [aiState, setAiState] = useState<'idle' | 'detected' | 'analyzing' | 'ready'>('idle');
  const [aiDraft, setAiDraft] = useState<string>('');
  const [lastInboundId, setLastInboundId] = useState<string | null>(null);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [humanTakeover, setHumanTakeover] = useState(false);
  const [aiSettingsBusy, setAiSettingsBusy] = useState(false);
  const autoReplyAttemptedRef = useRef<string | null>(null);

  // Template selector state
  const [waTemplates, setWaTemplates] = useState<WhatsAppTemplate[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [showTemplates, setShowTemplates] = useState(false);
  const [replyImageUrl, setReplyImageUrl] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [manageBusy, setManageBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (isSms) return; // SMS does not use templates
      try {
        if (isEmail) {
          const tpl = await getEmailTemplates();
          if (active) setEmailTemplates(tpl.templates || []);
        } else {
          const tpl = await getWhatsAppTemplates();
          if (active) setWaTemplates(tpl.templates || []);
        }
      } catch { /* ignore */ }
    })();
    return () => { active = false; };
  }, [isEmail, isSms]);

  async function load() {
    try {
      setLoading(true);
      const [msgRes, tlRes] = await Promise.all([
        getMessages(conversationId),
        getConversationTimeline(conversationId).catch(() => ({ events: [] })),
      ]);
      setMessages(Array.isArray(msgRes?.messages) ? msgRes.messages : []);
      setTimeline(Array.isArray(tlRes?.events) ? tlRes.events : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load thread');
    } finally {
      setLoading(false);
    }
  }

  async function loadSuggestions() {
    try {
      setAiLoading(true);
      const res = await generateReply(conversationId);
      setAiSuggestions([res.suggestion.body]);
      if (res.freeAiMessagesRemaining !== undefined && res.freeAiMessagesRemaining !== null) {
        setFreeAiMessages(res.freeAiMessagesRemaining);
      }
    } catch (err: any) {
      if (err.response?.data?.code === 'FREE_MESSAGES_EXHAUSTED') {
        setAiSuggestions([]);
        setFreeAiMessages(0);
      } else {
        // Fallback to generic suggestions on API error
        setAiSuggestions([
          "Thanks for your interest! I'd love to schedule a quick call.",
          "Great to hear from you! When would be a good time to connect?",
          "Appreciate your reply. Can I send over some more details?",
        ]);
      }
    } finally {
      setAiLoading(false);
    }
  }

  useEffect(() => {
    load();
    markConversationRead(conversationId).then(() => {
      onMarkRead?.(conversationId);
    }).catch(() => {});
    // Only fetch AI status (no credit consumption); suggestions are loaded on explicit user request
    getOpenAiStatus().then((s) => {
      setFreeAiMessages(s.freeMessagesRemaining);
      setAiSource(s.source);
    }).catch(() => {});
    if (supportsAiAutoReply) {
      getConversationSettings(conversationId).then((res) => {
        const enabled = res.settings?.autoReplyEnabled;
        setAutoReplyEnabled(enabled === null || enabled === undefined ? true : Boolean(enabled));
        setHumanTakeover(Boolean(res.settings?.humanTakeover) || res.status === 'human_active');
      }).catch(() => {
        setAutoReplyEnabled(true);
        setHumanTakeover(conversation.status === 'human_active');
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Poll messages + timeline every 5s when tab is visible
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        getMessages(conversationId, true).then((res) => setMessages(Array.isArray(res?.messages) ? res.messages : [])).catch(() => {});
        getConversationTimeline(conversationId).then((res) => setTimeline(Array.isArray(res?.events) ? res.events : [])).catch(() => {});
        if (supportsAiAutoReply) {
          getConversationSettings(conversationId).then((res) => {
            setHumanTakeover(Boolean(res.settings?.humanTakeover) || res.status === 'human_active');
            const enabled = res.settings?.autoReplyEnabled;
            if (enabled !== null && enabled !== undefined) setAutoReplyEnabled(Boolean(enabled));
          }).catch(() => {});
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [conversationId, supportsAiAutoReply]);

  useEffect(() => {
    setSelectedMessageIds(new Set());
    setLastInboundId(null);
    setAiState('idle');
    setAiDraft('');
    autoReplyAttemptedRef.current = null;
  }, [conversationId]);

  // AI Reply Workflow: detect unanswered customer replies.
  // A reply only counts as "awaiting a response" when it is the most recent
  // message in the thread (mirrors the backend's own guard in
  // autonomousReplyService.js) — this prevents re-firing on old, already
  // -answered inbound messages while still firing immediately for a
  // genuinely new/unanswered reply, including right when the thread first
  // loads (e.g. after a page reload).
  useEffect(() => {
    if (!supportsAiAutoReply || humanTakeover) {
      setAiState('idle');
      return;
    }
    const chronological = [...messages].sort(
      (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    );
    const lastMessage = chronological[chronological.length - 1];
    const lastInbound = [...chronological].reverse().find((m) => m.direction === 'inbound');

    if (!lastInbound || !lastMessage || lastMessage.direction !== 'inbound' || lastMessage.id !== lastInbound.id) {
      setAiState('idle');
      setAiDraft('');
      return;
    }

    if (lastInbound.id !== lastInboundId) {
      setLastInboundId(lastInbound.id);
      setAiState('detected');
    } else if (aiState === 'idle') {
      setAiState('detected');
    }

    // Fire when Auto Reply is on — including when settings load AFTER messages (race fix).
    // Attempt at most once per inbound message id.
    if (autoReplyEnabled && autoReplyAttemptedRef.current !== lastInbound.id) {
      autoReplyAttemptedRef.current = lastInbound.id;
      handleAutoReply();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, autoReplyEnabled, humanTakeover, supportsAiAutoReply]);

  async function handleToggleAutoReply(next: boolean) {
    setAutoReplyEnabled(next);
    if (!supportsAiAutoReply) return;
    setAiSettingsBusy(true);
    try {
      const res = await updateConversationSettings(conversationId, {
        autoReplyEnabled: next,
        ...(next ? { humanTakeover: false } : {}),
      });
      setHumanTakeover(Boolean(res.settings?.humanTakeover));
      setAutoReplyEnabled(res.settings?.autoReplyEnabled === null || res.settings?.autoReplyEnabled === undefined
        ? next
        : Boolean(res.settings.autoReplyEnabled));
    } catch (err) {
      console.error('Failed to save auto-reply setting', err);
    } finally {
      setAiSettingsBusy(false);
    }
  }

  async function handleTakeOver() {
    setAiSettingsBusy(true);
    try {
      const res = await takeOverConversation(conversationId);
      setHumanTakeover(true);
      setAutoReplyEnabled(false);
      setAiState('idle');
      setAiDraft('');
      if (res.status) { /* status reflected via poll */ }
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || 'Take over failed');
    } finally {
      setAiSettingsBusy(false);
    }
  }

  async function handleResumeAi() {
    setAiSettingsBusy(true);
    try {
      await resumeAiConversation(conversationId);
      setHumanTakeover(false);
      setAutoReplyEnabled(true);
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || 'Resume AI failed');
    } finally {
      setAiSettingsBusy(false);
    }
  }

  async function handleAutoReply() {
    if (aiState === 'analyzing') return;
    setAiState('analyzing');
    try {
      const res = await autoReply(conversationId);
      if (res.success) {
        setAiDraft(res.message.body);
        setAiState('ready');
        await load();
      } else {
        setAiState('idle');
      }
    } catch (err: any) {
      console.error('Auto reply failed:', err);
      const errMsg = err?.response?.data?.error || err?.message || 'Auto-reply failed';
      setError(errMsg);
      setAiState('idle');
    }
  }

  async function handleGenerateAiReply() {
    setAiState('analyzing');
    try {
      const res = await generateReply(conversationId);
      setAiDraft(res.suggestion.body);
      if (res.freeAiMessagesRemaining !== undefined) {
        setFreeAiMessages(res.freeAiMessagesRemaining);
      }
      setAiState('ready');
    } catch (err: any) {
      if (err.response?.data?.code === 'FREE_MESSAGES_EXHAUSTED') {
        setFreeAiMessages(0);
      }
      setAiState('detected');
    }
  }

  async function handleSendAiReply() {
    if (!aiDraft.trim()) return;
    await send(aiDraft);
    setAiState('idle');
    setAiDraft('');
  }

  function handleEditAiReply() {
    setDraft(aiDraft);
    setAiState('idle');
  }

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [messages, loading]);

  async function send(bodyOverride?: string) {
    const msgBody = bodyOverride || draft;
    if (!msgBody.trim()) return;
    try {
      setSending(true);
      const lead = conversation.lead;
      let body = msgBody.trim();
      if (selectedTemplate && lead) {
        body = body
          .replace(/{name}/g, lead.name || 'there')
          .replace(/{city}/g, lead.city || '')
          .replace(/{niche}/g, lead.niche || 'business');
      }

      if (isEmail && lead?.email) {
        await sendConversationReply(conversationId, {
          body,
          subject: subject.trim() || undefined,
          imageUrl: replyImageUrl || undefined,
        });
        await load();
        setDraft('');
        setSubject('');
        setReplyImageUrl(null);
        setHumanTakeover(true);
        setAutoReplyEnabled(false);
      } else if (isSms && lead?.phone) {
        await sendConversationReply(conversationId, { body });
        await load();
        setDraft('');
      } else if (conversation.channel === 'whatsapp' && (lead?.whatsapp || lead?.phone)) {
        await sendConversationReply(conversationId, { body, imageUrl: replyImageUrl || undefined });
        await load();
        setDraft('');
        setReplyImageUrl(null);
        setHumanTakeover(true);
        setAutoReplyEnabled(false);
      } else {
        const msg = await sendMessage(conversationId, body);
        setMessages((prev) => [...prev, msg]);
        setDraft('');
      }
      setSelectedTemplate('');
      setTemplateVars({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add message');
    } finally {
      setSending(false);
    }
  }

  async function handleSimulate() {
    if (!simulateBody.trim()) return;
    setSimulateLoading(true); setSimulateError(null);
    try {
      const res = await simulateReply(conversationId, simulateBody.trim());
      if (res.success) {
        setMessages((prev) => [...prev, { id: res.inbound.id, body: res.inbound.body, direction: 'inbound', channel: conversation.channel, createdAt: new Date().toISOString(), source: 'preview-simulate', status: null, messageType: 'text' } as Message, { id: res.reply.id, body: res.reply.body, direction: 'outbound', channel: conversation.channel, createdAt: new Date().toISOString(), source: 'preview-ai', status: 'sent', messageType: 'text' } as Message]);
        setSimulateBody('');
      }
    } catch (err: any) {
      setSimulateError(err?.response?.data?.error || err.message || 'Simulation failed');
    } finally {
      setSimulateLoading(false);
    }
  }

  if (loading) return <div className="lf-card lf-skeleton" style={{ height: 320, margin: 16 }} />;

  // Merge messages + timeline events into a single chronological list
  type ThreadItem =
    | { kind: 'message'; data: Message; ts: number }
    | { kind: 'event'; data: any; ts: number };

  const safeMessages = Array.isArray(messages) ? messages : [];
  const safeTimeline = Array.isArray(timeline) ? timeline : [];
  const selectableMessageIds = safeMessages.map((m) => m.id);
  const allMessagesSelected = selectableMessageIds.length > 0 && selectableMessageIds.every((id) => selectedMessageIds.has(id));

  function toggleMessageSelection(messageId: string) {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }

  function toggleSelectAllMessages() {
    setSelectedMessageIds((prev) => (
      selectableMessageIds.length > 0 && selectableMessageIds.every((id) => prev.has(id))
        ? new Set<string>()
        : new Set(selectableMessageIds)
    ));
  }

  async function handleDeleteSelectedMessages() {
    if (selectedMessageIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedMessageIds.size} selected message(s)?`)) return;
    setManageBusy(true);
    try {
      await deleteConversationMessages(conversationId, Array.from(selectedMessageIds));
      setSelectedMessageIds(new Set());
      await load();
    } catch (err: any) {
      window.alert(err?.response?.data?.error || err?.message || 'Failed to delete messages');
    } finally {
      setManageBusy(false);
    }
  }

  async function handleArchiveConversation() {
    if (!window.confirm('Archive this conversation?')) return;
    setManageBusy(true);
    try {
      await onArchive?.(conversationId);
    } finally {
      setManageBusy(false);
    }
  }

  async function handleDeleteConversation() {
    if (!window.confirm('Delete this entire conversation? This cannot be undone.')) return;
    setManageBusy(true);
    try {
      await onDeleteConversation?.(conversationId);
    } finally {
      setManageBusy(false);
    }
  }

  const threadItems: ThreadItem[] = [
    ...safeMessages.map((m) => ({ kind: 'message' as const, data: m, ts: new Date(m.createdAt || 0).getTime() })),
    ...safeTimeline.map((e) => ({ kind: 'event' as const, data: e, ts: new Date(e.createdAt || 0).getTime() })),
  ].sort((a, b) => a.ts - b.ts);

  const groupedItems = threadItems.reduce<{ date: string; items: ThreadItem[] }[]>((groups, item) => {
    const createdAt = item?.data?.createdAt;
    const date = typeof createdAt === 'string' ? createdAt.split('T')[0] : '';
    const last = groups[groups.length - 1];
    if (last && last.date === date) {
      last.items.push(item);
    } else {
      groups.push({ date, items: [item] });
    }
    return groups;
  }, []);

  const eventLabel = (type: string, payload?: any) => {
    if (type === 'ai_action') {
      const action = payload?.action;
      if (action === 'human_takeover' || action === 'human_reply') return 'Human took over';
      if (action === 'resume_ai') return 'AI resumed';
      if (action === 'auto_reply' || action === 'ai_reply') return 'AI replied';
      return 'AI action';
    }
    const map: Record<string, string> = {
      contact_created: 'Contact created',
      lead_created: 'Lead created',
      message_sent: 'Message sent',
      message_received: 'Customer replied',
      message_delivered: 'Delivered',
      message_read: 'Read',
      email_sent: 'Email campaign sent',
      email_opened: 'Email opened',
      link_clicked: 'Link clicked',
      status_changed: 'Status updated',
      follow_up_scheduled: 'Follow-up scheduled',
      follow_up_sent: 'Follow-up sent',
      follow_up_cancelled: 'Follow-up cancelled',
      note: 'Note added',
      ai_action: 'AI action',
      call_made: 'Call made',
      call_completed: 'Call completed',
      quote_sent: 'Quotation sent',
      invoice_sent: 'Invoice sent',
      quote_accepted: 'Quotation accepted',
      invoice_paid: 'Invoice paid',
      quote_viewed: 'Quotation viewed',
      invoice_from_quote: 'Converted to Invoice',
    };
    return map[type] || type.replace(/_/g, ' ');
  };

  const eventColor = (type: string) => {
    if (type === 'message_received') return '#fbbf24';
    if (type === 'email_opened') return '#22d3ee';
    if (type === 'follow_up_sent') return '#a78bfa';
    if (type === 'status_changed') return '#34d399';
    if (type === 'quote_sent' || type === 'invoice_sent') return '#38bdf8';
    if (type === 'quote_accepted' || type === 'invoice_from_quote') return '#34d399';
    if (type === 'invoice_paid') return '#a3e635';
    if (type === 'deal' || type === 'quote_accepted' || type === 'invoice_paid') return '#22c55e';
    if (type === 'lost') return '#f43f5e';
    return '#94a3b8';
  };

  return (
    <div className="lf-thread">
      <div className="lf-thread-main">
        <div className="lf-thread-head">
          <span className="lf-thread-head-avatar">{getInitials(conversation.lead?.name)}</span>
          <div className="lf-thread-head-info">
            <div className="lf-thread-head-name">{conversation.lead?.name || conversation.leadId}</div>
            <div className="lf-thread-head-sub">
              {CHANNEL_ICON[conversation.channel] || ''} {conversation.channel} · {getCampaignName(conversation)}
            </div>
            {isEmail && conversation.subject && (
              <div className="lf-thread-head-sub" style={{ fontStyle: 'italic', opacity: 0.8 }}>
                Re: {conversation.subject}
              </div>
            )}
          </div>
          {/* Thread-level actions */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
            {supportsAiAutoReply && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--lf-text-secondary)', cursor: 'pointer', marginRight: 4 }}>
                  <input
                    type="checkbox"
                    checked={autoReplyEnabled && !humanTakeover}
                    disabled={aiSettingsBusy || humanTakeover}
                    onChange={(e) => handleToggleAutoReply(e.target.checked)}
                    style={{ accentColor: '#6366f1' }}
                  />
                  Auto Reply
                </label>
                {humanTakeover ? (
                  <button
                    className="lf-btn lf-btn-primary"
                    style={{ height: 28, padding: '0 10px', fontSize: 11 }}
                    disabled={aiSettingsBusy}
                    onClick={handleResumeAi}
                    title="Resume AI auto-replies for this conversation"
                  >
                    Resume AI
                  </button>
                ) : (
                  <button
                    className="lf-btn"
                    style={{ height: 28, padding: '0 10px', fontSize: 11, borderColor: 'rgba(251,191,36,0.45)', color: '#fbbf24' }}
                    disabled={aiSettingsBusy}
                    onClick={handleTakeOver}
                    title="Stop AI and take over this conversation"
                  >
                    Take Over
                  </button>
                )}
                <span
                  className="lf-pill"
                  style={{
                    fontSize: 10,
                    background: humanTakeover ? 'rgba(251,191,36,0.12)' : autoReplyEnabled ? 'rgba(99,102,241,0.12)' : 'rgba(148,163,184,0.12)',
                    color: humanTakeover ? '#fbbf24' : autoReplyEnabled ? '#a78bfa' : '#94a3b8',
                  }}
                >
                  {humanTakeover ? 'Human Active' : autoReplyEnabled ? 'AI Active' : 'AI Paused'}
                </span>
              </>
            )}
            <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 11 }} onClick={() => load()} title="Refresh">↻</button>
            {onOpenQuote && (
              <QuoteActionButtons
                conversationId={conversation.id}
                leadId={conversation.leadId}
                leadName={conversation.lead?.name}
                channel={conversation.channel}
                onOpen={onOpenQuote}
                compact
              />
            )}
            <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 11 }} disabled={manageBusy} onClick={handleArchiveConversation}>Archive</button>
            <button className="lf-btn lf-btn-danger" style={{ height: 28, padding: '0 10px', fontSize: 11 }} disabled={manageBusy} onClick={handleDeleteConversation}>Delete</button>
          </div>
        </div>

        {safeMessages.length > 0 && (
          <div className="lf-thread-manage-bar">
            <label className="lf-thread-manage-check">
              <input type="checkbox" checked={allMessagesSelected} onChange={toggleSelectAllMessages} />
              Select all
            </label>
            <span className="lf-thread-manage-count">
              {selectedMessageIds.size > 0 ? `${selectedMessageIds.size} selected` : `${safeMessages.length} messages`}
            </span>
            <div className="lf-thread-manage-actions">
              <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 11 }} disabled={manageBusy || selectedMessageIds.size === 0} onClick={handleDeleteSelectedMessages}>
                Delete selected
              </button>
            </div>
          </div>
        )}

        <div className="lf-thread-body" ref={bodyRef}>
          {threadItems.length === 0 && <div className="lf-muted" style={{ padding: 16, textAlign: 'center' }}>No messages yet.</div>}
          {groupedItems.map((group) => (
            <div key={group.date} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <DateSeparator date={group.date} />
              {group.items.map((item) => {
                if (item.kind === 'event') {
                  const e = item.data;
                  return (
                    <div key={e.id} style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 12, background: `${eventColor(e.type)}15`, border: `1px solid ${eventColor(e.type)}40`, color: eventColor(e.type), fontSize: 11, fontWeight: 600 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: eventColor(e.type), display: 'inline-block' }} />
                        {eventLabel(e.type, e.payload)}
                        {e.payload?.from && ` → ${e.payload.to}`}
                      </div>
                    </div>
                  );
                }
                const m = item.data;
                const threadContent = getThreadMessageContent(m);
                const quoteMeta = (m.metadata as any)?.quoteCard || m.messageType === 'quote'
                  ? (m.metadata as any)
                  : null;
                return (
                  <div
                    key={m.id}
                    className={`lf-wa-bubble-wrap lf-wa-bubble-wrap-${m.direction} lf-wa-bubble-wrap-selectable`}
                  >
                    <label className="lf-thread-msg-check" title="Select message">
                      <input
                        type="checkbox"
                        checked={selectedMessageIds.has(m.id)}
                        onChange={() => toggleMessageSelection(m.id)}
                      />
                    </label>
                    <div className={`lf-wa-bubble lf-wa-bubble-${m.direction}`}>
                      {(m.conversationChannel && m.conversationChannel !== conversation.channel) && (
                        <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 6, opacity: 0.75, textTransform: 'uppercase' }}>
                          {CHANNEL_ICON[m.conversationChannel]} {m.conversationChannel}
                        </div>
                      )}
                      {quoteMeta ? (
                        <div className="qi-thread-quote-card">
                          <div className="qi-thread-doc-head">
                            <span className={`qi-thread-doc-kind ${quoteMeta.docType === 'invoice' ? 'invoice' : 'quote'}`}>
                              {quoteMeta.docType === 'invoice' ? 'INVOICE' : 'QUOTATION'}
                            </span>
                            <span className={`qi-status ${quoteMeta.status || 'sent'}`}>{quoteMeta.status || 'sent'}</span>
                          </div>
                          <div className="qi-thread-quote-number">{quoteMeta.number || 'Document'}</div>
                          {extractShareToken(quoteMeta) && (
                            <a
                              className="qi-thread-doc-thumb"
                              href={salesDocumentPublicPdfUrl(extractShareToken(quoteMeta))}
                              target="_blank"
                              rel="noreferrer"
                              title={`Open ${quoteMeta.number || 'document'} PDF`}
                            >
                              <iframe
                                src={`${salesDocumentPublicPdfUrl(extractShareToken(quoteMeta))}#toolbar=0&navpanes=0&scrollbar=0&view=FitH&page=1`}
                                title={`${quoteMeta.docType === 'invoice' ? 'Invoice' : 'Quotation'} ${quoteMeta.number || ''} preview`}
                                className="qi-thread-doc-thumb-frame"
                                tabIndex={-1}
                                scrolling="no"
                              />
                              <span className="qi-thread-doc-thumb-hint">Click to open PDF</span>
                            </a>
                          )}
                          <div className="qi-thread-doc-summary">
                            {quoteMeta.customerName && <span className="qi-thread-quote-customer">To: {quoteMeta.customerName}</span>}
                            <span className="qi-thread-doc-grand-inline">
                              {quoteMeta.currency || 'MYR'}{' '}
                              {Number(quoteMeta.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          {quoteMeta.sendError && (
                            <div className="qi-thread-quote-error">{quoteMeta.sendError}</div>
                          )}
                          {onOpenQuote ? (
                            <ThreadDocumentActions
                              meta={quoteMeta}
                              conversationId={conversation.id}
                              channel={conversation.channel}
                              leadId={conversation.leadId}
                              leadName={conversation.lead?.name}
                              onOpenDrawer={onOpenQuote}
                              onRefresh={onRefreshThread}
                            />
                          ) : (
                            <div className="qi-thread-quote-actions">
                              {quoteMeta.shareUrl && (
                                <a className="lf-btn" href={quoteMeta.shareUrl} target="_blank" rel="noreferrer" style={{ height: 28, padding: '0 10px', fontSize: 11 }}>
                                  Open link
                                </a>
                              )}
                              {extractShareToken(quoteMeta) && (
                                <a className="lf-btn" href={salesDocumentPublicPdfUrl(extractShareToken(quoteMeta))} target="_blank" rel="noreferrer" style={{ height: 28, padding: '0 10px', fontSize: 11 }}>
                                  PDF
                                </a>
                              )}
                            </div>
                          )}
                        </div>
                      ) : m.messageType === 'email' ? (
                        <div className="lf-wa-bubble-body">
                          {(m.metadata as any)?.subject && (
                            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--lf-text-secondary)', borderBottom: '1px solid var(--lf-card-border)', paddingBottom: 6 }}>
                              Subject: {(m.metadata as any).subject}
                            </div>
                          )}
                          <MessageMediaPreview attachments={resolveMediaAttachments(m)} />
                          <MessageContent
                            content={threadContent.content}
                            format={threadContent.type}
                            className="lf-wa-bubble-body-inner"
                          />
                        </div>
                      ) : (
                        <div className="lf-wa-bubble-body">
                          <MessageMediaPreview attachments={resolveMediaAttachments(m)} />
                          {m.body && !/^\[(Image|Video|Document|Audio)/i.test(m.body) && (
                            <MessageContent content={m.body} format="text" className="lf-wa-bubble-body-inner" />
                          )}
                          {m.body && /^\[(Image|Video|Document|Audio)/i.test(m.body) && resolveMediaAttachments(m).length === 0 && (
                            <MessageContent content={m.body} format="text" className="lf-wa-bubble-body-inner" />
                          )}
                        </div>
                      )}
                      <div className="lf-wa-bubble-meta">
                        <span>{formatTime(m.createdAt)}</span>
                        {m.direction === 'outbound' && <MessageStatus status={m.status} />}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Free AI Messages Banner */}
        {freeAiMessages !== null && freeAiMessages === 0 && aiSource !== 'user' && (
          <div style={{ margin: '0 16px', padding: '12px 16px', borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#fca5a5', fontSize: 13 }}>
            <strong>Free AI messages exhausted.</strong>{' '}
            You have used your free AI messages.{' '}
            <Link to="/app/settings" style={{ color: '#38bdf8', textDecoration: 'underline' }}>Add your own OpenAI API Key</Link>{' '}
            to continue using the {isWhatsApp ? 'WhatsApp' : isSms ? 'SMS' : 'Email'} AI Brain.
          </div>
        )}

        {/* AI Reply Workflow Banner */}
        {/* Channel Brain Status Banner — always visible, shows conversation status */}
        <div style={{ margin: '0 16px 12px', padding: '8px 12px', borderRadius: 10, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
          background: conversation.status === 'ai_thinking' ? 'rgba(99,102,241,0.08)' :
                     conversation.status === 'ai_replied' ? 'rgba(52,211,153,0.08)' :
                     conversation.status === 'human_required' || humanTakeover ? 'rgba(251,191,36,0.08)' :
                     conversation.status === 'ai_failed' ? 'rgba(239,68,68,0.08)' :
                     conversation.status === 'waiting_for_customer' ? 'rgba(148,163,184,0.08)' :
                     (autoReplyEnabled && supportsAiAutoReply) ? 'rgba(99,102,241,0.06)' :
                     'rgba(148,163,184,0.06)',
          border: conversation.status === 'ai_thinking' ? '1px solid rgba(99,102,241,0.2)' :
                   conversation.status === 'ai_replied' ? '1px solid rgba(52,211,153,0.2)' :
                   conversation.status === 'human_required' || humanTakeover ? '1px solid rgba(251,191,36,0.25)' :
                   conversation.status === 'ai_failed' ? '1px solid rgba(239,68,68,0.2)' :
                   conversation.status === 'waiting_for_customer' ? '1px solid rgba(148,163,184,0.2)' :
                   '1px solid rgba(148,163,184,0.15)',
          color: conversation.status === 'ai_thinking' ? '#a78bfa' :
                 conversation.status === 'ai_replied' ? '#4ade80' :
                 conversation.status === 'human_required' || humanTakeover ? '#fbbf24' :
                 conversation.status === 'ai_failed' ? '#f87171' :
                 conversation.status === 'waiting_for_customer' ? '#94a3b8' :
                 '#94a3b8'
        }}>
          <span style={{ fontSize: 14 }}>
            {conversation.status === 'ai_thinking' && '🤔'}
            {conversation.status === 'ai_replied' && '✅'}
            {conversation.status === 'human_required' || humanTakeover ? '👤' : ''}
            {conversation.status === 'ai_failed' && '❌'}
            {conversation.status === 'waiting_for_customer' && '⏳'}
            {!['ai_thinking','ai_replied','human_required','ai_failed','waiting_for_customer'].includes(conversation.status) && (autoReplyEnabled ? '🤖' : '⚙️')}
          </span>
          <span style={{ fontWeight: 600, flex: 1 }}>
            {conversation.status === 'ai_thinking' && 'AI Thinking…'}
            {conversation.status === 'ai_replied' && 'AI Replied'}
            {conversation.status === 'human_required' && 'Human Required'}
            {conversation.status === 'ai_failed' && 'AI Failed'}
            {conversation.status === 'waiting_for_customer' && 'Waiting for Customer'}
            {!['ai_thinking','ai_replied','human_required','ai_failed','waiting_for_customer'].includes(conversation.status) && (
              autoReplyEnabled ? 'AI Auto-Reply Active' : 'AI Auto-Reply Disabled'
            )}
          </span>
          <Link to={isWhatsApp ? '/app/ai/whatsapp-brain' : isSms ? '/app/ai/sms-brain' : '/app/ai/email-brain'}
                style={{ color: '#38bdf8', textDecoration: 'underline', fontSize: 11, whiteSpace: 'nowrap' }}>
            {isWhatsApp ? '◉ WhatsApp Brain' : isSms ? '✆ SMS Brain' : '@ Email Brain'} →
          </Link>
        </div>

        {supportsAiAutoReply && aiState !== 'idle' && !humanTakeover && (
          <div style={{ margin: '0 16px 12px', padding: 12, borderRadius: 10, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {aiState === 'detected' && (autoReplyEnabled ? 'Auto-Replying…' : 'Incoming Reply Detected')}
                {aiState === 'analyzing' && 'AI Thinking…'}
                {aiState === 'ready' && 'AI Reply Ready'}
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--lf-text-secondary)', marginBottom: aiState === 'detected' ? 8 : 0 }}>
              {autoReplyEnabled
                ? `AI is enabled for ${isWhatsApp ? 'WhatsApp' : isSms ? 'SMS' : 'Email'}. New messages are auto-replied.`
                : `Autonomous ${isWhatsApp ? 'WhatsApp' : isSms ? 'SMS' : 'Email'} replies use the `}
              {!autoReplyEnabled && (
                <Link to={isWhatsApp ? '/app/ai/whatsapp-brain' : isSms ? '/app/ai/sms-brain' : '/app/ai/email-brain'} style={{ color: '#38bdf8', textDecoration: 'underline' }}>
                  {isWhatsApp ? 'WhatsApp Brain' : isSms ? 'SMS Brain' : 'Email Brain'}
                </Link>
              )}
              {!autoReplyEnabled && '. Toggle is in the brain settings.'}
            </div>

            {aiState === 'detected' && !autoReplyEnabled && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--lf-text-secondary)' }}>
                  The customer sent a reply. Generate a smart AI response?
                </div>
                <button
                  className="lf-btn lf-btn-primary"
                  style={{ height: 28, padding: '0 12px', fontSize: 11 }}
                  onClick={handleGenerateAiReply}
                  disabled={aiLoading}
                >
                  Generate AI Reply
                </button>
              </div>
            )}

            {aiState === 'detected' && autoReplyEnabled && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--lf-text-secondary)' }}>
                <span className="scraper-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                Auto-replying in progress…
              </div>
            )}

            {aiState === 'analyzing' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--lf-text-secondary)' }}>
                <span className="scraper-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                Analyzing conversation and crafting a reply…
              </div>
            )}

            {aiState === 'ready' && (
              <div>
                <div style={{ fontSize: 13, lineHeight: 1.5, background: 'rgba(15,23,42,0.5)', padding: 10, borderRadius: 8, border: '1px solid var(--lf-border)', marginBottom: 8 }}>
                  <MessageContent content={aiDraft} format="text" />
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="lf-btn lf-btn-primary" style={{ height: 28, padding: '0 12px', fontSize: 11 }} onClick={handleSendAiReply}>
                    {autoReplyEnabled ? 'Send' : 'Send AI Reply'}
                  </button>
                  <button className="lf-btn" style={{ height: 28, padding: '0 12px', fontSize: 11 }} onClick={handleEditAiReply}>
                    Edit
                  </button>
                  <button className="lf-btn" style={{ height: 28, padding: '0 12px', fontSize: 11 }} onClick={handleGenerateAiReply} disabled={aiLoading}>
                    Regenerate
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {supportsAiAutoReply && humanTakeover && (
          <div style={{ margin: '0 16px 12px', padding: '10px 12px', borderRadius: 10, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', fontSize: 12, color: '#fbbf24', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>Human takeover active — AI will not auto-reply on this thread.</span>
            <button className="lf-btn lf-btn-primary" style={{ height: 28, padding: '0 10px', fontSize: 11 }} disabled={aiSettingsBusy} onClick={handleResumeAi}>
              Resume AI
            </button>
          </div>
        )}

        {!autoReplyEnabled && (
        <div className="lf-thread-suggestions">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>AI Suggested Replies</div>
            {freeAiMessages !== null && aiSource !== 'user' && (
              <div style={{ fontSize: 11, color: freeAiMessages === 0 ? '#f87171' : '#94a3b8' }}>
                {freeAiMessages} / 100 free
              </div>
            )}
            {aiSource === 'user' && (
              <div style={{ fontSize: 11, color: '#4ade80' }}>Own key — unlimited</div>
            )}
          </div>
          {aiLoading ? (
            <div style={{ fontSize: 12, color: 'var(--lf-text-secondary)' }}>Generating suggestions…</div>
          ) : aiSuggestions.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {freeAiMessages === 0 && aiSource !== 'user'
                  ? 'No AI suggestions available. Add your API key to enable AI replies.'
                  : 'Click Generate to get AI-powered reply suggestions.'}
              </div>
              {!(freeAiMessages === 0 && aiSource !== 'user') && (
                <button
                  className="lf-btn lf-btn-primary"
                  style={{ height: 28, padding: '0 12px', fontSize: 11 }}
                  onClick={loadSuggestions}
                  disabled={aiLoading}
                >
                  Generate AI Reply
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {aiSuggestions.map((s, i) => (
                  <button key={i} className="lf-btn" style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'rgba(99, 102, 241, 0.1)', borderColor: 'rgba(99, 102, 241, 0.2)' }} onClick={() => setDraft(s)}>
                    {s.length > 45 ? s.slice(0, 45) + '…' : s}
                  </button>
                ))}
              </div>
              <button
                className="lf-btn"
                style={{ height: 24, padding: '0 10px', fontSize: 11, alignSelf: 'flex-start' }}
                onClick={loadSuggestions}
                disabled={aiLoading}
              >
                Regenerate
              </button>
            </div>
          )}
        </div>
        )}

        {/* Test AI Reply — Preview Conversation Simulation */}
        {isPreviewConversation(conversation) && (
          <div style={{ margin: '0 16px 12px', padding: 12, borderRadius: 10, background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
              🧪 Test AI Conversation
            </div>
            <div style={{ fontSize: 12, color: 'var(--lf-text-secondary)', marginBottom: 8 }}>
              Type a mock lead message to see how the AI Sales Agent replies.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="lf-input"
                style={{ flex: 1, fontSize: 13 }}
                placeholder="e.g. What is the price?"
                value={simulateBody}
                onChange={(e) => setSimulateBody(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSimulate(); } }}
              />
              <button
                className="lf-btn lf-btn-primary"
                style={{ height: 36, padding: '0 14px', fontSize: 12, whiteSpace: 'nowrap' }}
                onClick={handleSimulate}
                disabled={simulateLoading || !simulateBody.trim()}
              >
                {simulateLoading ? 'Generating…' : 'Test AI Reply'}
              </button>
            </div>
            {simulateError && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#f87171' }}>{simulateError}</div>
            )}
          </div>
        )}

        {error && <div className="lf-alert lf-alert-error" style={{ margin: '0 16px', borderRadius: 10 }}>{error}</div>}

        {/* Template selector — hidden for SMS */}
        {!isSms && (isEmail ? emailTemplates.length > 0 : waTemplates.length > 0) && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--lf-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 11 }} onClick={() => setShowTemplates((s) => !s)}>
              {showTemplates ? 'Hide Templates' : 'Templates'}
            </button>
            {selectedTemplate && (
              <span className="lf-pill" style={{ fontSize: 11 }}>
                {selectedTemplate}
              </span>
            )}
          </div>
        )}

        {showTemplates && !isSms && (isEmail ? emailTemplates.length > 0 : waTemplates.length > 0) && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--lf-border)', background: 'rgba(99,102,241,0.04)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{isEmail ? 'Saved Templates' : 'Approved Templates'}</div>
            <select
              className="scraper-input"
              style={{ width: '100%', fontSize: 13, marginBottom: 8 }}
              value={selectedTemplate}
              onChange={(e) => {
                const name = e.target.value;
                setSelectedTemplate(name);
                setTemplateVars({});
                if (isEmail) {
                  const tpl = emailTemplates.find((t) => t.name === name);
                  if (tpl) {
                    setSubject(tpl.subject);
                    setDraft(tpl.body);
                  }
                }
              }}
            >
              <option value="">Select a template…</option>
              {isEmail
                ? emailTemplates.map((t: EmailTemplate) => (
                    <option key={t.id} value={t.name}>{t.name}</option>
                  ))
                : waTemplates.map((t: WhatsAppTemplate) => (
                    <option key={t.name} value={t.name}>{t.name} ({t.status?.toLowerCase()})</option>
                  ))}
            </select>

            {!isEmail && selectedTemplate && (
              <>
                <div style={{ fontSize: 12, color: 'var(--lf-text-secondary)', marginBottom: 6 }}>
                  Variables: enter values for each placeholder.
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  {['name', 'city', 'niche'].map((varName) => (
                    <div key={varName} style={{ flex: '1 1 120px' }}>
                      <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--lf-text-secondary)', textTransform: 'uppercase' }}>{varName}</label>
                      <input
                        className="lf-input"
                        style={{ width: '100%', fontSize: 13, marginTop: 4 }}
                        placeholder={`{${varName}}`}
                        value={templateVars[varName] || ''}
                        onChange={(e) => setTemplateVars((prev) => ({ ...prev, [varName]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 12, background: 'rgba(15,23,42,0.6)', padding: 10, borderRadius: 8, border: '1px solid var(--lf-border)' }}>
                  <strong>Preview:</strong>
                  <MessageContent
                    content={draft.replace(/{name}/g, templateVars.name || '{name}')
                      .replace(/{city}/g, templateVars.city || '{city}')
                      .replace(/{niche}/g, templateVars.niche || '{niche}')}
                    format="text"
                  />
                </div>
              </>
            )}
          </div>
        )}

        {isEmail && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--lf-border)' }}>
            <input
              className="lf-input"
              style={{ width: '100%', fontSize: 13 }}
              placeholder="Subject…"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
        )}

        <div className="lf-thread-composer">
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
            {['👍', '🙂', '🙏', '✅', '📞'].map((emoji) => (
              <button key={emoji} type="button" className="lf-btn" style={{ height: 28, padding: '0 8px' }} onClick={() => setDraft((d) => d + emoji)}>
                {emoji}
              </button>
            ))}
            {(isEmail || conversation.channel === 'whatsapp') && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setUploadingImage(true);
                    try {
                      const dataUrl = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result || ''));
                        reader.onerror = () => reject(new Error('Could not read file'));
                        reader.readAsDataURL(file);
                      });
                      const uploaded = await uploadImage(dataUrl, file.name);
                      if (uploaded.url) {
                        let url = uploaded.url;
                        try {
                          url = new URL(uploaded.url).pathname;
                        } catch { /* keep absolute */ }
                        setReplyImageUrl(url);
                      }
                    } catch {
                      setError('Could not upload image');
                    } finally {
                      setUploadingImage(false);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }
                  }}
                />
                <button type="button" className="lf-btn" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={() => fileInputRef.current?.click()} disabled={uploadingImage}>
                  {uploadingImage ? 'Uploading…' : '📎 Image'}
                </button>
              </>
            )}
            {replyImageUrl && (
              <span className="lf-pill" style={{ fontSize: 11 }}>
                Image attached
                <button type="button" className="lf-btn" style={{ marginLeft: 6, height: 20, padding: '0 6px' }} onClick={() => setReplyImageUrl(null)}>×</button>
              </span>
            )}
          </div>
          <BidiTextArea
            className="lf-textarea lf-thread-compose-input"
            placeholder={selectedTemplate ? 'Compose template body with {name}, {city}, {niche}…' : isEmail ? 'Write your email…' : isSms ? 'Write your SMS…' : 'Write a reply…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isEmail) { e.preventDefault(); send(); } }}
            rows={isEmail ? 3 : 1}
          />
          <button className="lf-btn lf-btn-primary" onClick={() => send()} disabled={sending || !draft.trim()}>
            {sending ? 'Sending…' : isEmail ? 'Send Email' : isSms ? 'Send SMS' : selectedTemplate ? 'Send Template' : 'Send'}
          </button>
        </div>

        {/* SMS character / segment counter */}
        {isSms && (
          <div style={{ padding: '0 16px 8px', fontSize: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ color: draft.length > 160 ? '#f43f5e' : 'var(--lf-text-secondary)' }}>
              {draft.length} / 160 chars
            </span>
            <span style={{ color: draft.length > 160 ? '#f43f5e' : 'var(--lf-text-secondary)' }}>
              {Math.ceil(draft.length / 160)} segment{Math.ceil(draft.length / 160) !== 1 ? 's' : ''}
            </span>
            {draft.length > 160 && (
              <span style={{ color: '#f43f5e', fontWeight: 600 }}>
                ⚠️ Exceeds single SMS — may incur extra cost
              </span>
            )}
          </div>
        )}
      </div>

      <ContactPanel conversation={conversation} onStatusChange={onStatusChange} onOpenQuote={onOpenQuote} />
    </div>
  );
}

const HIDDEN_CAMPAIGNS_KEY = 'lf_hidden_campaigns';

function getHiddenCampaigns(): string[] {
  try { return JSON.parse(localStorage.getItem(HIDDEN_CAMPAIGNS_KEY) || '[]'); }
  catch { return []; }
}
function setHiddenCampaigns(list: string[]) {
  localStorage.setItem(HIDDEN_CAMPAIGNS_KEY, JSON.stringify(list));
}

export default function InboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeCampaign, setActiveCampaign] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'all' | 'contacts' | 'email' | 'whatsapp' | 'sms' | 'unread' | 'preview' | 'archived' | 'documents'>('all');
  const [search, setSearch] = useState('');
  const [hiddenCampaigns, setHiddenCampaignsState] = useState<string[]>(getHiddenCampaigns);
  const [showArchivedCampaigns, setShowArchivedCampaigns] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const inboxSessionActiveRef = useRef(false);
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkActionBusy, setBulkActionBusy] = useState(false);
  const [quoteDrawer, setQuoteDrawer] = useState<QuoteDrawerContext | null>(null);
  const [threadEpoch, setThreadEpoch] = useState(0);

  // Selection is scoped to the currently active tab/view — clear it when leaving Archived.
  useEffect(() => {
    setSelectedConvIds(new Set());
  }, [activeTab]);

  async function load() {
    try {
      setLoading(true);
      // Load conversations IMMEDIATELY from DB — never block on IMAP sync
      const res = await getConversations();
      const list = Array.isArray(res?.conversations) ? res.conversations : [];
      setConversations(list);
      setActiveId((prev) => prev || (list[0]?.id ?? null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversations');
    } finally {
      setLoading(false);
    }
  }

  async function refreshInbox() {
    setLoading(true);
    try {
      await load();
      setSyncing(true);
      const res = await syncEmail();
      if (res.processed > 0) {
        await load();
      }
    } catch {
      // Non-fatal — conversations still shown from DB
    } finally {
      setSyncing(false);
      setLoading(false);
    }
  }

  function activateInboxSession() {
    if (inboxSessionActiveRef.current) return;
    inboxSessionActiveRef.current = true;
    startInboxSession().catch(() => {
      inboxSessionActiveRef.current = false;
    });
  }

  function deactivateInboxSession() {
    if (!inboxSessionActiveRef.current) return;
    inboxSessionActiveRef.current = false;
    stopInboxSession().catch(() => {});
  }

  useEffect(() => {
    load();
    activateInboxSession();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        activateInboxSession();
      } else {
        deactivateInboxSession();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      deactivateInboxSession();
    };
  }, []);

  // Refresh conversation list from DB only (no Gmail API) while Inbox is open
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      getConversations().then((res) => {
        const incoming = Array.isArray(res?.conversations) ? res.conversations : [];
        setConversations((prev) => {
          const prevMap = new Map(prev.map((c) => [c.id, c]));
          const merged = incoming.map((c) => {
            const existing = prevMap.get(c.id);
            return existing ? { ...existing, ...c } : c;
          });
          const mergedMap = new Map(merged.map((c) => [c.id, c]));
          prevMap.forEach((c, id) => {
            if (!mergedMap.has(id)) merged.push(c);
          });
          return merged;
        });
      }).catch(() => {});
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Conversation action handlers
  const handleConvAction = async (conv: Conversation, action: string) => {
    try {
      if (action === 'read') {
        await markConversationRead(conv.id);
        setConversations((prev) => prev.map((c) => c.id === conv.id ? {
          ...c,
          unreadCount: 0,
          notificationStatus: c.notificationStatus?.type === 'new_reply' ? null : c.notificationStatus,
        } : c));
      } else if (action === 'unread') {
        await markConversationUnread(conv.id);
        setConversations((prev) => prev.map((c) => c.id === conv.id ? { ...c, unreadCount: 1 } : c));
      } else if (action === 'archive') {
        await archiveConversation(conv.id);
        setConversations((prev) => prev.map((c) => c.id === conv.id ? { ...c, archived: true } : c));
      } else if (action === 'unarchive') {
        await unarchiveConversation(conv.id);
        setConversations((prev) => prev.map((c) => c.id === conv.id ? { ...c, archived: false } : c));
      } else if (action === 'pin') {
        await pinConversation(conv.id);
        setConversations((prev) => prev.map((c) => c.id === conv.id ? { ...c, pinned: true } : c));
      } else if (action === 'unpin') {
        await unpinConversation(conv.id);
        setConversations((prev) => prev.map((c) => c.id === conv.id ? { ...c, pinned: false } : c));
      } else if (action === 'delete') {
        await deleteConversation(conv.id);
        setConversations((prev) => prev.filter((c) => c.id !== conv.id));
        if (activeId === conv.id) setActiveId(null);
      } else if (action === 'delete-permanent') {
        if (!window.confirm(`Permanently delete this conversation with ${conv.lead?.name || conv.leadId}? This cannot be undone.`)) return;
        await deleteConversation(conv.id);
        setConversations((prev) => prev.filter((c) => c.id !== conv.id));
        setSelectedConvIds((prev) => { const next = new Set(prev); next.delete(conv.id); return next; });
        if (activeId === conv.id) setActiveId(null);
      }
    } catch (err) {
      console.error('Action failed:', err);
    }
  };

  function toggleConvSelection(id: string) {
    setSelectedConvIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllArchived(archivedIds: string[]) {
    setSelectedConvIds((prev) => (
      archivedIds.length > 0 && archivedIds.every((id) => prev.has(id))
        ? new Set<string>()
        : new Set(archivedIds)
    ));
  }

  async function handleBulkRestore() {
    if (selectedConvIds.size === 0) return;
    const ids = Array.from(selectedConvIds);
    setBulkActionBusy(true);
    try {
      await bulkUnarchiveConversations(ids);
      setConversations((prev) => prev.map((c) => (ids.includes(c.id) ? { ...c, archived: false } : c)));
      setSelectedConvIds(new Set());
    } catch (err: any) {
      window.alert(err?.response?.data?.error || err?.message || 'Failed to restore conversations');
    } finally {
      setBulkActionBusy(false);
    }
  }

  async function handleBulkDeletePermanent() {
    if (selectedConvIds.size === 0) return;
    const ids = Array.from(selectedConvIds);
    setBulkActionBusy(true);
    try {
      await bulkDeleteConversations(ids);
      setConversations((prev) => prev.filter((c) => !ids.includes(c.id)));
      if (activeId && ids.includes(activeId)) setActiveId(null);
      setSelectedConvIds(new Set());
      setConfirmBulkDelete(false);
    } catch (err: any) {
      window.alert(err?.response?.data?.error || err?.message || 'Failed to delete conversations');
    } finally {
      setBulkActionBusy(false);
    }
  }

  // Derive conversations for the current tab (before campaign/search filters)
  const tabConversations = useMemo(() => {
    const source = Array.isArray(conversations) ? conversations : [];
    if (activeTab === 'preview') {
      return source.filter((c) => isPreviewConversation(c));
    }
    if (activeTab === 'archived') {
      return source.filter((c) => !isPreviewConversation(c) && c.archived);
    }

    let list = source.filter((c) => !isPreviewConversation(c) && !c.archived);
    if (activeTab === 'contacts') {
      list = list.filter((c) => isContactConversation(c));
    } else if (activeTab === 'unread') {
      list = list.filter((c) => (c.unreadCount || 0) > 0);
    } else if (activeTab === 'email' || activeTab === 'whatsapp' || activeTab === 'sms') {
      list = list.filter((c) => c.channel === activeTab);
    }

    if (activeTab === 'all' || activeTab === 'contacts' || activeTab === 'unread') {
      list = groupConversationsByLead(list);
    }

    list.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return String(b.lastMessageAt || b.createdAt).localeCompare(String(a.lastMessageAt || a.createdAt));
    });
    return list;
  }, [conversations, activeTab]);

  // Campaign counts are computed from the current tab only (not all conversations)
  const campaigns = useMemo(() => {
    const map = new Map<string, number>();
    map.set('all', tabConversations.length);
    tabConversations.forEach((c) => {
      const name = getCampaignName(c);
      map.set(name, (map.get(name) || 0) + 1);
    });
    return Array.from(map.entries()).filter(([name]) => name === 'all' || showArchivedCampaigns || !hiddenCampaigns.includes(name));
  }, [tabConversations, hiddenCampaigns, showArchivedCampaigns]);

  const archivedCampaigns = useMemo(() => {
    const map = new Map<string, number>();
    tabConversations.forEach((c) => {
      const name = getCampaignName(c);
      if (hiddenCampaigns.includes(name)) {
        map.set(name, (map.get(name) || 0) + 1);
      }
    });
    return Array.from(map.entries());
  }, [tabConversations, hiddenCampaigns]);

  const handleHideCampaign = (name: string) => {
    setConfirmDelete(name);
  };
  const confirmHide = () => {
    if (!confirmDelete) return;
    const next = [...hiddenCampaigns, confirmDelete];
    setHiddenCampaignsState(next);
    setHiddenCampaigns(next);
    if (activeCampaign === confirmDelete) setActiveCampaign('all');
    setConfirmDelete(null);
  };
  const handleRestoreCampaign = (name: string) => {
    const next = hiddenCampaigns.filter((n) => n !== name);
    setHiddenCampaignsState(next);
    setHiddenCampaigns(next);
  };

  // Final filtered list: tab → campaign → search
  const filtered = useMemo(() => {
    let list = tabConversations;
    if (activeCampaign !== 'all') {
      list = list.filter((c) => getCampaignName(c) === activeCampaign);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((c) =>
        (c.lead?.name || c.leadId).toLowerCase().includes(q) ||
        (c.lead?.email || '').toLowerCase().includes(q) ||
        (c.lead?.phone || '').toLowerCase().includes(q) ||
        (c.lastMessage?.body || '').toLowerCase().includes(q) ||
        (c.subject || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [tabConversations, activeCampaign, search]);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId]
  );

  const newReplyCount = useMemo(() => {
    return conversations.filter((c) =>
      !isPreviewConversation(c) &&
      !c.archived &&
      (c.unreadCount || 0) > 0 &&
      c.lastMessage?.direction === 'inbound'
    ).length;
  }, [conversations]);

  const campaignColors = ['#6366f1', '#22d3ee', '#fbbf24', '#f43f5e', '#10b981', '#c084fc'];

  return (
    <div className="lf-page lf-page-wide">
      <PageHeader
        title="Inbox"
        subtitle={newReplyCount > 0 ? `🔔 ${newReplyCount} new ${newReplyCount === 1 ? 'reply' : 'replies'}` : 'Conversations across all channels'}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {newReplyCount > 0 && (
              <span className="lf-inbox-header-notify" title={`${newReplyCount} new ${newReplyCount === 1 ? 'reply' : 'replies'}`}>
                🔔 {newReplyCount}
              </span>
            )}
            <button className="lf-btn" onClick={refreshInbox} disabled={loading || syncing}>
              {syncing ? 'Syncing…' : 'Sync Gmail'}
            </button>
            <button className="lf-btn" onClick={load} disabled={loading}>Reload</button>
          </div>
        }
      />

      {error && <div className="lf-alert lf-alert-error">{error}</div>}

      {loading && <div className="lf-card lf-skeleton" style={{ height: 360 }} />}

      {!loading && (
        <>
          {/* Inbox Toolbar: Channel Tabs + Search */}
          <div className="lf-card" style={{ marginBottom: 12, padding: '12px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {([
                  { key: 'all', label: 'All', icon: '◧' },
                  { key: 'contacts', label: 'Contacts', icon: '◎' },
                  { key: 'email', label: 'Email', icon: CHANNEL_ICON.email },
                  { key: 'whatsapp', label: 'WhatsApp', icon: CHANNEL_ICON.whatsapp },
                  { key: 'sms', label: 'SMS', icon: CHANNEL_ICON.sms },
                  { key: 'unread', label: 'Unread', icon: '●' },
                  { key: 'preview', label: 'Preview', icon: '👁' },
                  { key: 'archived', label: 'Archived', icon: '🗑' },
                  { key: 'documents', label: 'Documents', icon: '▤' },
                ] as const).map((tab) => {
                  const count =
                    tab.key === 'all'
                      ? conversations.filter((c) => !isPreviewConversation(c) && !c.archived).length
                      : tab.key === 'contacts'
                      ? conversations.filter((c) => !isPreviewConversation(c) && !c.archived && isContactConversation(c)).length
                      : tab.key === 'unread'
                      ? conversations.filter((c) => !isPreviewConversation(c) && !c.archived && (c.unreadCount || 0) > 0).length
                      : tab.key === 'preview'
                      ? conversations.filter((c) => isPreviewConversation(c)).length
                      : tab.key === 'archived'
                      ? conversations.filter((c) => !isPreviewConversation(c) && c.archived).length
                      : tab.key === 'documents'
                      ? null
                      : conversations.filter((c) => !isPreviewConversation(c) && !c.archived && c.channel === tab.key).length;
                  const isActive = activeTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      className={`lf-btn ${isActive ? 'lf-btn-primary' : ''}`}
                      style={{ height: 30, padding: '0 10px', fontSize: 12, fontWeight: isActive ? 700 : 500 }}
                      onClick={() => { setActiveTab(tab.key); setActiveCampaign('all'); }}
                    >
                      <span style={{ marginRight: 5, opacity: 0.8 }}>{tab.icon}</span>
                      {tab.label}
                      <span style={{ marginLeft: 5, fontSize: 10, opacity: 0.6 }}>{count}</span>
                    </button>
                  );
                })}
              </div>
              <div style={{ marginLeft: 'auto', minWidth: 200, flex: '1 1 200px' }}>
                <input
                  className="lf-input"
                  placeholder="Search conversations…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: '100%', height: 30, fontSize: 13 }}
                />
              </div>
            </div>
          </div>

          {/* Campaign Filter Bar */}
          <div className="lf-card" style={{ marginBottom: 12, padding: '10px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--lf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>Campaigns</div>
              {campaigns.map(([name, count], i) => (
                <div key={name} style={{ position: 'relative', display: 'inline-flex' }}>
                  <button
                    className={`lf-btn ${activeCampaign === name ? 'lf-btn-primary' : ''}`}
                    style={{ height: 26, padding: '0 10px', fontSize: 12 }}
                    onClick={() => setActiveCampaign(name)}
                  >
                    <span style={{
                      width: 6, height: 6, borderRadius: '50%', display: 'inline-block', marginRight: 5,
                      background: name === 'all' ? '#94a3b8' : campaignColors[i % campaignColors.length],
                    }} />
                    {name === 'all' ? 'All' : name}
                    <span style={{ marginLeft: 5, fontSize: 10, opacity: 0.6 }}>{count}</span>
                  </button>
                  {name !== 'all' && !hiddenCampaigns.includes(name) && (
                    <button
                      title="Archive campaign filter"
                      onClick={(e) => { e.stopPropagation(); handleHideCampaign(name); }}
                      style={{
                        position: 'absolute', top: -5, right: -5, width: 14, height: 14, borderRadius: '50%',
                        background: '#ef4444', color: '#fff', border: 'none', fontSize: 9, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  )}
                  {name !== 'all' && hiddenCampaigns.includes(name) && (
                    <button
                      title="Restore campaign filter"
                      onClick={(e) => { e.stopPropagation(); handleRestoreCampaign(name); }}
                      style={{
                        marginLeft: 4, height: 20, padding: '0 6px', fontSize: 10, borderRadius: 4,
                        border: '1px solid rgba(16,185,129,0.3)', background: 'rgba(16,185,129,0.1)', color: '#34d399', cursor: 'pointer',
                      }}
                    >
                      Restore
                    </button>
                  )}
                </div>
              ))}
              {archivedCampaigns.length > 0 && (
                <button
                  className="lf-link"
                  style={{ fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' }}
                  onClick={() => setShowArchivedCampaigns((s) => !s)}
                >
                  {showArchivedCampaigns ? 'Hide Archived' : `Archived (${archivedCampaigns.length})`}
                </button>
              )}
            </div>
          </div>

          {/* Archived Tab Toolbar — bulk Restore / Delete Permanently */}
          {activeTab === 'archived' && filtered.length > 0 && (
            <div className="lf-card" style={{ marginBottom: 12, padding: '10px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--lf-text-secondary)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && filtered.every((c) => selectedConvIds.has(c.id))}
                    onChange={() => toggleSelectAllArchived(filtered.map((c) => c.id))}
                  />
                  Select all
                </label>
                <span style={{ fontSize: 12, color: 'var(--lf-text-secondary)' }}>
                  {selectedConvIds.size > 0 ? `${selectedConvIds.size} selected` : `${filtered.length} archived`}
                </span>
                <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                  <button
                    className="lf-btn"
                    style={{ height: 30, padding: '0 12px', fontSize: 12 }}
                    disabled={selectedConvIds.size === 0 || bulkActionBusy}
                    onClick={handleBulkRestore}
                  >
                    ↩ Restore
                  </button>
                  <button
                    className="lf-btn lf-btn-danger"
                    style={{ height: 30, padding: '0 12px', fontSize: 12 }}
                    disabled={selectedConvIds.size === 0 || bulkActionBusy}
                    onClick={() => setConfirmBulkDelete(true)}
                  >
                    🗑 Delete Permanently
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bulk Delete Confirmation — rendered at root level so z-index is never clipped */}
          {confirmBulkDelete && (
            <div style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                background: 'linear-gradient(145deg, #0f172a, #1e293b)', border: '1px solid var(--lf-card-border)',
                borderRadius: 16, padding: 24, maxWidth: 420, width: '90%', boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Delete {selectedConvIds.size} conversation{selectedConvIds.size !== 1 ? 's' : ''} permanently?</div>
                <div style={{ fontSize: 13, color: 'var(--lf-text-secondary)', marginBottom: 16 }}>
                  This will permanently delete the selected conversation{selectedConvIds.size !== 1 ? 's' : ''} and all messages within. This action cannot be undone.
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="lf-btn" style={{ height: 36, padding: '0 16px', fontSize: 13 }} disabled={bulkActionBusy} onClick={() => setConfirmBulkDelete(false)}>Cancel</button>
                  <button className="lf-btn lf-btn-danger" style={{ height: 36, padding: '0 16px', fontSize: 13 }} disabled={bulkActionBusy} onClick={handleBulkDeletePermanent}>
                    {bulkActionBusy ? 'Deleting…' : 'Delete Permanently'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Confirmation Dialog — rendered at root level so z-index is never clipped */}
          {confirmDelete && (
            <div style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                background: 'linear-gradient(145deg, #0f172a, #1e293b)', border: '1px solid var(--lf-card-border)',
                borderRadius: 16, padding: 24, maxWidth: 400, width: '90%', boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Archive Campaign Filter?</div>
                <div style={{ fontSize: 13, color: 'var(--lf-text-secondary)', marginBottom: 16 }}>
                  This will hide the "<strong>{confirmDelete}</strong>" filter button from the inbox. The conversations will still be visible under "All Campaigns".
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="lf-btn" style={{ height: 36, padding: '0 16px', fontSize: 13 }} onClick={() => setConfirmDelete(null)}>Cancel</button>
                  <button className="lf-btn lf-btn-primary" style={{ height: 36, padding: '0 16px', fontSize: 13 }} onClick={confirmHide}>Archive</button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'documents' && (
            <DocumentHistoryPanel
              refreshEpoch={threadEpoch}
              onOpenDocument={(ctx) => setQuoteDrawer(ctx)}
            />
          )}

          {activeTab !== 'documents' && (
          <div className="lf-inbox">
            {/* Conversation List Panel */}
            <div className="lf-card" style={{ padding: 0, display: 'flex', flexDirection: 'column', gap: 0, height: '100%', overflow: 'hidden' }}>
              <div className="lf-conv-list" style={{ overflowY: 'auto', padding: 6 }}>
                {filtered.length === 0 ? (
                  <div className="lf-muted" style={{ textAlign: 'center', padding: 24 }}>
                    {conversations.length === 0 ? 'No conversations yet. Send a campaign to start.' : 'No conversations match.'}
                  </div>
                ) : (
                  filtered.map((c) => (
                    <ConversationRow
                      key={c.id}
                      conv={c}
                      active={c.id === activeId}
                      onClick={() => setActiveId(c.id)}
                      onAction={(action) => handleConvAction(c, action)}
                      selectable={activeTab === 'archived'}
                      selected={selectedConvIds.has(c.id)}
                      onToggleSelect={() => toggleConvSelection(c.id)}
                    />
                  ))
                )}
              </div>
            </div>

            {/* Thread Panel */}
            <div className="lf-card" style={{ padding: 0, overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}>
              {active ? (
                <Thread
                  key={`${active.id}-${threadEpoch}`}
                  conversation={active}
                  onOpenQuote={(ctx) => setQuoteDrawer(ctx)}
                  onRefreshThread={() => setThreadEpoch((n) => n + 1)}
                  onMarkRead={(conversationId) => {
                    setConversations((prev) => prev.map((c) => c.id === conversationId ? {
                      ...c,
                      unreadCount: 0,
                      notificationStatus: c.notificationStatus?.type === 'new_reply' ? null : c.notificationStatus,
                    } : c));
                  }}
                  onArchive={async (conversationId) => {
                    await archiveConversation(conversationId);
                    setConversations((prev) => prev.map((c) => c.id === conversationId ? { ...c, archived: true } : c));
                    setActiveId(null);
                  }}
                  onDeleteConversation={async (conversationId) => {
                    await deleteConversation(conversationId);
                    setConversations((prev) => prev.filter((c) => c.id !== conversationId));
                    setActiveId(null);
                  }}
                  onStatusChange={(leadId, status) => {
                    // Update only this conversation's pipelineStatus locally — no reload, no scroll jump
                    setConversations((prev) =>
                      prev.map((c) =>
                        c.leadId === leadId ? { ...c, pipelineStatus: status } : c
                      )
                    );
                  }}
                />
              ) : (
                <div style={{ padding: 16, flex: 1 }} className="lf-muted">Select a conversation.</div>
              )}
            </div>
          </div>
          )}
        </>
      )}

      <QuoteFromConversationDrawer
        open={Boolean(quoteDrawer)}
        context={quoteDrawer}
        onClose={() => setQuoteDrawer(null)}
        onRefresh={() => setThreadEpoch((n) => n + 1)}
        onComplete={() => {
          setQuoteDrawer(null);
          setThreadEpoch((n) => n + 1);
          void load();
        }}
      />
    </div>
  );
}
