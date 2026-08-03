import { useEffect, useState } from 'react';
import PageHeader from '../common/PageHeader';
import { getPerformanceReport, PerformanceReport } from '../../lib/apiClient';

export default function ReportsPage() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getPerformanceReport(days)
      .then((res) => {
        if (active) setReport(res.report);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load report');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [days]);

  const s = report?.summary;
  const ch = report?.channels;
  const pipe = report?.pipeline;

  return (
    <div className="lf-page">
      <PageHeader
        title="Reports"
        subtitle="Campaign and channel performance from your live database — no estimates"
        actions={
          <select className="lf-input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        }
      />

      {loading && <div className="lf-card lf-skeleton" style={{ height: 240 }} />}
      {error && <div className="lf-alert lf-alert-error">{error}</div>}

      {!loading && !error && report && (
        <>
          <div className="lf-kpi-grid">
            <div className="lf-card-premium"><div className="lf-card-accent" /><div className="lf-kpi-value-premium">{s?.totalLeads ?? 0}</div><div className="lf-kpi-label-premium">Total Leads</div></div>
            <div className="lf-card-premium lf-card-emerald"><div className="lf-card-accent" /><div className="lf-kpi-value-premium">{s?.hot ?? 0}</div><div className="lf-kpi-label-premium">Hot</div></div>
            <div className="lf-card-premium lf-card-gold"><div className="lf-card-accent" /><div className="lf-kpi-value-premium">{s?.dealsWon ?? 0}</div><div className="lf-kpi-label-premium">Deals Won</div></div>
            <div className="lf-card-premium lf-card-cyan"><div className="lf-card-accent" /><div className="lf-kpi-value-premium">{s?.conversionRate ?? 0}%</div><div className="lf-kpi-label-premium">Conversion</div></div>
            <div className="lf-card-premium lf-card-purple"><div className="lf-card-accent" /><div className="lf-kpi-value-premium">{s?.replyRate ?? 0}%</div><div className="lf-kpi-label-premium">Reply Rate</div></div>
            <div className="lf-card-premium"><div className="lf-card-accent" /><div className="lf-kpi-value-premium">{s?.revenue ?? 0}</div><div className="lf-kpi-label-premium">Revenue</div></div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
            <div className="lf-card-premium" style={{ padding: 18 }}>
              <div className="lf-card-accent" />
              <h3 style={{ marginTop: 0 }}>Pipeline</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
                {pipe && Object.entries(pipe).map(([k, v]) => (
                  <li key={k}><strong>{k}:</strong> {Number(v).toLocaleString()}</li>
                ))}
              </ul>
            </div>
            <div className="lf-card-premium" style={{ padding: 18 }}>
              <div className="lf-card-accent" />
              <h3 style={{ marginTop: 0 }}>Activity ({report.range.days}d)</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
                <li>Messages sent: {report.activityInRange.messagesSent}</li>
                <li>Replies: {report.activityInRange.replies}</li>
                <li>Email opens: {report.activityInRange.emailOpens}</li>
                <li>Email clicks: {report.activityInRange.emailClicks}</li>
                <li>Email bounces: {report.activityInRange.emailBounces}</li>
                <li>WA delivered: {report.activityInRange.waDelivered}</li>
                <li>WA read: {report.activityInRange.waRead}</li>
              </ul>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 16 }}>
            {(['email', 'whatsapp', 'sms'] as const).map((key) => {
              const c = ch?.[key] as Record<string, number> | undefined;
              if (!c) return null;
              return (
                <div key={key} className="lf-card-premium" style={{ padding: 18 }}>
                  <div className="lf-card-accent" />
                  <h3 style={{ marginTop: 0, textTransform: 'capitalize' }}>{key}</h3>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
                    {Object.entries(c).map(([k, v]) => (
                      <li key={k}><strong>{k}:</strong> {typeof v === 'number' ? v : String(v)}</li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          <div className="lf-card-premium" style={{ padding: 18, marginTop: 16 }}>
            <div className="lf-card-accent" />
            <h3 style={{ marginTop: 0 }}>Automations</h3>
            <div style={{ fontSize: 13 }}>
              Enabled: {report.automations.enabled} · Succeeded: {report.automations.runsSucceeded} · Failed: {report.automations.runsFailed}
            </div>
            <div style={{ fontSize: 12, color: 'var(--lf-text-secondary)', marginTop: 8 }}>
              Generated {new Date(report.generatedAt).toLocaleString()} · range {report.range.from.slice(0, 10)} → {report.range.to.slice(0, 10)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

