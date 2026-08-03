import {
  useCallback, useEffect, useMemo, useState,
  type ReactNode, type RefObject,
} from 'react';
import { Link } from 'react-router-dom';
import Logo from '../../components/Logo';
import { useAuth } from '../auth/AuthContext';
import {
  ackAdminNotification,
  activateAdminUser,
  clearAdminCache,
  createAdminBackup,
  deleteAdminUser,
  extendAdminUser,
  getAdminActivity,
  getAdminAudit,
  getAdminAuthEvents,
  getAdminErrors,
  getAdminExpiry,
  getAdminNotifications,
  getAdminOverview,
  getAdminPayments,
  getAdminSettings,
  getAdminUsers,
  listAdminBackups,
  refreshAdminNotifications,
  resetAdminAiQuota,
  resetAdminPassword,
  restartAdminQueue,
  restoreAdminBackup,
  setAdminMaintenance,
  setAdminSecurity,
  suspendAdminUser,
  upsertAdminExpiry,
  getAdminOpenAiUsage,
  scanAdminIntelligence,
  cleanupNonOwnerUsers,
  createAdminTestError,
  deleteAdminExpiry,
} from '../../lib/adminApi';
import { AreaChart, BarChart, DonutChart, SparkTrend } from './saCharts';
import OwnerIntelligencePanel from './OwnerIntelligencePanel';
import ExecutiveOverviewPanel from './ExecutiveOverviewPanel';
import './superAdmin.css';

type TabId =
  | 'overview'
  | 'revenue'
  | 'subscribers'
  | 'health'
  | 'expiry'
  | 'notifications'
  | 'activity'
  | 'ai'
  | 'intelligence'
  | 'channels'
  | 'leads'
  | 'errors'
  | 'audit'
  | 'ops'
  | 'security';

const NAV: { id: TabId; label: string; icon: string; group: string; title: string; desc: string }[] = [
  { id: 'overview', label: 'Admin Dashboard', icon: '▣', group: 'Command', title: 'Admin Dashboard', desc: 'Real-time business insights, platform health and owner analytics.' },
  { id: 'intelligence', label: 'AI Intelligence', icon: '✦', group: 'Command', title: 'Owner AI Success Intelligence', desc: 'Automatically detected customer wins, campaign library and pattern learning.' },
  { id: 'revenue', label: 'Revenue', icon: '◈', group: 'Growth', title: 'Revenue Analytics', desc: 'MRR, ARR, renewals and payment performance across the platform.' },
  { id: 'subscribers', label: 'Subscribers', icon: '◎', group: 'Growth', title: 'Subscriber Management', desc: 'Search, filter and operate on every customer account.' },
  { id: 'leads', label: 'Lead Analytics', icon: '◇', group: 'Growth', title: 'Lead Analytics', desc: 'Scraped volume, qualification and conversion performance.' },
  { id: 'channels', label: 'Messaging', icon: '◉', group: 'Channels', title: 'WhatsApp & Email', desc: 'Delivery, replies, opens and campaign health.' },
  { id: 'ai', label: 'AI Usage', icon: '✦', group: 'Channels', title: 'OpenAI Owner Usage', desc: 'Live OpenAI balance (when available), tokens, cost and top AI users.' },
  { id: 'health', label: 'System Health', icon: '⬡', group: 'Ops', title: 'Operations Center', desc: 'Live status, latency and uptime across critical services.' },
  { id: 'expiry', label: 'Expiry Center', icon: '◷', group: 'Ops', title: 'Expiry Center', desc: 'API keys, hosting, SSL and subscription renewals with warnings.' },
  { id: 'notifications', label: 'Notifications', icon: '◈', group: 'Ops', title: 'Notification Center', desc: 'Billing, security, success, system and renewal alerts for the owner.' },
  { id: 'activity', label: 'User Activity', icon: '⌁', group: 'Ops', title: 'User Activity', desc: 'Live online users, login history, devices and failed attempts.' },
  { id: 'errors', label: 'Error Logs', icon: '!', group: 'Security', title: 'Error Logs', desc: 'Severity-filtered platform error viewer with copy and export.' },
  { id: 'audit', label: 'Audit Logs', icon: '☰', group: 'Security', title: 'Audit Timeline', desc: 'Every privileged admin action with actor, IP and target.' },
  { id: 'ops', label: 'Backup / Ops', icon: '◉', group: 'Security', title: 'Backup & Operations', desc: 'Snapshots, maintenance mode, cache and queue controls.' },
  { id: 'security', label: 'Security', icon: '⬡', group: 'Security', title: 'Security Center', desc: '2FA preference, session policy and failed login detection.' },
];

function errMsg(err: unknown, fallback: string) {
  const anyErr = err as any;
  return anyErr?.response?.data?.error || anyErr?.message || fallback;
}

function initials(name?: string, email?: string) {
  const src = (name || email || 'O').trim();
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function healthClass(status?: string) {
  const s = String(status || '').toLowerCase();
  if (s === 'online' || s === 'configured' || s === 'ok') return 'ok';
  if (s === 'warning' || s === 'degraded' || s === 'unconfigured') return 'warn';
  if (s === 'offline' || s === 'expired' || s === 'bad') return 'bad';
  return 'info';
}

function parseUa(ua?: string | null) {
  const s = ua || '';
  let browser = 'Unknown';
  let os = 'Unknown';
  let device = 'Desktop';
  if (/edg\//i.test(s)) browser = 'Edge';
  else if (/chrome\//i.test(s)) browser = 'Chrome';
  else if (/firefox\//i.test(s)) browser = 'Firefox';
  else if (/safari\//i.test(s)) browser = 'Safari';
  if (/windows/i.test(s)) os = 'Windows';
  else if (/mac os/i.test(s)) os = 'macOS';
  else if (/android/i.test(s)) { os = 'Android'; device = 'Mobile'; }
  else if (/iphone|ipad|ios/i.test(s)) { os = 'iOS'; device = 'Mobile'; }
  else if (/linux/i.test(s)) os = 'Linux';
  return { browser, os, device };
}

function KpiCard({
  icon, label, value, tone = 'blue', trend,
}: {
  icon: string; label: string; value: string | number; tone?: string; trend?: string;
}) {
  return (
    <div className={`sa-card sa-kpi-card tone-${tone}`}>
      <div className="sa-kpi-top">
        <div className="sa-kpi-icon">{icon}</div>
        {trend ? <SparkTrend up={!/down|fail|expir/i.test(trend)} label={trend} /> : null}
      </div>
      <div className="sa-kpi">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      <div className="sa-kpi-label">{label}</div>
    </div>
  );
}

function SectionPanel({
  icon, title, desc, actions, children, className = '', id, panelRef,
}: {
  icon?: string; title: string; desc?: string; actions?: ReactNode; children: ReactNode; className?: string;
  id?: string; panelRef?: RefObject<HTMLDivElement>;
}) {
  return (
    <div id={id} ref={panelRef} className={`sa-card panel ${className}`}>
      <div className="sa-section-head">
        <div>
          <h3 className="sa-section-title">{icon ? <span>{icon}</span> : null}{title}</h3>
          {desc ? <p className="sa-section-desc">{desc}</p> : null}
        </div>
        {actions ? <div className="sa-toolbar">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

function exportCsv(filename: string, rows: Record<string, unknown>[], onEmpty?: () => void) {
  if (!rows.length) {
    if (onEmpty) onEmpty();
    return false;
  }
  const keys = Object.keys(rows[0]);
  const lines = [
    keys.join(','),
    ...rows.map((r) => keys.map((k) => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

export default function SuperAdminPage() {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<TabId>('overview');
  const [overview, setOverview] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [liveAlerts, setLiveAlerts] = useState<any[]>([]);
  const [activity, setActivity] = useState<any>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [errorFilter, setErrorFilter] = useState('');
  const [errorQuery, setErrorQuery] = useState('');
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const [authEvents, setAuthEvents] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [expiry, setExpiry] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [backups, setBackups] = useState<any[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [newExpiry, setNewExpiry] = useState({ name: '', category: 'api', expiresAt: '', warnDays: 14, notes: '' });
  const [pwd, setPwd] = useState('');
  const [notifCat, setNotifCat] = useState('all');
  const [openaiUsage, setOpenaiUsage] = useState<any>(null);
  const [intelFeed, setIntelFeed] = useState<any[]>([]);
  const [intelOpenId, setIntelOpenId] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    const data = await getAdminOverview();
    setOverview(data);
  }, []);

  const openCampaignIntelligence = useCallback(async (successEventId: string) => {
    if (!successEventId) return;
    setTab('intelligence');
    setIntelOpenId(successEventId);
  }, []);

  const refreshTab = useCallback(async () => {
    setError('');
    try {
      if (tab === 'overview' || tab === 'revenue' || tab === 'ai' || tab === 'channels' || tab === 'leads' || tab === 'health') {
        await loadOverview();
      }
      if (tab === 'ai') {
        setOpenaiUsage(await getAdminOpenAiUsage());
      }
      if (tab === 'overview' && overview?.successFeed) {
        setIntelFeed(overview.successFeed || []);
      }
      if (tab === 'subscribers') {
        const res = await getAdminUsers({ q: search || undefined, status: statusFilter || undefined });
        setUsers(res.users || []);
      }
      if (tab === 'notifications') {
        const res = await getAdminNotifications();
        setNotifications(res.notifications || []);
        setLiveAlerts(res.liveAlerts || []);
      }
      if (tab === 'activity') {
        const [a, ae] = await Promise.all([getAdminActivity(), getAdminAuthEvents(80)]);
        setActivity(a);
        setAuthEvents(ae.events || []);
      }
      if (tab === 'audit') setAudit((await getAdminAudit(120)).logs || []);
      if (tab === 'errors') setErrors((await getAdminErrors(120)).logs || []);
      if (tab === 'expiry') setExpiry(await getAdminExpiry());
      if (tab === 'revenue') setPayments((await getAdminPayments(80)).events || []);
      if (tab === 'ops') {
        setSettings(await getAdminSettings());
        setBackups((await listAdminBackups()).backups || []);
      }
      if (tab === 'security') {
        setSettings(await getAdminSettings());
        setAuthEvents((await getAdminAuthEvents(80)).events || []);
      }
    } catch (err) {
      setError(errMsg(err, 'Failed to load Super Admin data'));
    } finally {
      setLoading(false);
    }
  }, [tab, search, statusFilter, loadOverview, overview?.successFeed]);

  useEffect(() => { void refreshTab(); }, [refreshTab]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (tab === 'overview' || tab === 'health' || tab === 'notifications' || tab === 'activity') {
        void refreshTab();
      }
    }, 20000);
    return () => window.clearInterval(id);
  }, [tab, refreshTab]);

  const selected = useMemo(() => users.find((u) => u.id === selectedId) || null, [users, selectedId]);
  const nav = NAV.find((t) => t.id === tab)!;
  const biz = overview?.business || {};
  const rev = overview?.revenue || {};
  const health = overview?.health?.checks || {};
  const ai = overview?.ai || {};
  const channels = overview?.channels || {};
  const leads = overview?.leads || {};
  const revenuePoints = (rev.revenueGraph || []).map((g: any) => ({ label: g.date, value: Number(g.revenue) || 0 }));
  const mrr = Number(rev.mrr || 0);
  const arr = Number(rev.arr != null ? rev.arr : mrr * 12);

  const healthScore = useMemo(() => {
    const vals = Object.values(health) as any[];
    if (!vals.length) return 0;
    let score = 0;
    vals.forEach((v) => {
      const s = String(v?.status || '').toLowerCase();
      if (s === 'online' || s === 'configured' || s === 'ok') score += 100;
      else if (s === 'warning' || s === 'degraded' || s === 'unconfigured') score += 55;
      else score += 15;
    });
    return Math.round(score / vals.length);
  }, [health]);

  const planSegments = useMemo(() => {
    const counts: Record<string, number> = { starter: 0, pro: 0, agency: 0, free: 0 };
    users.forEach((u) => {
      const plan = String(u.subscriptionPlan || '').toLowerCase();
      if (plan === 'starter' || plan === 'pro' || plan === 'agency') counts[plan] += 1;
      else counts.free += 1;
    });
    if (!users.length) {
      counts.free = biz.freeUsers || 0;
      counts.starter = Math.max(0, (biz.paidUsers || 0) - (biz.trialUsers || 0));
    }
    return [
      { label: 'Starter', value: counts.starter, color: '#3b82f6' },
      { label: 'Pro', value: counts.pro, color: '#8b5cf6' },
      { label: 'Agency', value: counts.agency, color: '#10b981' },
      { label: 'Free', value: counts.free, color: '#64748b' },
    ];
  }, [users, biz]);

  const filteredErrors = useMemo(() => {
    return errors.filter((e) => {
      if (errorFilter && String(e.level || '').toLowerCase() !== errorFilter) return false;
      if (errorQuery) {
        const q = errorQuery.toLowerCase();
        return `${e.source || ''} ${e.message || ''}`.toLowerCase().includes(q);
      }
      return true;
    });
  }, [errors, errorFilter, errorQuery]);

  const filteredNotifs = useMemo(() => {
    const all = [...liveAlerts.map((n, i) => ({ ...n, id: n.id || `live-${i}`, _live: true })), ...notifications];
    if (notifCat === 'all') return all;
    return all.filter((n) => String(n.category || n.source || '').toLowerCase().includes(notifCat));
  }, [liveAlerts, notifications, notifCat]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setMsg(''); setError('');
    try {
      await fn();
      setMsg(`${label} completed`);
      await refreshTab();
    } catch (err) {
      setError(errMsg(err, `${label} failed`));
    } finally {
      setBusy('');
    }
  };

  const groups = Array.from(new Set(NAV.map((n) => n.group)));

  return (
    <div className="sa-root">
      <div className="sa-shell">
        <aside className="sa-nav">
          <div className="sa-brand-block">
            <Logo size={44} />
            <div className="sa-brand-text">
              <div className="sa-brand-name">LeadFlow AI</div>
              <div className="sa-brand-tag">Owner Console</div>
            </div>
          </div>

          <div className="sa-owner-card">
            <div className="sa-avatar">{initials(user?.fullName, user?.email)}</div>
            <div className="sa-owner-meta">
              <div className="sa-owner-name">{user?.fullName || 'Owner'}</div>
              <div className="sa-owner-email">{user?.email}</div>
            </div>
          </div>

          {groups.map((g) => (
            <div key={g}>
              <div className="sa-nav-group-label">{g}</div>
              {NAV.filter((t) => t.group === g).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`sa-nav-item ${tab === t.id ? 'is-active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  <span className="sa-nav-ico" aria-hidden>{t.icon}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          ))}

          <div className="sa-nav-foot">
            <Link to="/app">← Back to workspace</Link>
            <button type="button" className="linkish" onClick={() => logout()}>Sign out</button>
          </div>
        </aside>

        <main className="sa-main">
          <div className="sa-header">
            <div className="sa-header-left">
              <div className="sa-header-icon" aria-hidden>{nav.icon}</div>
              <div>
                <h1>{nav.title}</h1>
                <p>{nav.desc}</p>
              </div>
            </div>
            <div className="sa-toolbar">
              <button className="sa-btn ghost" type="button" disabled={!!busy} onClick={() => void refreshTab()}>Refresh</button>
              {(tab === 'subscribers' || tab === 'revenue' || tab === 'errors' || tab === 'audit') && (
                <button
                  className="sa-btn"
                  type="button"
                  onClick={() => {
                    if (tab === 'subscribers') exportCsv('subscribers.csv', users.map((u) => ({
                      name: u.fullName, email: u.email, plan: u.subscriptionPlan, status: u.subscriptionStatus,
                      business: u.businessName, expires: u.subscriptionExpiresAt, lastLogin: u.lastLoginAt, credits: u.freeAiMessagesRemaining,
                    })), () => setError('No logs found — nothing to export'));
                    if (tab === 'revenue') exportCsv('payments.csv', payments, () => setError('No payment events to export'));
                    if (tab === 'errors') exportCsv('errors.csv', filteredErrors, () => setError('No logs found — nothing to export'));
                    if (tab === 'audit') exportCsv('audit.csv', audit, () => setError('No audit rows to export'));
                  }}
                >
                  Export
                </button>
              )}
            </div>
          </div>

          {msg && <div className="sa-alert success">{msg}</div>}
          {error && <div className="sa-alert critical">{error}</div>}
          {loading && !overview && tab === 'overview' && (
            <div className="sa-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="sa-skeleton" />)}</div>
          )}

          {tab === 'overview' && (
            <>
              <ExecutiveOverviewPanel
                executive={overview?.executive}
                onOpenIntelligence={() => setTab('intelligence')}
              />

              <SectionPanel icon="◈" title="Command snapshot" desc="Quick links into the classic Admin Dashboard widgets below.">
                <p className="sa-muted" style={{ marginBottom: 0 }}>
                  Executive Overview above is the production source of truth for all 20 owner KPIs.
                  Charts and legacy cards below remain for operational drill-down.
                </p>
              </SectionPanel>

              <div className="sa-grid">
                <KpiCard icon="◎" label="Total Users" value={biz.totalUsers || 0} tone="blue" trend={`+${biz.newSubscribersToday || 0} today`} />
                <KpiCard icon="◆" label="Active Subscribers" value={biz.activeSubscribers || 0} tone="green" trend="Paid active" />
                <KpiCard icon="◷" label="Expired" value={biz.expiredSubscribers || 0} tone="red" trend="Needs attention" />
                <KpiCard icon="◇" label="Trial Users" value={biz.trialUsers || 0} tone="orange" trend="In trial" />
                <KpiCard icon="$" label="MRR" value={`$${mrr.toLocaleString()}`} tone="cyan" trend="Est. monthly" />
                <KpiCard icon="▲" label="ARR" value={`$${arr.toLocaleString()}`} tone="indigo" trend="MRR × 12" />
                <KpiCard
                  icon="✦"
                  label="OpenAI Req Today"
                  value={ai.requestsToday ?? 0}
                  tone="violet"
                  trend={ai.totalTokens != null ? `${Number(ai.totalTokens).toLocaleString()} tokens tracked` : 'Tracked usage'}
                />
                <KpiCard icon="◉" label="WhatsApp Sent" value={channels.whatsapp?.campaignsSent || 0} tone="green" trend={`${channels.whatsapp?.replies || 0} replies`} />
                <KpiCard icon="✉" label="Emails Sent" value={channels.email?.sent || 0} tone="blue" trend={`${channels.email?.openRate || 0}% open`} />
                <KpiCard icon="◇" label="Leads Scraped" value={leads.leadsScraped || 0} tone="cyan" trend={`${leads.conversionRate || 0}% conv.`} />
                <KpiCard icon="▣" label="Appointments" value={leads.appointmentsBooked || 0} tone="orange" trend="Meetings" />
                <KpiCard icon="⌁" label="Online Now" value={overview?.activity?.onlineCount || 0} tone="green" trend="Last 15 min" />
              </div>

              <div className="sa-split sa-split-wide">
                <SectionPanel icon="◈" title="Revenue trend (30 days)" desc="Daily platform revenue from payment ledger / MRR estimate.">
                  <AreaChart points={revenuePoints} color="#38bdf8" height={200} />
                  {rev.estimated && <p className="sa-muted" style={{ marginTop: 8 }}>Showing estimated MRR until PayPal ledger accumulates events.</p>}
                </SectionPanel>
                <SectionPanel icon="◎" title="Plan mix" desc="Free vs paid distribution.">
                  <DonutChart
                    segments={planSegments}
                    centerLabel="Accounts"
                    centerValue={(biz.totalUsers || users.length || 0)}
                  />
                </SectionPanel>
              </div>

              <div className="sa-split">
                <SectionPanel icon="⬡" title="Platform health score" desc="Composite score across probed services.">
                  <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                    <div className="sa-score-ring" style={{ ['--score' as any]: `${healthScore}%` }}>
                      <span>{healthScore}</span>
                    </div>
                    <div>
                      <div className="sa-kpi" style={{ fontSize: 22 }}>{healthScore >= 80 ? 'Healthy' : healthScore >= 55 ? 'Degraded' : 'Critical'}</div>
                      <p className="sa-muted">Auto-refreshes every 20s. Open Operations Center for per-service latency.</p>
                    </div>
                  </div>
                </SectionPanel>
                <SectionPanel icon="✦" title="AI pattern snapshot" desc="Highest converting industries from Owner Intelligence.">
                  {(overview?.patterns?.highestConvertingIndustries || []).slice(0, 5).map((row: any) => (
                    <div key={row.key} className="sa-alert info" style={{ display: 'block' }}>
                      <strong>{row.key}</strong>
                      <div className="sa-muted">{row.wins} wins · avg conv {Math.round(row.avg_conversion || 0)}% · ${Number(row.revenue || 0).toLocaleString()}</div>
                    </div>
                  ))}
                  {!(overview?.patterns?.highestConvertingIndustries || []).length && (
                    <div className="sa-empty"><strong>Learning in progress</strong>Success scans will populate industry patterns automatically.</div>
                  )}
                  <div className="sa-actions">
                    <button className="sa-btn primary" type="button" onClick={() => setTab('intelligence')}>Open AI Intelligence</button>
                  </div>
                </SectionPanel>
              </div>

              <SectionPanel icon="✦" title="Owner Success Feed" desc="Live customer wins detected automatically across workspaces." className="glow">
                <div className="sa-notif-grid">
                  {(overview?.successFeed || intelFeed || []).length === 0 && (
                    <div className="sa-empty" style={{ gridColumn: '1 / -1' }}>
                      <strong>Waiting for customer wins</strong>
                      Scanner runs every 5 minutes. Open AI Intelligence to scan now.
                    </div>
                  )}
                  {(overview?.successFeed || intelFeed || []).slice(0, 8).map((s: any) => (
                    <div
                      key={s.id}
                      className="sa-notif-card sa-alert success"
                      style={{ margin: 0, display: 'block', cursor: 'pointer' }}
                      onClick={() => void openCampaignIntelligence(s.id)}
                    >
                      <div className="cat">{s.eventType || 'success'}</div>
                      <strong>{s.customerName}</strong>
                      <div className="sa-muted" style={{ marginTop: 6 }}>
                        {s.country || '—'} · {s.niche || '—'} · {s.campaignType}
                      </div>
                      <div className="sa-muted" style={{ marginTop: 6 }}>
                        Rev ${Number(s.revenue || 0).toLocaleString()} · Leads {s.leadCount || 0} · Replies {s.replies || 0} · Deals {s.conversions || 0} · Conv {s.conversionRate || 0}%
                      </div>
                      <div className="sa-actions">
                        <button className="sa-btn primary" type="button" onClick={(e) => { e.stopPropagation(); void openCampaignIntelligence(s.id); }}>
                          Open analysis
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </SectionPanel>
            </>
          )}

          {tab === 'revenue' && (
            <>
              <div className="sa-grid">
                <KpiCard icon="$" label="Total Revenue" value={`$${Number(rev.totalRevenue || 0).toLocaleString()}`} tone="blue" />
                <KpiCard icon="▣" label="Monthly Revenue" value={`$${Number(rev.monthlyRevenue || 0).toLocaleString()}`} tone="green" />
                <KpiCard icon="◉" label="Daily Revenue" value={`$${Number(rev.dailyRevenue || 0).toLocaleString()}`} tone="cyan" />
                <KpiCard icon="◇" label="Yearly Revenue" value={`$${Number(rev.yearlyRevenue || 0).toLocaleString()}`} tone="indigo" />
                <KpiCard icon="▲" label="Annual (ARR)" value={`$${arr.toLocaleString()}`} tone="indigo" trend="MRR × 12" />
                <KpiCard icon="◆" label="MRR" value={`$${mrr.toLocaleString()}`} tone="violet" />
                <KpiCard icon="↻" label="Renewals" value={rev.subscriptionRenewals || 0} tone="green" />
                <KpiCard icon="↩" label="Refunds" value={rev.refunds || 0} tone="orange" />
                <KpiCard icon="!" label="Failed Payments" value={rev.failedPayments || 0} tone="red" />
                <KpiCard icon="…" label="Pending" value={rev.pendingPayments || 0} tone="orange" />
              </div>
              <div className="sa-split">
                <SectionPanel icon="◈" title="Daily revenue" desc="Last 30 days.">
                  <AreaChart points={revenuePoints} color="#34d399" />
                </SectionPanel>
                <SectionPanel icon="▣" title="Weekly bars" desc="Sampled daily series as bar view.">
                  <BarChart points={revenuePoints.filter((_: any, i: number) => i % 3 === 0)} color="#818cf8" height={180} />
                </SectionPanel>
              </div>
              <SectionPanel icon="☰" title="Payment events" desc="PayPal and ledger events." actions={<button className="sa-btn" type="button" onClick={() => exportCsv('payments.csv', payments)}>Export CSV</button>}>
                <div className="sa-table-wrap">
                  <table className="sa-table">
                    <thead><tr><th>When</th><th>Email</th><th>Provider</th><th>Type</th><th>Plan</th><th>Amount</th><th>Status</th></tr></thead>
                    <tbody>
                      {payments.length === 0 && <tr><td colSpan={7}><div className="sa-empty"><strong>No payment events</strong>PayPal webhooks will populate this ledger.</div></td></tr>}
                      {payments.map((p) => (
                        <tr key={p.id}>
                          <td className="sa-mono">{p.created_at ? new Date(p.created_at).toLocaleString() : '—'}</td>
                          <td>{p.email || '—'}</td>
                          <td>{p.provider || 'paypal'}</td>
                          <td>{p.event_type}</td>
                          <td><span className="sa-pill plan">{p.plan_key || '—'}</span></td>
                          <td>{p.amount != null ? `$${p.amount}` : '—'}</td>
                          <td><span className={`sa-pill ${p.status === 'failed' ? 'bad' : p.status === 'pending' ? 'warn' : 'ok'}`}>{p.status || '—'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionPanel>
            </>
          )}

          {tab === 'subscribers' && (
            <div className="sa-split sa-split-wide">
              <SectionPanel
                icon="◎"
                title="All subscribers"
                desc="Platform directory with plan, status and activity."
                actions={(
                  <>
                    <select className="sa-select" style={{ width: 140 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                      <option value="">All statuses</option>
                      <option value="active">Active</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="pending">Pending</option>
                      <option value="past_due">Past due</option>
                      <option value="suspended">Suspended</option>
                    </select>
                    <button className="sa-btn" type="button" onClick={() => exportCsv('subscribers.csv', users)}>Export CSV</button>
                    <button
                      className="sa-btn danger"
                      type="button"
                      disabled={!!busy}
                      onClick={() => run('Production cleanup', async () => {
                        const preview = await cleanupNonOwnerUsers(false);
                        const list = (preview.willRemove || []).map((u: any) => u.email).join('\n');
                        if (!window.confirm(`Delete ${preview.willRemove?.length || 0} non-owner accounts and keep only ${preview.ownerEmail}?\n\n${list}`)) return;
                        const result = await cleanupNonOwnerUsers(true);
                        setMsg(`Removed ${result.removed || 0} accounts. Backup: ${result.backup || 'saved'}`);
                        const res = await getAdminUsers({ q: search || undefined, status: statusFilter || undefined });
                        setUsers(res.users || []);
                        setSelectedId(null);
                      })}
                    >
                      Cleanup test users
                    </button>
                  </>
                )}
              >
                <div className="sa-search-row">
                  <input className="sa-input" placeholder="Search email, name, business…" value={search} onChange={(e) => setSearch(e.target.value)} />
                  <button className="sa-btn primary" type="button" onClick={() => void refreshTab()}>Search</button>
                </div>
                <div className="sa-table-wrap">
                  <table className="sa-table">
                    <thead>
                      <tr>
                        <th>User</th><th>Business</th><th>Plan</th><th>Status</th><th>Country</th>
                        <th>Signup</th><th>Expiry</th><th>Last login</th><th>Credits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id} className={selectedId === u.id ? 'is-selected' : ''} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(u.id)}>
                          <td>
                            <div className="sa-user-cell">
                              <div className="sa-avatar">{initials(u.fullName, u.email)}</div>
                              <div>
                                <div style={{ fontWeight: 700 }}>{u.fullName || '—'}</div>
                                <div className="sa-muted">{u.email}</div>
                              </div>
                            </div>
                          </td>
                          <td>{u.businessName || '—'}</td>
                          <td><span className="sa-pill plan">{u.subscriptionPlan || 'free'}</span></td>
                          <td>
                            <span className={`sa-pill ${u.accountStatus === 'suspended' ? 'bad' : u.subscriptionStatus === 'active' ? 'ok' : 'warn'}`}>
                              {u.accountStatus === 'suspended' ? 'suspended' : (u.subscriptionStatus || 'none')}
                            </span>
                          </td>
                          <td>{u.lastLoginCountry || '—'}</td>
                          <td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
                          <td>{u.subscriptionExpiresAt ? new Date(u.subscriptionExpiresAt).toLocaleDateString() : '—'}</td>
                          <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                          <td>{u.freeAiMessagesRemaining ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionPanel>

              <SectionPanel icon="◎" title="Subscriber profile" desc="Quick actions for the selected account.">
                {!selected && <div className="sa-empty"><strong>Select a subscriber</strong>Choose a row to manage plan, quota and access.</div>}
                {selected && (
                  <>
                    <div className="sa-user-cell" style={{ marginBottom: 14 }}>
                      <div className="sa-avatar" style={{ width: 48, height: 48 }}>{initials(selected.fullName, selected.email)}</div>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 16 }}>{selected.fullName}</div>
                        <div className="sa-muted">{selected.email}</div>
                      </div>
                    </div>
                    <p className="sa-muted">Business: {selected.businessName || '—'} · Role: {selected.role}</p>
                    <p className="sa-muted">Plan: {selected.subscriptionPlan || '—'} · Expires: {selected.subscriptionExpiresAt ? new Date(selected.subscriptionExpiresAt).toLocaleString() : '—'}</p>
                    <p className="sa-muted">AI credits: {selected.freeAiMessagesRemaining ?? '—'} · IP: {selected.lastLoginIp || '—'}</p>
                    <p className="sa-muted">Device: {parseUa(selected.lastLoginUserAgent).device} · {parseUa(selected.lastLoginUserAgent).browser} · {parseUa(selected.lastLoginUserAgent).os}</p>
                    <p className="sa-muted">Country: {selected.lastLoginCountry || '—'}</p>
                    <div className="sa-actions">
                      <button className="sa-btn primary" disabled={!!busy} onClick={() => run('Extend +30d', async () => { await extendAdminUser(selected.id, 30); })}>Extend plan</button>
                      <button className="sa-btn" disabled={!!busy} onClick={() => run('Reset AI credits', async () => { await resetAdminAiQuota(selected.id); })}>Reset AI credits</button>
                      {selected.accountStatus === 'suspended' ? (
                        <button className="sa-btn" disabled={!!busy} onClick={() => run('Activate', async () => { await activateAdminUser(selected.id); })}>Activate</button>
                      ) : (
                        <button className="sa-btn danger" disabled={!!busy} onClick={() => run('Suspend', async () => { await suspendAdminUser(selected.id, 'Suspended by owner'); })}>Suspend</button>
                      )}
                      <button className="sa-btn danger" disabled={!!busy} onClick={() => {
                        if (!window.confirm(`Delete ${selected.email}?`)) return;
                        void run('Delete user', async () => { await deleteAdminUser(selected.id); setSelectedId(null); });
                      }}>Delete</button>
                    </div>
                    <div className="sa-actions">
                      <input className="sa-input" style={{ maxWidth: 220 }} type="password" placeholder="New password (min 8)" value={pwd} onChange={(e) => setPwd(e.target.value)} />
                      <button className="sa-btn" disabled={!!busy || pwd.length < 8} onClick={() => run('Reset password', async () => { await resetAdminPassword(selected.id, pwd); setPwd(''); })}>Reset password</button>
                    </div>
                  </>
                )}
              </SectionPanel>
            </div>
          )}

          {tab === 'health' && (
            <>
              <div className="sa-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <KpiCard icon="⬡" label="Health score" value={`${healthScore}%`} tone={healthScore >= 80 ? 'green' : healthScore >= 55 ? 'orange' : 'red'} trend="Composite" />
                <KpiCard icon="▣" label="Services monitored" value={Object.keys(health).length} tone="cyan" />
                <KpiCard icon="◷" label="Avg latency" value={`${Math.round((Object.values(health) as any[]).filter((v) => v?.latencyMs != null).reduce((s, v: any) => s + v.latencyMs, 0) / Math.max(1, (Object.values(health) as any[]).filter((v) => v?.latencyMs != null).length) || 0)} ms`} tone="indigo" />
              </div>
              <div className="sa-health-grid">
                {Object.entries(health).map(([key, val]: any) => {
                  const cls = healthClass(val?.status);
                  return (
                    <div key={key} className={`sa-health-card status-${cls}`}>
                      <div className="top">
                        <div className="name">{key}</div>
                        <span className={`sa-pill ${cls}`}>{val?.status || '—'}</span>
                      </div>
                      <div className="detail">{val?.detail || 'No detail'}</div>
                      <div className="meta">
                        <span>Latency {val?.latencyMs != null ? `${val.latencyMs}ms` : '—'}</span>
                        <span>Uptime probe</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {tab === 'expiry' && (
            <>
              <div className="sa-grid">
                <KpiCard icon="!" label="Warnings" value={(expiry?.warnings || []).length} tone="orange" />
                <KpiCard icon="◷" label="Tracked items" value={(expiry?.items || []).length} tone="cyan" />
                <KpiCard icon="✕" label="Expired" value={(expiry?.items || []).filter((i: any) => i.level === 'expired').length} tone="red" />
                <KpiCard icon="✓" label="Healthy" value={(expiry?.items || []).filter((i: any) => i.level === 'ok').length} tone="green" />
              </div>
              <SectionPanel icon="+" title="Add expiry item" desc="Track OpenAI, Render, Domain, SSL, Meta, Twilio, SerpAPI and more.">
                <div className="sa-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 0 }}>
                  <input className="sa-input" placeholder="Name" value={newExpiry.name} onChange={(e) => setNewExpiry({ ...newExpiry, name: e.target.value })} />
                  <input className="sa-input" placeholder="Category" value={newExpiry.category} onChange={(e) => setNewExpiry({ ...newExpiry, category: e.target.value })} />
                  <input className="sa-input" type="date" value={newExpiry.expiresAt} onChange={(e) => setNewExpiry({ ...newExpiry, expiresAt: e.target.value })} />
                  <input className="sa-input" type="number" placeholder="Warn days" value={newExpiry.warnDays} onChange={(e) => setNewExpiry({ ...newExpiry, warnDays: Number(e.target.value) })} />
                  <input className="sa-input" placeholder="Notes" value={newExpiry.notes} onChange={(e) => setNewExpiry({ ...newExpiry, notes: e.target.value })} />
                  <button className="sa-btn primary" type="button" disabled={!newExpiry.name || !newExpiry.expiresAt} onClick={() => run('Save expiry', async () => {
                    await upsertAdminExpiry({
                      name: newExpiry.name,
                      category: newExpiry.category,
                      expiresAt: new Date(newExpiry.expiresAt).toISOString(),
                      warnDays: newExpiry.warnDays,
                      notes: newExpiry.notes,
                    });
                    setNewExpiry({ name: '', category: 'api', expiresAt: '', warnDays: 14, notes: '' });
                  })}>Save item</button>
                </div>
              </SectionPanel>
              <SectionPanel icon="◷" title="Renewal calendar" desc="Color-coded 30 / 15 / 7 / 3 / 1 day windows.">
                <div className="sa-table-wrap">
                  <table className="sa-table">
                    <thead><tr><th>Name</th><th>Category</th><th>Expires</th><th>Days left</th><th>Window</th><th>Notes</th><th></th></tr></thead>
                    <tbody>
                      {(expiry?.items || []).map((it: any) => {
                        const d = it.remainingDays;
                        let window = 'ok';
                        if (d != null) {
                          if (d < 0) window = 'expired';
                          else if (d <= 1) window = '1 day';
                          else if (d <= 3) window = '3 days';
                          else if (d <= 7) window = '7 days';
                          else if (d <= 15) window = '15 days';
                          else if (d <= 30) window = '30 days';
                        }
                        return (
                          <tr key={it.id}>
                            <td style={{ fontWeight: 700 }}>{it.name}</td>
                            <td>{it.category}</td>
                            <td>{it.expiresAt ? new Date(it.expiresAt).toLocaleDateString() : '—'}</td>
                            <td>{d ?? '—'}</td>
                            <td><span className={`sa-pill ${it.level === 'ok' ? 'ok' : it.level === 'warning' ? 'warn' : 'bad'}`}>{window}</span></td>
                            <td>{it.notes || '—'}</td>
                            <td>
                              {!String(it.id || '').startsWith('env_') && (
                                <button
                                  className="sa-btn danger"
                                  type="button"
                                  disabled={!!busy}
                                  onClick={() => run('Delete expiry', async () => { await deleteAdminExpiry(it.id); })}
                                >
                                  Delete
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </SectionPanel>
            </>
          )}

          {tab === 'notifications' && (
            <SectionPanel
              icon="◈"
              title="Alerts"
              desc="Categorized owner notifications."
              actions={(
                <>
                  <select className="sa-select" style={{ width: 150 }} value={notifCat} onChange={(e) => setNotifCat(e.target.value)}>
                    {['all', 'success', 'billing', 'security', 'system', 'expiry', 'ops', 'ai'].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button className="sa-btn primary" type="button" disabled={!!busy} onClick={() => run('Scan alerts', async () => { await refreshAdminNotifications(); })}>Scan & push</button>
                  <button className="sa-btn" type="button" disabled={!!busy} onClick={() => run('Scan successes', async () => { await scanAdminIntelligence(); })}>Scan customer wins</button>
                </>
              )}
            >
              <div className="sa-notif-grid">
                {filteredNotifs.length === 0 && <div className="sa-empty" style={{ gridColumn: '1 / -1' }}><strong>Inbox zero</strong>No alerts in this category.</div>}
                {filteredNotifs.map((n: any) => {
                  const successId = String(n.source || '').startsWith('ose_') ? n.source : null;
                  const isSuccess = String(n.category || '').toLowerCase() === 'success'
                    || /SUCCESS DETECTED|High Performing Campaign/i.test(n.title || '');
                  return (
                    <div
                      key={n.id}
                      className={`sa-notif-card sa-alert ${n.severity === 'critical' ? 'critical' : isSuccess || n.severity === 'success' ? 'success' : n.severity === 'info' ? 'info' : ''}`}
                      style={{ margin: 0, display: 'block', cursor: successId ? 'pointer' : 'default' }}
                      onClick={() => { if (successId) void openCampaignIntelligence(successId); }}
                    >
                      <div className="cat">{n.category || n.source || 'system'}</div>
                      <strong>{n.title}</strong>
                      <div className="sa-muted" style={{ marginTop: 6 }}>{n.body}</div>
                      <div className="sa-actions">
                        {successId && (
                          <button className="sa-btn primary" type="button" onClick={(e) => { e.stopPropagation(); void openCampaignIntelligence(successId); }}>
                            Open campaign intelligence
                          </button>
                        )}
                        {!n.acknowledged && !n._live && (
                          <button className="sa-btn" type="button" onClick={(e) => { e.stopPropagation(); void run('Ack', async () => { await ackAdminNotification(n.id); }); }}>Acknowledge</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </SectionPanel>
          )}

          {tab === 'activity' && (
            <div className="sa-split">
              <SectionPanel icon="⌁" title="Live online users" desc="Active within the last 15 minutes.">
                <KpiCard icon="◎" label="Online now" value={activity?.onlineCount || 0} tone="green" />
                <div style={{ marginTop: 14 }}>
                  {(activity?.liveOnlineUsers || []).map((u: any) => {
                    const ua = parseUa(u.lastLoginUserAgent);
                    return (
                      <div key={u.id} className="sa-user-cell" style={{ marginBottom: 12 }}>
                        <div className="sa-avatar">{initials(u.fullName, u.email)}</div>
                        <div>
                          <strong>{u.fullName || u.email}</strong>
                          <div className="sa-muted">{u.email}</div>
                          <div className="sa-muted">{u.lastLoginIp || '—'} · {ua.device} · {ua.browser} · {ua.os} · {u.lastLoginCountry || '—'}</div>
                        </div>
                      </div>
                    );
                  })}
                  {(activity?.liveOnlineUsers || []).length === 0 && <div className="sa-empty"><strong>No live sessions</strong>Users appear here after recent logins.</div>}
                </div>
              </SectionPanel>
              <SectionPanel icon="☰" title="Login history" desc="Success and failed attempts with IP logging.">
                <div className="sa-table-wrap">
                  <table className="sa-table">
                    <thead><tr><th>When</th><th>Email</th><th>Event</th><th>IP</th><th>Device</th><th>Country</th><th>OK</th></tr></thead>
                    <tbody>
                      {(activity?.loginHistory || authEvents).map((e: any) => {
                        const ua = parseUa(e.userAgent || e.user_agent);
                        return (
                          <tr key={e.id}>
                            <td className="sa-mono">{new Date(e.createdAt || e.created_at).toLocaleString()}</td>
                            <td>{e.email}</td>
                            <td>{e.eventType || e.event_type}</td>
                            <td>{e.ip || '—'}</td>
                            <td>{ua.browser} / {ua.os}</td>
                            <td>{e.country || '—'}</td>
                            <td><span className={`sa-pill ${e.success ? 'ok' : 'bad'}`}>{e.success ? 'yes' : 'no'}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </SectionPanel>
            </div>
          )}

          {tab === 'ai' && (
            <>
              <div className="sa-grid">
                <KpiCard
                  icon="$"
                  label="OpenAI balance / budget left"
                  value={
                    openaiUsage?.openAiBalance?.remainingUsd != null
                      ? `$${openaiUsage.openAiBalance.remainingUsd}`
                      : (openaiUsage?.remainingBudgetUsd != null ? `$${openaiUsage.remainingBudgetUsd}` : '—')
                  }
                  tone="green"
                  trend={
                    openaiUsage?.openAiKeyStatus?.ok
                      ? 'Key OK'
                      : (openaiUsage?.openAiBalance?.source || (openaiUsage?.masterKeyConfigured ? 'Tracked' : 'No key'))
                  }
                />
                <KpiCard icon="✦" label="Est. remaining requests" value={openaiUsage?.estimatedRemainingRequests ?? '—'} tone="violet" />
                <KpiCard icon="▣" label="Total tokens used" value={openaiUsage?.totalTokens || 0} tone="cyan" />
                <KpiCard icon="$" label="Total API cost" value={`$${Number(openaiUsage?.totalApiCost || 0).toFixed(4)}`} tone="orange" />
                <KpiCard icon="⚡" label="Requests today" value={openaiUsage?.requestsToday || 0} tone="blue" />
                <KpiCard icon="◉" label="Requests this month" value={openaiUsage?.requestsThisMonth || 0} tone="indigo" />
                <KpiCard icon="$" label="Cost this month" value={`$${Number(openaiUsage?.costThisMonth || 0).toFixed(4)}`} tone="orange" />
                <KpiCard icon="◎" label="Tracked API events" value={openaiUsage?.trackingEvents || 0} tone="cyan" />
              </div>
              <div className="sa-split">
                <SectionPanel icon="◈" title="Cost trend (tracked)" desc="From real OpenAI usage events recorded by the platform.">
                  <AreaChart
                    points={[
                      { label: 'Today', value: Number(openaiUsage?.costToday || 0) * 1000 },
                      { label: 'Month', value: Number(openaiUsage?.costThisMonth || 0) * 1000 },
                      { label: 'Total', value: Number(openaiUsage?.totalApiCost || 0) * 1000 },
                    ]}
                    color="#a78bfa"
                  />
                  <p className="sa-muted" style={{ marginTop: 8 }}>{openaiUsage?.note}</p>
                  {(openaiUsage?.byModel || []).length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <strong>By model</strong>
                      {(openaiUsage.byModel || []).map((m: any) => (
                        <div key={m.model} className="sa-muted" style={{ marginTop: 4 }}>
                          {m.model}: {m.requests} req · {m.tokens} tokens · ${Number(m.cost || 0).toFixed(4)}
                        </div>
                      ))}
                    </div>
                  )}
                </SectionPanel>
                <SectionPanel icon="◎" title="Top AI users" desc="By tracked OpenAI requests.">
                  <div className="sa-table-wrap">
                    <table className="sa-table">
                      <thead><tr><th>User</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead>
                      <tbody>
                        {(openaiUsage?.topAiUsers || []).length === 0 && (
                          <tr><td colSpan={4}><div className="sa-empty"><strong>No usage yet</strong>Usage appears after real OpenAI calls.</div></td></tr>
                        )}
                        {(openaiUsage?.topAiUsers || []).map((u: any) => (
                          <tr key={u.userId}>
                            <td>
                              <div style={{ fontWeight: 700 }}>{u.name || u.email || u.userId}</div>
                              <div className="sa-muted">{u.email || '—'}</div>
                            </td>
                            <td>{u.requests}</td>
                            <td>{u.tokens}</td>
                            <td>${Number(u.cost || 0).toFixed(4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </SectionPanel>
              </div>
            </>
          )}

          {tab === 'intelligence' && (
            <OwnerIntelligencePanel
              busy={busy}
              run={run}
              setMsg={setMsg}
              setError={setError}
              externalOpenId={intelOpenId}
              onExternalOpenConsumed={() => setIntelOpenId(null)}
            />
          )}

          {tab === 'channels' && (
            <>
              <h3 className="sa-section-title" style={{ marginBottom: 12 }}>Totals (all channels)</h3>
              <div className="sa-grid">
                <KpiCard icon="▣" label="Total outbound" value={channels.totals?.totalOutbound || 0} tone="blue" />
                <KpiCard icon="◎" label="Manual messages" value={channels.totals?.manualSent || 0} tone="cyan" />
                <KpiCard icon="✦" label="AI messages" value={channels.totals?.aiSent || 0} tone="violet" />
              </div>
              <h3 className="sa-section-title" style={{ margin: '18px 0 12px' }}>WhatsApp</h3>
              <div className="sa-grid">
                <KpiCard icon="◎" label="Connected numbers" value={channels.whatsapp?.connectedNumbers || 0} tone="green" />
                <KpiCard icon="▲" label="Total sent" value={channels.whatsapp?.campaignsSent || 0} tone="cyan" />
                <KpiCard icon="◎" label="Manual sent" value={channels.whatsapp?.manualSent || 0} tone="blue" />
                <KpiCard icon="✦" label="AI sent" value={channels.whatsapp?.aiSent || 0} tone="violet" />
                <KpiCard icon="✓" label="Delivered" value={channels.whatsapp?.delivered || 0} tone="green" />
                <KpiCard icon="◉" label="Replies" value={channels.whatsapp?.replies || 0} tone="indigo" />
                <KpiCard icon="!" label="Failed" value={channels.whatsapp?.failed || 0} tone="red" />
              </div>
              <h3 className="sa-section-title" style={{ margin: '18px 0 12px' }}>Email</h3>
              <div className="sa-grid">
                <KpiCard icon="✉" label="Total sent" value={channels.email?.sent || 0} tone="blue" />
                <KpiCard icon="◎" label="Manual sent" value={channels.email?.manualSent || 0} tone="cyan" />
                <KpiCard icon="✦" label="AI sent" value={channels.email?.aiSent || 0} tone="violet" />
                <KpiCard icon="✓" label="Delivered" value={channels.email?.delivered || 0} tone="green" />
                <KpiCard icon="◎" label="Open rate %" value={channels.email?.openRate || 0} tone="cyan" />
                <KpiCard icon="↗" label="Click rate %" value={channels.email?.clickRate || 0} tone="violet" />
                <KpiCard icon="↩" label="Bounce rate %" value={channels.email?.bounceRate || 0} tone="red" />
                <KpiCard icon="◉" label="Replies" value={channels.email?.replies || 0} tone="indigo" />
              </div>
              <h3 className="sa-section-title" style={{ margin: '18px 0 12px' }}>SMS (future-ready)</h3>
              <div className="sa-grid">
                <KpiCard icon="▣" label="Total sent" value={channels.sms?.sent || 0} tone="blue" />
                <KpiCard icon="◎" label="Manual sent" value={channels.sms?.manualSent || 0} tone="cyan" />
                <KpiCard icon="✦" label="AI sent" value={channels.sms?.aiSent || 0} tone="violet" />
                <KpiCard icon="◉" label="Replies" value={channels.sms?.replies || 0} tone="indigo" />
              </div>
              <div className="sa-split" style={{ marginTop: 14 }}>
                <SectionPanel icon="◉" title="WhatsApp volume" desc="Sent vs delivered vs replies.">
                  <DonutChart
                    segments={[
                      { label: 'Manual', value: channels.whatsapp?.manualSent || 0, color: '#22d3ee' },
                      { label: 'AI', value: channels.whatsapp?.aiSent || 0, color: '#a78bfa' },
                      { label: 'Replies', value: channels.whatsapp?.replies || 0, color: '#34d399' },
                      { label: 'Failed', value: channels.whatsapp?.failed || 0, color: '#fb7185' },
                    ]}
                    centerLabel="WA"
                  />
                </SectionPanel>
                <SectionPanel icon="✉" title="Email engagement" desc="Open / click / bounce rates.">
                  <BarChart
                    points={[
                      { label: 'Open', value: channels.email?.openRate || 0 },
                      { label: 'Click', value: channels.email?.clickRate || 0 },
                      { label: 'Bounce', value: channels.email?.bounceRate || 0 },
                    ]}
                    color="#60a5fa"
                    height={180}
                  />
                </SectionPanel>
              </div>
            </>
          )}

          {tab === 'leads' && (
            <>
              <div className="sa-grid">
                <KpiCard icon="◇" label="Leads scraped" value={leads.leadsScraped || 0} tone="cyan" />
                <KpiCard icon="◆" label="Qualified leads" value={leads.qualifiedLeads || 0} tone="blue" />
                <KpiCard icon="%" label="Conversion rate" value={`${leads.conversionRate || 0}%`} tone="green" />
                <KpiCard icon="▣" label="Appointments" value={leads.appointmentsBooked || 0} tone="orange" />
                <KpiCard icon="▲" label="Deals won" value={leads.dealsWon || 0} tone="violet" />
              </div>
              <div className="sa-split">
                <SectionPanel icon="◈" title="Funnel" desc="Scraped → qualified → meetings → deals.">
                  <BarChart
                    points={[
                      { label: 'Scraped', value: leads.leadsScraped || 0 },
                      { label: 'Qualified', value: leads.qualifiedLeads || 0 },
                      { label: 'Meetings', value: leads.appointmentsBooked || 0 },
                      { label: 'Deals', value: leads.dealsWon || 0 },
                    ]}
                    color="#22d3ee"
                    height={200}
                  />
                </SectionPanel>
                <SectionPanel icon="◎" title="Conversion mix">
                  <DonutChart
                    segments={[
                      { label: 'Qualified', value: leads.qualifiedLeads || 0, color: '#3b82f6' },
                      { label: 'Meetings', value: leads.appointmentsBooked || 0, color: '#f59e0b' },
                      { label: 'Deals', value: leads.dealsWon || 0, color: '#10b981' },
                    ]}
                    centerLabel="Pipe"
                  />
                </SectionPanel>
              </div>
            </>
          )}

          {tab === 'errors' && (
            <SectionPanel
              icon="!"
              title="Log viewer"
              desc="Search, filter, copy and export platform errors."
              actions={(
                <>
                  <select className="sa-select" style={{ width: 130 }} value={errorFilter} onChange={(e) => setErrorFilter(e.target.value)}>
                    <option value="">All levels</option>
                    <option value="error">Error</option>
                    <option value="warn">Warn</option>
                    <option value="info">Info</option>
                  </select>
                  <button
                    className="sa-btn"
                    type="button"
                    onClick={() => {
                      const ok = exportCsv('errors.csv', filteredErrors, () => setError('No logs found — nothing to download'));
                      if (ok) setMsg('CSV downloaded');
                    }}
                  >
                    Download
                  </button>
                  <button
                    className="sa-btn primary"
                    type="button"
                    disabled={!!busy}
                    onClick={() => run('Create test error', async () => {
                      await createAdminTestError('Owner Console verification test error');
                    })}
                  >
                    Create test error
                  </button>
                </>
              )}
            >
              <div className="sa-search-row">
                <input className="sa-input" placeholder="Search source or message…" value={errorQuery} onChange={(e) => setErrorQuery(e.target.value)} />
              </div>
              {filteredErrors.length === 0 && <div className="sa-empty"><strong>No logs found</strong>Runtime errors and test probes will appear here after they are recorded.</div>}
              {filteredErrors.map((e) => (
                <div key={e.id} className="sa-notif-card" style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <span className={`sa-pill ${e.level === 'error' ? 'bad' : 'warn'}`}>{e.level}</span>
                      <strong style={{ marginLeft: 8 }}>{e.source}</strong>
                      <div className="sa-muted" style={{ marginTop: 6 }}>{e.message}</div>
                      <div className="sa-mono sa-muted">{e.created_at ? new Date(e.created_at).toLocaleString() : ''}</div>
                    </div>
                    <div className="sa-actions" style={{ marginTop: 0 }}>
                      <button className="sa-btn" type="button" onClick={() => navigator.clipboard.writeText(JSON.stringify(e, null, 2))}>Copy</button>
                      <button className="sa-btn" type="button" onClick={() => setExpandedError(expandedError === e.id ? null : e.id)}>
                        {expandedError === e.id ? 'Collapse' : 'Expand'}
                      </button>
                    </div>
                  </div>
                  {expandedError === e.id && <pre className="sa-log-pre">{JSON.stringify(e.meta || e, null, 2)}</pre>}
                </div>
              ))}
            </SectionPanel>
          )}

          {tab === 'audit' && (
            <SectionPanel icon="☰" title="Admin action timeline" desc="Who changed what, when, and from where.">
              <div className="sa-timeline">
                {audit.length === 0 && <div className="sa-empty"><strong>No audit events yet</strong>Owner actions will stream here.</div>}
                {audit.map((a) => (
                  <div key={a.id} className="sa-timeline-item">
                    <strong>{a.action}</strong>
                    <div className="sa-muted">
                      {a.actor_email || a.actor_id || 'system'} · {a.target_type}:{a.target_id || '—'} · {a.ip || '—'}
                    </div>
                    <div className="sa-mono sa-muted">{a.created_at ? new Date(a.created_at).toLocaleString() : ''}</div>
                    {a.user_agent && <div className="sa-muted">{parseUa(a.user_agent).browser} · {parseUa(a.user_agent).os}</div>}
                  </div>
                ))}
              </div>
            </SectionPanel>
          )}

          {tab === 'ops' && (
            <div className="sa-split">
              <SectionPanel icon="◉" title="Operations controls" desc="Maintenance, real cache clear, worker restart and snapshots.">
                <p className="sa-muted">Maintenance mode: <strong>{settings?.maintenance?.enabled ? 'ON' : 'OFF'}</strong></p>
                <div className="sa-actions">
                  <button className="sa-btn primary" disabled={!!busy} onClick={() => run('Create backup', async () => { await createAdminBackup(false); })}>Database backup</button>
                  <button className="sa-btn" disabled={!!busy} onClick={() => run('Maintenance ON', async () => { await setAdminMaintenance(true); })}>Maintenance ON</button>
                  <button className="sa-btn" disabled={!!busy} onClick={() => run('Maintenance OFF', async () => { await setAdminMaintenance(false); })}>Maintenance OFF</button>
                  <button className="sa-btn" disabled={!!busy} onClick={() => run('Clear cache', async () => {
                    const r = await clearAdminCache();
                    setMsg(`Cache cleared: ${JSON.stringify(r.cleared || r)}`);
                  })}>Cache clear</button>
                  <button className="sa-btn" disabled={!!busy} onClick={() => run('Restart workers', async () => { await restartAdminQueue(); })}>Restart workers</button>
                </div>
              </SectionPanel>
              <SectionPanel icon="▣" title="Backup library" desc="Safe restore restores expiry + settings only (users/campaigns/leads are never overwritten).">
                <div className="sa-table-wrap">
                  <table className="sa-table">
                    <thead><tr><th>File</th><th>Size</th><th>Created</th><th></th></tr></thead>
                    <tbody>
                      {backups.length === 0 && <tr><td colSpan={4}><div className="sa-empty"><strong>No backups yet</strong>Create a JSON snapshot to get started.</div></td></tr>}
                      {backups.map((b) => (
                        <tr key={b.file}>
                          <td className="sa-mono">{b.file}</td>
                          <td>{Math.round((b.size || 0) / 1024)} KB</td>
                          <td>{b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'}</td>
                          <td>
                            <button
                              className="sa-btn"
                              type="button"
                              disabled={!!busy}
                              onClick={() => {
                                if (!window.confirm(`Safe restore from ${b.file}?\n\nThis restores expiry items + settings only.\nUsers, campaigns and leads are NOT overwritten.`)) return;
                                void run('Safe restore', async () => {
                                  const r = await restoreAdminBackup(b.file);
                                  setMsg(r.message || `Restored: ${JSON.stringify(r.restored || {})}`);
                                });
                              }}
                            >
                              Safe restore
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionPanel>
            </div>
          )}

          {tab === 'security' && (
            <div className="sa-split">
              <SectionPanel icon="⬡" title="Security policy" desc="Idle session timeout is enforced server-side. Incomplete 2FA UI has been removed.">
                <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 16 }}>
                  <div className="sa-score-ring" style={{ ['--score' as any]: '78%' }}>
                    <span>78</span>
                  </div>
                  <div>
                    <div style={{ fontWeight: 800 }}>Security posture</div>
                    <p className="sa-muted">Super Admin role gate + idle session timeout. TOTP 2FA is not shipped yet.</p>
                  </div>
                </div>
                <label className="sa-muted">Admin session idle timeout (minutes)</label>
                <input className="sa-input" type="number" style={{ marginTop: 6, marginBottom: 12 }} defaultValue={settings?.security?.adminSessionTimeoutMinutes || 60} id="sa-timeout" />
                <label className="sa-muted">Subscriber session idle timeout (minutes)</label>
                <input className="sa-input" type="number" style={{ marginTop: 6, marginBottom: 12 }} defaultValue={settings?.security?.userSessionTimeoutMinutes || 120} id="sa-user-timeout" />
                <label className="sa-muted">Failed login alert threshold</label>
                <input className="sa-input" type="number" style={{ marginTop: 6, marginBottom: 14 }} defaultValue={settings?.security?.failedLoginAlertThreshold || 5} id="sa-fail-threshold" />
                <button
                  className="sa-btn primary"
                  type="button"
                  disabled={!!busy}
                  onClick={() => run('Save security', async () => {
                    const timeout = Number((document.getElementById('sa-timeout') as HTMLInputElement)?.value || 60);
                    const userTimeout = Number((document.getElementById('sa-user-timeout') as HTMLInputElement)?.value || 120);
                    const failedLoginAlertThreshold = Number((document.getElementById('sa-fail-threshold') as HTMLInputElement)?.value || 5);
                    await setAdminSecurity({
                      adminSessionTimeoutMinutes: timeout,
                      userSessionTimeoutMinutes: userTimeout,
                      failedLoginAlertThreshold,
                      twoFactorEnabled: false,
                    });
                  })}
                >
                  Save security settings
                </button>
              </SectionPanel>
              <SectionPanel icon="!" title="Failed login detection" desc="Repeated failures raise owner notifications.">
                <div className="sa-table-wrap">
                  <table className="sa-table">
                    <thead><tr><th>When</th><th>Email</th><th>IP</th><th>Event</th></tr></thead>
                    <tbody>
                      {authEvents.filter((e) => !e.success).slice(0, 40).map((e) => (
                        <tr key={e.id}>
                          <td className="sa-mono">{new Date(e.created_at).toLocaleString()}</td>
                          <td>{e.email}</td>
                          <td>{e.ip || '—'}</td>
                          <td><span className="sa-pill bad">{e.event_type}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionPanel>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
