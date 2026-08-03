import type { ReactNode } from 'react';
import { AreaChart, BarChart, DonutChart } from './saCharts';

type Kpi = {
  value?: number;
  label?: string;
  source?: string;
  unit?: string;
  growthPct?: number | null;
  trend?: string;
  funnel?: { stages?: { label: string; value: number }[] };
  breakdown?: Record<string, number>;
};

type ExecutivePayload = {
  generatedAt?: string;
  kpis?: Record<string, Kpi>;
  charts?: {
    revenue30d?: { label: string; value: number }[];
    funnel?: { label: string; value: number }[];
    campaignMix?: { label: string; value: number; color: string }[];
    customerMix?: { label: string; value: number; color: string }[];
  };
};

function money(n: number) {
  return `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatValue(kpi: Kpi | undefined, moneyLike = false) {
  if (!kpi) return '—';
  const v = Number(kpi.value) || 0;
  if (kpi.unit === '%') return `${v}%`;
  if (kpi.unit === '/100') return `${v}`;
  if (moneyLike) return money(v);
  return v.toLocaleString();
}

function growthLabel(kpi: Kpi | undefined) {
  if (!kpi) return undefined;
  if (kpi.trend) return kpi.trend;
  if (kpi.growthPct == null) return kpi.source ? 'Live' : undefined;
  const g = Number(kpi.growthPct) || 0;
  const sign = g > 0 ? '+' : '';
  return `${sign}${g}% MoM`;
}

function ExecKpi({
  icon, kpi, tone = 'blue', moneyLike = false,
}: {
  icon: string; kpi?: Kpi; tone?: string; moneyLike?: boolean;
}) {
  const trend = growthLabel(kpi);
  const up = trend ? !/down|churn|fail|−|-/i.test(String(trend)) || /\+/.test(String(trend)) : true;
  return (
    <div className={`sa-card sa-kpi-card tone-${tone}`} title={kpi?.source || ''}>
      <div className="sa-kpi-top">
        <div className="sa-kpi-icon">{icon}</div>
        {trend ? (
          <span className={`sa-trend ${up ? 'up' : 'down'}`}>{trend}</span>
        ) : null}
      </div>
      <div className="sa-kpi">{formatValue(kpi, moneyLike)}</div>
      <div className="sa-kpi-label">{kpi?.label || '—'}</div>
    </div>
  );
}

function Panel({
  icon, title, desc, children, className = '',
}: {
  icon?: string; title: string; desc?: string; children: ReactNode; className?: string;
}) {
  return (
    <div className={`sa-card panel ${className}`}>
      <div className="sa-section-head">
        <div>
          <h3 className="sa-section-title">{icon ? <span className="sa-ico">{icon}</span> : null}{title}</h3>
          {desc ? <p className="sa-section-desc">{desc}</p> : null}
        </div>
      </div>
      {children}
    </div>
  );
}

export default function ExecutiveOverviewPanel({
  executive,
  onOpenIntelligence,
}: {
  executive: ExecutivePayload | null | undefined;
  onOpenIntelligence?: () => void;
}) {
  if (!executive?.kpis) {
    return (
      <Panel icon="▣" title="Executive Overview" desc="Loading live platform KPIs…">
        <div className="sa-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="sa-skeleton" />)}</div>
      </Panel>
    );
  }

  const k = executive.kpis;
  const charts = executive.charts || {};
  const health = Number(k.overallAiHealthScore?.value) || 0;
  const healthTone = health >= 80 ? 'green' : health >= 55 ? 'orange' : 'red';

  return (
    <div className="sa-exec-overview" id="sa-executive-overview">
      <Panel
        icon="▣"
        title="Executive Overview"
        desc={`All 20 owner KPIs from live ledger, CRM, messaging and AI intelligence · ${executive.generatedAt ? new Date(executive.generatedAt).toLocaleString() : 'live'}`}
        className="glow"
      >
        <div className="sa-exec-section-label">Revenue</div>
        <div className="sa-grid sa-exec-grid">
          <ExecKpi icon="$" kpi={k.revenueToday} tone="cyan" moneyLike />
          <ExecKpi icon="$" kpi={k.revenueMonth} tone="green" moneyLike />
          <ExecKpi icon="$" kpi={k.revenueYear} tone="blue" moneyLike />
          <ExecKpi icon="↻" kpi={k.mrr} tone="violet" moneyLike />
          <ExecKpi icon="▲" kpi={k.arr} tone="indigo" moneyLike />
        </div>

        <div className="sa-exec-section-label">Customers</div>
        <div className="sa-grid sa-exec-grid">
          <ExecKpi icon="◆" kpi={k.activeCustomers} tone="green" />
          <ExecKpi icon="◎" kpi={k.totalCustomers} tone="blue" />
          <ExecKpi icon="＋" kpi={k.newCustomersToday} tone="cyan" />
          <ExecKpi icon="↘" kpi={k.churnRate} tone="red" />
          <ExecKpi icon="↗" kpi={k.retentionRate} tone="green" />
        </div>

        <div className="sa-exec-section-label">AI · Campaigns · Pipeline</div>
        <div className="sa-grid sa-exec-grid">
          <ExecKpi icon="✦" kpi={k.totalAiWins} tone="violet" />
          <ExecKpi icon="▷" kpi={k.runningCampaigns} tone="cyan" />
          <ExecKpi icon="✓" kpi={k.completedCampaigns} tone="green" />
          <ExecKpi icon="✕" kpi={k.failedCampaigns} tone="red" />
          <ExecKpi icon="✉" kpi={k.aiMessagesSent} tone="indigo" />
          <ExecKpi icon="↩" kpi={k.totalReplies} tone="blue" />
          <ExecKpi icon="▣" kpi={k.meetingsBooked} tone="orange" />
          <ExecKpi icon="◆" kpi={k.dealsClosed} tone="green" />
          <ExecKpi icon="%" kpi={k.conversionFunnel} tone="cyan" />
          <div className={`sa-card sa-kpi-card tone-${healthTone}`} title={k.overallAiHealthScore?.source || ''}>
            <div className="sa-kpi-top">
              <div className="sa-kpi-icon">⬡</div>
              <span className="sa-trend up">/100</span>
            </div>
            <div className="sa-kpi" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="sa-score-ring sa-score-ring-sm" style={{ ['--score' as any]: `${health}%` }}>
                <span>{health}</span>
              </div>
              <span>{health >= 80 ? 'Healthy' : health >= 55 ? 'Watch' : 'Critical'}</span>
            </div>
            <div className="sa-kpi-label">{k.overallAiHealthScore?.label || 'Overall AI Health Score'}</div>
          </div>
        </div>

        <div className="sa-split sa-split-wide" style={{ marginTop: 16 }}>
          <Panel icon="◈" title="Revenue trend (30 days)" desc="Completed payment ledger events by day.">
            <AreaChart points={charts.revenue30d || []} color="#38bdf8" height={180} />
          </Panel>
          <Panel icon="◎" title="Customer mix" desc="Active · trial · cancelled · free accounts.">
            <DonutChart
              segments={charts.customerMix || []}
              centerLabel="Accounts"
              centerValue={(charts.customerMix || []).reduce((s, x) => s + (Number(x.value) || 0), 0)}
            />
          </Panel>
        </div>

        <div className="sa-split sa-split-wide" style={{ marginTop: 12 }}>
          <Panel icon="☰" title="Conversion Funnel" desc="Scraped → Qualified → Meetings → Deals (platform CRM).">
            <BarChart
              points={(charts.funnel || []).map((s) => ({ label: s.label, value: s.value }))}
              color="#34d399"
              height={180}
            />
            <div className="sa-exec-funnel-labels">
              {(charts.funnel || []).map((s) => (
                <span key={s.label} className="sa-muted">{s.label}: {Number(s.value).toLocaleString()}</span>
              ))}
            </div>
          </Panel>
          <Panel icon="▷" title="Campaign status mix" desc="Running / completed / failed from CRM pipeline.">
            <DonutChart
              segments={charts.campaignMix || []}
              centerLabel="Campaigns"
              centerValue={(charts.campaignMix || []).reduce((s, x) => s + (Number(x.value) || 0), 0)}
            />
            {onOpenIntelligence ? (
              <div className="sa-actions" style={{ marginTop: 10 }}>
                <button className="sa-btn primary" type="button" onClick={onOpenIntelligence}>
                  Open AI Intelligence
                </button>
              </div>
            ) : null}
          </Panel>
        </div>
      </Panel>
    </div>
  );
}
