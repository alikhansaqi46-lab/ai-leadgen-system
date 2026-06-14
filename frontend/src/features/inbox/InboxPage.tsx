import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../common/PageHeader';
import {
  getConversations,
  getMessages,
  sendMessage,
  Conversation,
  Message,
} from '../../lib/apiClient';

const CHANNEL_ICON: Record<string, string> = { email: '@', whatsapp: '◉' };

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

function ConversationRow({
  conv,
  active,
  onClick,
}: {
  conv: Conversation;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`lf-conv-row${active ? ' lf-conv-row-active' : ''}`} onClick={onClick}>
      <div className="lf-conv-row-top">
        <span className="lf-conv-name">{conv.lead?.name || conv.leadId}</span>
        <span className="lf-conv-time">{timeAgo(conv.lastMessageAt)}</span>
      </div>
      <div className="lf-conv-preview">
        <span className="lf-conv-channel">{CHANNEL_ICON[conv.channel] || '•'}</span>
        {conv.lastMessage ? conv.lastMessage.body : 'No messages yet'}
      </div>
    </button>
  );
}

function Thread({ conversation }: { conversation: Conversation }) {
  const conversationId = conversation.id;
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      const res = await getMessages(conversationId);
      setMessages(res.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load thread');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  async function send() {
    if (!draft.trim()) return;
    try {
      setSending(true);
      const msg = await sendMessage(conversationId, draft.trim());
      setMessages((prev) => [...prev, msg]);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add message');
    } finally {
      setSending(false);
    }
  }

  if (loading) return <div className="lf-card lf-skeleton" style={{ height: 320, margin: 16 }} />;

  return (
    <div className="lf-thread">
      <div className="lf-thread-head">
        <div>
          <strong>{conversation.lead?.name || conversation.leadId}</strong>
          <span className="lf-muted" style={{ marginLeft: 8, fontSize: 13 }}>
            {CHANNEL_ICON[conversation.channel] || ''} {conversation.channel}
          </span>
        </div>
      </div>

      <div className="lf-thread-body">
        {messages.length === 0 && <div className="lf-muted" style={{ padding: 16 }}>No messages yet.</div>}
        {messages.map((m) => (
          <div key={m.id} className={`lf-msg lf-msg-${m.direction}`}>
            <pre className="lf-msg-body">{m.body}</pre>
            <div className="lf-msg-meta">
              {m.source === 'ai_draft' ? 'AI · approved' : m.direction} · {timeAgo(m.createdAt)}
            </div>
          </div>
        ))}
      </div>

      {error && <div className="lf-alert lf-alert-error" style={{ margin: '0 16px' }}>{error}</div>}

      <div className="lf-thread-composer">
        <input
          className="lf-input"
          style={{ flex: 1 }}
          placeholder="Write a reply (recorded — sending stays manual in V1)…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button className="lf-btn lf-btn-primary" onClick={send} disabled={sending || !draft.trim()}>
          {sending ? 'Adding…' : 'Add'}
        </button>
      </div>
    </div>
  );
}

export default function InboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      const res = await getConversations();
      setConversations(res.conversations);
      setActiveId((prev) => prev || (res.conversations[0]?.id ?? null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversations');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId]
  );

  return (
    <div className="lf-page">
      <PageHeader
        title="Inbox"
        subtitle="Two-way conversations with your leads"
        actions={<button className="lf-btn" onClick={load} disabled={loading}>Refresh</button>}
      />

      <div className="lf-note">
        Conversations start when you approve an AI draft and move it to the Inbox from the{' '}
        <Link className="lf-link" to="/app/ai-agent">AI Agent</Link>. Replies are recorded here —
        actual sending and inbound sync stay manual in V1.
      </div>

      {error && <div className="lf-alert lf-alert-error">{error}</div>}

      {loading && <div className="lf-card lf-skeleton" style={{ height: 360 }} />}

      {!loading && conversations.length === 0 && (
        <div className="lf-empty">
          <span className="lf-empty-badge">No conversations yet</span>
          <p className="lf-empty-text">
            Approve an outreach draft in the AI Agent and click “Move to Inbox” to start a thread.
          </p>
          <Link className="lf-btn lf-btn-primary" to="/app/ai-agent">Go to AI Agent</Link>
        </div>
      )}

      {!loading && conversations.length > 0 && (
        <div className="lf-inbox">
          <div className="lf-card lf-conv-list">
            {conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === activeId}
                onClick={() => setActiveId(c.id)}
              />
            ))}
          </div>
          <div className="lf-card" style={{ padding: 0, overflow: 'hidden' }}>
            {active ? <Thread key={active.id} conversation={active} /> : <div style={{ padding: 16 }} className="lf-muted">Select a conversation.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
