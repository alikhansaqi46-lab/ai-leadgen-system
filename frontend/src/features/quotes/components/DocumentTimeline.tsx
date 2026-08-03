const EVENT_LABELS: Record<string, string> = {
  created: 'Draft created',
  updated: 'Document updated',
  sent: 'Sent to customer',
  delivered: 'Delivered',
  viewed: 'Viewed by customer',
  viewed_via_share: 'Viewed via share link',
  status_draft: 'Status: Draft',
  status_sent: 'Status: Sent',
  status_viewed: 'Status: Viewed',
  status_accepted: 'Status: Approved / Accepted',
  status_rejected: 'Status: Rejected',
  status_converted: 'Status: Converted',
  status_paid: 'Status: Paid',
  status_partially_paid: 'Status: Partially paid',
  converted_to_invoice: 'Converted to Invoice',
  created_from_quote: 'Invoice created from Quote',
  duplicated: 'Document duplicated',
  share_link_created: 'Share link created',
  pdf_exported: 'PDF generated',
  payment_recorded: 'Payment recorded',
  follow_up_scheduled: 'Follow-up scheduled',
  follow_up_sent: 'Follow-up sent',
  follow_up_failed: 'Follow-up failed',
  ai_regenerated: 'AI regenerated document',
  customer_linked: 'Customer linked',
};

function labelFor(eventType: string, payload?: Record<string, unknown>) {
  if (EVENT_LABELS[eventType]) return EVENT_LABELS[eventType];
  if (eventType.startsWith('status_')) {
    const to = String(eventType.replace('status_', ''));
    return `Status changed to ${to}`;
  }
  if (payload?.from && payload?.to) return `Status: ${payload.from} → ${payload.to}`;
  return eventType.replace(/_/g, ' ');
}

export default function DocumentTimeline({
  events,
  status,
}: {
  events: Array<{ id?: string; eventType: string; channel?: string | null; createdAt?: string; payload?: Record<string, unknown> }>;
  status?: string;
}) {
  const sorted = [...(events || [])].sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
  );

  return (
    <section className="qi-timeline">
      <div className="qi-timeline-head">
        <h4>Delivery tracking</h4>
        {status && <span className={`qi-status ${status}`}>{status}</span>}
      </div>
      {sorted.length === 0 ? (
        <p className="lf-muted">No activity yet. Save and share to start tracking.</p>
      ) : (
        <ol className="qi-timeline-list">
          {sorted.map((ev, i) => (
            <li key={ev.id || `${ev.eventType}-${i}`} className="qi-timeline-item">
              <div className="qi-timeline-dot" />
              <div className="qi-timeline-body">
                <strong>{labelFor(ev.eventType, ev.payload)}</strong>
                <span className="qi-timeline-meta">
                  {ev.channel ? `${ev.channel} · ` : ''}
                  {ev.createdAt ? new Date(ev.createdAt).toLocaleString() : ''}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
