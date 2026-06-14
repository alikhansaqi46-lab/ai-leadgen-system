import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../common/PageHeader';
import {
  getScores,
  qualifyLeads,
  ScoredLead,
  LeadPriority,
} from '../../lib/apiClient';

const PRIORITY_LABEL: Record<LeadPriority, string> = {
  hot: '🔥 Hot',
  warm: '🌤 Warm',
  cold: '❄ Cold',
};

function PriorityBadge({ priority }: { priority: LeadPriority | null }) {
  if (!priority) return <span className="lf-badge lf-badge-none">unscored</span>;
  return <span className={`lf-badge lf-badge-${priority}`}>{PRIORITY_LABEL[priority]}</span>;
}

export default function AIAgentPage() {
  const [rows, setRows] = useState<ScoredLead[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [qualifying, setQualifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      const res = await getScores();
      setRows(res.scores);
      if (res.mode) setModel(res.mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scores');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function runQualify(leadIds?: string[]) {
    try {
      setQualifying(true);
      setError(null);
      const res = await qualifyLeads(leadIds);
      setRows(res.scores);
      if (res.model) setModel(res.model);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Qualification failed');
    } finally {
      setQualifying(false);
    }
  }

  function toggle(leadId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      return next;
    });
  }

  const allChecked = rows.length > 0 && selected.size === rows.length;
  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.leadId)));
  }

  const stats = useMemo(() => {
    const scored = rows.filter((r) => r.score !== null);
    const count = (p: LeadPriority) => scored.filter((r) => r.priority === p).length;
    return {
      total: rows.length,
      scored: scored.length,
      hot: count('hot'),
      warm: count('warm'),
      cold: count('cold'),
    };
  }, [rows]);

  return (
    <div className="lf-page">
      <PageHeader
        title="AI Agent"
        subtitle={`Lead qualification${model ? ` · ${model} mode` : ''}`}
        actions={
          <>
            <button
              className="lf-btn"
              onClick={() => runQualify(Array.from(selected))}
              disabled={qualifying || selected.size === 0}
            >
              {qualifying ? 'Working…' : `Qualify selected (${selected.size})`}
            </button>
            <button
              className="lf-btn lf-btn-primary"
              onClick={() => runQualify()}
              disabled={qualifying}
            >
              {qualifying ? 'Working…' : 'Qualify all'}
            </button>
          </>
        }
      />

      <div className="lf-note">
        AI qualification scores every lead 0–100 on contactability, web presence, reputation,
        niche fit and profile completeness — fully deterministic and explainable. Hot ≥70 ·
        Warm 40–69 · Cold &lt;40. Message generation and approval arrive in S5.2. Manage raw
        leads in <Link className="lf-link" to="/app/leads">Leads</Link>.
      </div>

      <div className="lf-kpi-grid">
        <div className="lf-card"><div className="lf-kpi-value">{stats.scored}/{stats.total}</div><div className="lf-kpi-label">Leads qualified</div></div>
        <div className="lf-card"><div className="lf-kpi-value" style={{ color: '#b91c1c' }}>{stats.hot}</div><div className="lf-kpi-label">🔥 Hot</div></div>
        <div className="lf-card"><div className="lf-kpi-value" style={{ color: '#b45309' }}>{stats.warm}</div><div className="lf-kpi-label">🌤 Warm</div></div>
        <div className="lf-card"><div className="lf-kpi-value" style={{ color: '#475569' }}>{stats.cold}</div><div className="lf-kpi-label">❄ Cold</div></div>
      </div>

      {error && <div className="lf-alert lf-alert-error">{error}</div>}
      {loading && <div className="lf-card lf-skeleton" style={{ height: 240 }} />}

      {!loading && rows.length === 0 && (
        <div className="lf-empty">
          <span className="lf-empty-badge">No leads yet</span>
          <p className="lf-empty-text">
            Scrape some businesses first, then come back to qualify them.
          </p>
          <Link className="lf-btn lf-btn-primary" to="/app/workspace">Go scrape leads</Link>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="lf-card lf-table-wrap">
          <table className="lf-table">
            <thead>
              <tr>
                <th className="lf-row-check">
                  <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all" />
                </th>
                <th>#</th>
                <th>Lead</th>
                <th>Score</th>
                <th>Priority</th>
                <th>Niche</th>
                <th>Country</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Fragment key={r.leadId}>
                  <tr>
                    <td className="lf-row-check">
                      <input
                        type="checkbox"
                        checked={selected.has(r.leadId)}
                        onChange={() => toggle(r.leadId)}
                        aria-label={`Select ${r.lead.name || r.leadId}`}
                      />
                    </td>
                    <td className="lf-muted">{i + 1}</td>
                    <td>{r.lead.name || '—'}</td>
                    <td>
                      {r.score === null ? (
                        <span className="lf-muted">—</span>
                      ) : (
                        <>
                          <span className="lf-score">{r.score}</span>
                          <div className="lf-score-bar"><span style={{ width: `${r.score}%` }} /></div>
                        </>
                      )}
                    </td>
                    <td><PriorityBadge priority={r.priority} /></td>
                    <td>{r.lead.niche || '—'}</td>
                    <td>{r.lead.country || '—'}</td>
                    <td>
                      {r.breakdown && (
                        <button
                          className="lf-link"
                          style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                          onClick={() => setExpanded(expanded === r.leadId ? null : r.leadId)}
                        >
                          {expanded === r.leadId ? 'Hide' : 'Why?'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded === r.leadId && r.breakdown && (
                    <tr>
                      <td colSpan={8} style={{ background: '#f8fafc' }}>
                        {r.breakdown.factors.map((f) => (
                          <div className="lf-factor" key={f.key}>
                            <span><strong>{f.label}</strong> {f.points}/{f.max}</span>
                            <span className="lf-factor-reasons">{f.reasons.join(' · ')}</span>
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
