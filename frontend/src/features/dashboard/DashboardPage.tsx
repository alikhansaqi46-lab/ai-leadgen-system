import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../common/PageHeader';
import {
  getDashboardMetrics,
  getOpenAiStatus,
  getWhatsAppStatus,
  getEmailStatus,
  getSmsStatus,
  DashboardCard,
  DashboardMetricsResponse,
} from '../../lib/apiClient';
import './dashboard.css';

type StatusTone = 'ok' | 'warn' | 'off';

interface SystemCard {
  key: string;
  title: string;
  href: string;
  accent: string;
  tone: StatusTone;
  statusLabel: string;
  detail: string;
}

const ROW_META: Array<{ id: string; title: string; group: string }> = [
  { id: 'primary', title: 'Business Overview', group: 'primary' },
  { id: 'outreach', title: 'Outreach Performance', group: 'outreach' },
  { id: 'sales', title: 'Sales Pipeline', group: 'sales' },
];

function formatValue(card: DashboardCard) {
  const v = Number(card.value) || 0;
  if (card.key === 'revenue') {
    return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  }
  if (card.key === 'conversionRate') return `${v}%`;
  return v.toLocaleString();
}

function clampQuota(remaining: number, total: number) {
  const t = Math.max(0, Number(total) || 0);
  const r = Math.max(0, Number(remaining) || 0);
  return Math.min(r, t || r);
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardMetricsResponse | null>(null);
  const [systemCards, setSystemCards] = useState<SystemCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        const [metrics, oa, wa, email, sms] = await Promise.all([
          getDashboardMetrics(),
          getOpenAiStatus().catch(() => null),
          getWhatsAppStatus().catch(() => null),
          getEmailStatus().catch(() => null),
          getSmsStatus().catch(() => null),
        ]);
        if (!active) return;
        setData(metrics);

        const total = Number(oa?.freeMessagesTotal) || 100;
        const remaining = clampQuota(Number(oa?.freeMessagesRemaining) || 0, total);
        const used = Math.max(0, total - remaining);
        const oaConnected = Boolean(oa?.masterConfigured || oa?.enabled);
        const oaUnlimited = Boolean((oa as { unlimited?: boolean } | null)?.unlimited);

        const nextSystem: SystemCard[] = [
          {
            key: 'openai',
            title: 'OpenAI Status',
            href: '/app/settings',
            accent: 'purple',
            tone: oaConnected ? 'ok' : 'off',
            statusLabel: oaConnected ? (oaUnlimited ? 'Own key · Unlimited' : 'Connected') : 'Not configured',
            detail: oaUnlimited
              ? 'Using your API key'
              : oaConnected
                ? `${remaining.toLocaleString()} / ${total.toLocaleString()} free messages left · ${used.toLocaleString()} used`
                : 'Connect a master or user OpenAI key in Settings',
          },
          {
            key: 'whatsapp',
            title: 'WhatsApp Status',
            href: '/app/whatsapp',
            accent: 'green',
            tone: wa?.configured ? 'ok' : 'off',
            statusLabel: wa?.configured ? 'Connected' : 'Disconnected',
            detail: wa?.configured
              ? `Provider ready${wa.provider ? ` · ${wa.provider}` : ''}`
              : 'Connect WhatsApp in the WhatsApp module',
          },
          {
            key: 'email',
            title: 'Email Status',
            href: '/app/email',
            accent: 'blue',
            tone: email?.configured || email?.sendable ? 'ok' : 'off',
            statusLabel: email?.configured || email?.sendable ? 'Connected' : 'Disconnected',
            detail: email?.account || email?.senderEmail || email?.provider
              ? String(email.account || email.senderEmail || email.provider)
              : 'Connect business email in Settings / Email',
          },
          {
            key: 'sms',
            title: 'SMS Status',
            href: '/app/sms',
            accent: 'orange',
            tone: sms?.configured || sms?.connected ? 'ok' : 'off',
            statusLabel: sms?.configured || sms?.connected ? 'Connected' : 'Disconnected',
            detail: sms?.phoneNumber || sms?.account
              ? String(sms.phoneNumber || sms.account)
              : 'Connect Twilio SMS in Settings',
          },
        ];
        setSystemCards(nextSystem);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, DashboardCard[]>();
    for (const card of data?.cards || []) {
      const g = card.group || 'primary';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(card);
    }
    return map;
  }, [data]);

  return (
    <div className="lf-page lf-dashboard">
      <PageHeader
        title="Executive Dashboard"
        subtitle="Live business KPIs from your database"
      />

      {loading && (
        <div className="lf-dash-rows">
          {[0, 1, 2].map((row) => (
            <div key={row} className="lf-dash-grid lf-dash-grid-6">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="lf-dash-card lf-dash-skeleton" />
              ))}
            </div>
          ))}
        </div>
      )}

      {error && <div className="lf-alert lf-alert-error">{error}</div>}

      {!loading && data && (
        <div className="lf-dash-rows">
          {ROW_META.map((row) => {
            const cards = grouped.get(row.group) || [];
            return (
              <section key={row.id} className="lf-dash-section">
                <div className="lf-dash-section-head">
                  <h2>{row.title}</h2>
                </div>
                <div className="lf-dash-grid lf-dash-grid-6">
                  {cards.map((card) => (
                    <button
                      key={card.key}
                      type="button"
                      className={`lf-dash-card accent-${card.accent || 'cyan'}`}
                      onClick={() => navigate(card.href)}
                    >
                      <div className="lf-dash-card-glow" />
                      <div className="lf-dash-card-value">{formatValue(card)}</div>
                      <div className="lf-dash-card-label">{card.label}</div>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}

          <section className="lf-dash-section">
            <div className="lf-dash-section-head">
              <h2>System Status</h2>
            </div>
            <div className="lf-dash-grid lf-dash-grid-4">
              {systemCards.map((card) => (
                <button
                  key={card.key}
                  type="button"
                  className={`lf-dash-card lf-dash-status-card accent-${card.accent}`}
                  onClick={() => navigate(card.href)}
                >
                  <div className="lf-dash-card-glow" />
                  <div className="lf-dash-status-top">
                    <span className="lf-dash-card-label">{card.title}</span>
                    <span className={`lf-dash-pill tone-${card.tone}`}>{card.statusLabel}</span>
                  </div>
                  <div className="lf-dash-status-detail">{card.detail}</div>
                </button>
              ))}
            </div>
          </section>

          <p className="lf-dash-updated">
            Updated {new Date(data.generatedAt).toLocaleString()}
          </p>
        </div>
      )}
    </div>
  );
}
