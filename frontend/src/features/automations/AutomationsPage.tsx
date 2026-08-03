import { useEffect, useState } from 'react';
import PageHeader from '../common/PageHeader';
import { useAuth } from '../auth/AuthContext';
import {
  listAutomations,
  getAutomationStats,
  listAutomationRuns,
  listAutomationLogs,
  createAutomation,
  deleteAutomation,
  enableAutomation,
  disableAutomation,
  runAutomationNow,
  AutomationRecord,
  AutomationStats,
} from '../../lib/apiClient';

const TEMPLATES: Array<Partial<AutomationRecord> & { name: string; description: string; actions: AutomationRecord['actions'] }> = [
  {
    name: 'Qualify New Leads',
    description: 'When triggered, run AI/heuristic qualification across workspace leads.',
    triggerType: 'manual',
    color: '#10b981',
    conditions: [],
    actions: [{ type: 'qualify_leads', config: { limit: 200 } }],
  },
  {
    name: 'Hot Lead Follow-up',
    description: 'Schedule follow-ups for a specific lead (pass leadId when running).',
    triggerType: 'score_hot',
    color: '#f59e0b',
    conditions: [],
    actions: [{ type: 'schedule_followup', config: { days1: 2, days2: 5 } }],
  },
  {
    name: 'WhatsApp on Hot Lead',
    description: 'Send WhatsApp via unifiedSend when a lead becomes hot (requires leadId + WhatsApp creds).',
    triggerType: 'score_hot',
    color: '#22c55e',
    conditions: [],
    actions: [{ type: 'send_whatsapp', config: { body: 'Hi {name}, quick note about {niche} — open to a short call?' } }],
  },
  {
    name: 'Email on Reply',
    description: 'Send a follow-up email when a reply is received (requires leadId + Gmail).',
    triggerType: 'reply_received',
    color: '#3b82f6',
    conditions: [],
    actions: [{ type: 'send_email', config: { subject: 'Thanks {name}', body: 'Hi {name},\n\nThanks for your reply — happy to help with {niche}.\n\nBest regards' } }],
  },
  {
    name: 'Handle Price Objection',
    description: 'On reply containing “price/expensive/cost”, draft an AI objection response using Settings → AI Agent objection handling. autoSend stays off by default.',
    triggerType: 'reply_received',
    color: '#f97316',
    conditions: [{ field: 'messageText', op: 'matches', value: 'price|expensive|cost|budget|too much' }],
    actions: [{ type: 'handle_objection', config: { autoSend: false, channel: 'email' } }],
  },
  {
    name: 'Hot Lead → Delay → WhatsApp',
    description: 'When a lead becomes hot, wait 5 minutes then send WhatsApp (delay + send). Requires WhatsApp credentials.',
    triggerType: 'score_hot',
    color: '#14b8a6',
    conditions: [],
    actions: [
      { type: 'delay', config: { minutes: 5 } },
      { type: 'send_whatsapp', config: { body: 'Hi {name}, circling back on {niche} in {city} — open to a quick chat?' } },
    ],
  },
  {
    name: 'Reply Branch: Interested vs Follow-up',
    description: 'On reply: if message mentions meeting/yes → mark interested; else schedule follow-up.',
    triggerType: 'reply_received',
    color: '#8b5cf6',
    conditions: [],
    actions: [
      {
        type: 'branch',
        config: {
          conditions: [{ field: 'messageText', op: 'matches', value: 'yes|interested|meeting|call|demo|book' }],
          then: [{ type: 'update_campaign_status', config: { status: 'interested' } }],
          else: [{ type: 'schedule_followup', config: { days1: 2, days2: 5 } }],
        },
      },
    ],
  },
  {
    name: 'Audit Ping',
    description: 'Writes an engine log only — useful to verify the automation runtime.',
    triggerType: 'manual',
    color: '#6366f1',
    conditions: [],
    actions: [{ type: 'log_only', config: { message: 'Automation engine heartbeat' } }],
  },
];

export default function AutomationsPage() {
  const { user } = useAuth();
  const [automations, setAutomations] = useState<AutomationRecord[]>([]);
  const [stats, setStats] = useState<AutomationStats | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'workflows' | 'templates' | 'history'>('workflows');

  async function refresh() {
    setError(null);
    const [a, s, r, l] = await Promise.all([
      listAutomations(),
      getAutomationStats(),
      listAutomationRuns(50),
      listAutomationLogs({ limit: 100 }),
    ]);
    setAutomations(a.automations || []);
    setStats(s.stats);
    setRuns(r.runs || []);
    setLogs(l.logs || []);
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        await refresh();
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load automations');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [user?.id]);

  async function installTemplate(t: typeof TEMPLATES[number]) {
    setBusyId(t.name);
    try {
      await createAutomation({
        name: t.name,
        description: t.description,
        enabled: false,
        triggerType: t.triggerType || 'manual',
        conditions: t.conditions || [],
        actions: t.actions,
        color: t.color,
      });
      await refresh();
      setActiveTab('workflows');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create automation');
    } finally {
      setBusyId(null);
    }
  }

  async function toggle(a: AutomationRecord) {
    setBusyId(a.id);
    try {
      if (a.enabled) await disableAutomation(a.id);
      else await enableAutomation(a.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update automation');
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(a: AutomationRecord) {
    setBusyId(a.id);
    try {
      await runAutomationNow(a.id, {});
      await refresh();
      setActiveTab('history');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run automation');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(a: AutomationRecord) {
    if (!window.confirm(`Delete automation "${a.name}"?`)) return;
    setBusyId(a.id);
    try {
      await deleteAutomation(a.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete automation');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="lf-page">
      <PageHeader
        title="Automation Center"
        subtitle="Backend workflows with triggers, conditions (AND/OR), delays, branching, retries, and full run logs"
      />

      {loading && <div className="lf-alert">Loading automations…</div>}
      {error && <div className="lf-alert lf-alert-error">{error}</div>}

      <div className="lf-kpi-grid">
        <div className="lf-card-premium lf-card-emerald">
          <div className="lf-card-accent" />
          <div className="lf-kpi-value-premium">{stats?.enabledAutomations ?? 0}</div>
          <div className="lf-kpi-label-premium">Enabled</div>
        </div>
        <div className="lf-card-premium lf-card-cyan">
          <div className="lf-card-accent" />
          <div className="lf-kpi-value-premium">{stats?.totalAutomations ?? 0}</div>
          <div className="lf-kpi-label-premium">Total Automations</div>
        </div>
        <div className="lf-card-premium lf-card-purple">
          <div className="lf-card-accent" />
          <div className="lf-kpi-value-premium">{stats?.runsRunning ?? 0}</div>
          <div className="lf-kpi-label-premium">Running / Pending</div>
        </div>
        <div className="lf-card-premium">
          <div className="lf-card-accent" />
          <div className="lf-kpi-value-premium">{stats?.runsSucceeded ?? 0}</div>
          <div className="lf-kpi-label-premium">Succeeded Runs</div>
        </div>
      </div>

      <div className="lf-card-premium" style={{ marginBottom: 20, padding: 16 }}>
        <div className="lf-segmented">
          <button className={activeTab === 'workflows' ? 'is-active' : ''} onClick={() => setActiveTab('workflows')}>
            Workflows ({automations.length})
          </button>
          <button className={activeTab === 'templates' ? 'is-active' : ''} onClick={() => setActiveTab('templates')}>
            Install Templates
          </button>
          <button className={activeTab === 'history' ? 'is-active' : ''} onClick={() => setActiveTab('history')}>
            Runs & Logs
          </button>
        </div>
      </div>

      {activeTab === 'workflows' && (
        <div style={{ display: 'grid', gap: 12 }}>
          {automations.length === 0 && (
            <div className="lf-alert">No automations yet. Install a template to create a real backend workflow.</div>
          )}
          {automations.map((a) => (
            <div key={a.id} className="lf-card-premium" style={{ padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: a.color || '#6366f1' }} />
                <strong>{a.name}</strong>
                <span className={`lf-pill ${a.enabled ? 'lf-pill-on' : ''}`}>{a.enabled ? 'Enabled' : 'Disabled'}</span>
                <span className="lf-pill">{a.triggerType}</span>
              </div>
              <p style={{ color: 'var(--lf-text-secondary)', marginBottom: 12 }}>{a.description}</p>
              <div style={{ fontSize: 12, color: 'var(--lf-text-secondary)', marginBottom: 12 }}>
                Actions: {(a.actions || []).map((x) => x.type).join(', ') || 'none'}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="lf-btn lf-btn-primary" disabled={busyId === a.id} onClick={() => runNow(a)}>Run now</button>
                <button className="lf-btn" disabled={busyId === a.id} onClick={() => toggle(a)}>
                  {a.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="lf-btn lf-btn-danger" disabled={busyId === a.id} onClick={() => remove(a)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'templates' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 14 }}>
          {TEMPLATES.map((t) => (
            <div key={t.name} className="lf-card-premium" style={{ padding: 18 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>{t.name}</div>
              <p style={{ fontSize: 13, color: 'var(--lf-text-secondary)', marginBottom: 12 }}>{t.description}</p>
              <button className="lf-btn lf-btn-primary" disabled={busyId === t.name} onClick={() => installTemplate(t)}>
                Install to backend
              </button>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'history' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="lf-card-premium" style={{ padding: 16 }}>
            <h3 style={{ marginTop: 0 }}>Recent runs</h3>
            {runs.length === 0 && <div className="lf-alert">No runs yet.</div>}
            {runs.map((r) => (
              <div key={r.id} style={{ borderBottom: '1px solid var(--lf-border)', padding: '8px 0', fontSize: 13 }}>
                <div><strong>{r.status}</strong> · {r.triggerType || 'manual'}</div>
                <div style={{ color: 'var(--lf-text-secondary)' }}>{r.createdAt}</div>
                {r.error && <div style={{ color: '#f87171' }}>{r.error}</div>}
              </div>
            ))}
          </div>
          <div className="lf-card-premium" style={{ padding: 16 }}>
            <h3 style={{ marginTop: 0 }}>Execution logs</h3>
            {logs.length === 0 && <div className="lf-alert">No logs yet.</div>}
            {logs.map((l) => (
              <div key={l.id} style={{ borderBottom: '1px solid var(--lf-border)', padding: '8px 0', fontSize: 13 }}>
                <div><strong>{l.level}</strong> · {l.stepType} · {l.message}</div>
                <div style={{ color: 'var(--lf-text-secondary)' }}>{l.createdAt}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
