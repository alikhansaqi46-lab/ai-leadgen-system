import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import PageHeader from '../common/PageHeader';
import { getLeads, getFilters, getScores, downloadExportCsv, deleteLead, deleteLeadsBulk, getCampaigns, updateCampaignStatus, getHandoverPackage, Lead, FiltersResponse, ScoredLead, CampaignRecord } from '../../lib/apiClient';
import { writeBulkCampaign, type BulkCampaignChannel } from '../../lib/bulkCampaign';
import { useAuth } from '../auth/AuthContext';

interface SearchRecord {
  keyword: string;
  location: string;
  scope: string;
  savedCount: number;
  totalScraped: number;
  timestamp: string;
}

function historyKey(userId: string | null) {
  return userId ? `lf_scrape_history_${userId}` : 'lf_scrape_history';
}

export default function LeadsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id || null;
  const [searchParams] = useSearchParams();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [scores, setScores] = useState<ScoredLead[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([]);
  const [filters, setFilters] = useState<FiltersResponse>({ countries: [], niches: [] });
  const [country, setCountry] = useState('');
  const [niche, setNiche] = useState('');
  const [search, setSearch] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [todayOnly, setTodayOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  useEffect(() => {
    const urlKeyword = searchParams.get('keyword');
    const urlLocation = searchParams.get('location');
    const urlPriority = searchParams.get('priority');
    const urlStatus = searchParams.get('status');
    const urlFilter = searchParams.get('filter');

    if (urlKeyword) setNiche(urlKeyword);
    if (urlLocation) {
      const parts = urlLocation.split(',').map((s: string) => s.trim());
      const lastPart = parts[parts.length - 1];
      if (lastPart) setCountry(lastPart);
    }
    if (urlPriority) setPriorityFilter(urlPriority.toLowerCase());
    if (urlStatus) setStatusFilter(urlStatus.toLowerCase());
    setTodayOnly(urlFilter === 'today');

    if (!urlKeyword && !urlLocation && !urlPriority && !urlStatus && !urlFilter) {
      try {
        const raw = localStorage.getItem(historyKey(userId));
        if (raw) {
          const history = JSON.parse(raw) as SearchRecord[];
          if (history.length > 0) {
            const last = history[0];
            if (last.keyword) setNiche(last.keyword);
            const parts = last.location?.split(',').map((s: string) => s.trim()) || [];
            const lastPart = parts[parts.length - 1];
            if (lastPart) setCountry(lastPart);
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }, [searchParams, userId]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        const [leadsRes, filtersRes, scoresRes, campsRes] = await Promise.all([
          getLeads({ country: country || undefined, niche: niche || undefined, limit: 1000 }),
          getFilters(),
          getScores(),
          getCampaigns().catch(() => ({ campaigns: [] as CampaignRecord[] })),
        ]);
        if (active) {
          setLeads(leadsRes.leads);
          setFilters(filtersRes);
          setScores(scoresRes.scores);
          setCampaigns(campsRes.campaigns || []);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load leads');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [country, niche]);

  const scoreMap = useMemo(() => new Map(scores.map((s) => [s.leadId, s])), [scores]);
  const campaignMap = useMemo(() => new Map(campaigns.map((c) => [c.leadId, c])), [campaigns]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return leads.filter((l) => {
      if (q && ![l.name, l.phone, l.email, l.city, l.niche].some((v) => (v || '').toString().toLowerCase().includes(q))) {
        return false;
      }
      if (priorityFilter) {
        const p = String(scoreMap.get(l.id)?.priority || '').toLowerCase();
        if (p !== priorityFilter) return false;
      }
      if (statusFilter) {
        const st = String(campaignMap.get(l.id)?.status || 'new').toLowerCase();
        if (st !== statusFilter) return false;
      }
      if (todayOnly) {
        const created = l.createdAt ? new Date(l.createdAt) : null;
        if (!created || created < today) return false;
      }
      return true;
    });
  }, [leads, search, priorityFilter, statusFilter, todayOnly, scoreMap, campaignMap]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === visible.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visible.map((l) => l.id)));
    }
  };

  const handleDeleteSelected = async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      await deleteLeadsBulk(Array.from(selected));
      setSelected(new Set());
      // Refresh leads
      const [leadsRes, scoresRes] = await Promise.all([
        getLeads({ country: country || undefined, niche: niche || undefined, limit: 1000 }),
        getScores(),
      ]);
      setLeads(leadsRes.leads);
      setScores(scoresRes.scores);
      setShowDeleteConfirm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete leads');
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteAll = async () => {
    if (leads.length === 0) return;
    setDeleting(true);
    try {
      await deleteLeadsBulk(leads.map((l) => l.id));
      setSelected(new Set());
      // Refresh leads
      const [leadsRes, scoresRes] = await Promise.all([
        getLeads({ country: country || undefined, niche: niche || undefined, limit: 1000 }),
        getScores(),
      ]);
      setLeads(leadsRes.leads);
      setScores(scoresRes.scores);
      setShowDeleteConfirm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete leads');
    } finally {
      setDeleting(false);
    }
  };

  const handlePipelineChange = async (leadId: string, status: string) => {
    try {
      let revenue: number | undefined;
      if (status === 'deal' || status === 'interested' || status === 'meeting') {
        const raw = window.prompt('Pipeline value / deal amount (USD, optional — leave blank for 0)', '');
        if (raw != null && String(raw).trim() !== '') {
          const n = Number(raw);
          if (Number.isFinite(n)) revenue = n;
        }
      }
      const res = await updateCampaignStatus(leadId, status, revenue ?? null);
      setCampaigns((prev) => {
        const idx = prev.findIndex((c) => c.leadId === leadId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = res.campaign;
          return next;
        }
        return [...prev, res.campaign];
      });
      if (status === 'deal' && res.handover) {
        const blob = new Blob([JSON.stringify(res.handover, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `handover-${leadId}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update pipeline status');
    }
  };

  const downloadHandover = async (leadId: string) => {
    try {
      const res = await getHandoverPackage(leadId);
      const blob = new Blob([JSON.stringify(res.handover, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `handover-${leadId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download handover package');
    }
  };

  const openBulkCampaign = (channel: BulkCampaignChannel) => {
    const selectedLeads = visible.filter((l) => selected.has(l.id));
    if (selectedLeads.length === 0) return;
    writeBulkCampaign({
      channel,
      source: 'leads',
      leads: selectedLeads,
    });
    navigate(channel === 'contacts' ? '/app/contacts?bulk=1' : `/app/${channel}?bulk=1`);
  };

  return (
    <>
    <div className="lf-page-wide">
      <PageHeader
        title="Leads"
        subtitle={`${visible.length} of ${leads.length} leads`}
        actions={
          <>
            <Link className="lf-btn lf-btn-primary" to="/app/scraper">+ Find leads</Link>
            <button
              className="lf-btn"
              onClick={async () => {
                try {
                  await downloadExportCsv({ country: country || undefined, niche: niche || undefined });
                } catch (err) {
                  console.error('Export failed:', err);
                }
              }}
            >
              Export CSV
            </button>
          </>
        }
      />

      <div className="lf-toolbar">
        <input className="lf-input" placeholder="Search leads…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 240 }} />
        <select className="lf-input" value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">All countries</option>
          {filters.countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="lf-input" value={niche} onChange={(e) => setNiche(e.target.value)}>
          <option value="">All niches</option>
          {filters.niches.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <select className="lf-input" value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
          <option value="">All priorities</option>
          <option value="hot">Hot</option>
          <option value="warm">Warm</option>
          <option value="cold">Cold</option>
        </select>
        <select className="lf-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All pipeline statuses</option>
          <option value="new">New</option>
          <option value="sent">Sent</option>
          <option value="replied">Replied</option>
          <option value="interested">Interested</option>
          <option value="meeting">Meeting</option>
          <option value="deal">Deal</option>
          <option value="lost">Lost</option>
        </select>
        <label className="lf-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={todayOnly} onChange={(e) => setTodayOnly(e.target.checked)} />
          Today only
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          {leads.length > 0 && (
            <button className="lf-btn" onClick={() => setShowDeleteConfirm(true)} disabled={deleting}>
              Delete All
            </button>
          )}
          {selected.size > 0 && (
            <>
              <span style={{ fontSize: 13, color: 'var(--lf-text-secondary)' }}>{selected.size} selected</span>
              <button className="lf-btn lf-btn-danger" onClick={() => setShowDeleteConfirm(true)} disabled={deleting}>
                Delete Selected
              </button>
              <Link className="lf-btn lf-btn-primary" to={`/app/ai-agent?qualify=${Array.from(selected).join(',')}`}>Qualify</Link>
              <button className="lf-btn" onClick={() => openBulkCampaign('whatsapp')}>◉ WhatsApp</button>
              <button className="lf-btn" onClick={() => openBulkCampaign('email')}>@ Email</button>
              <button className="lf-btn" onClick={() => openBulkCampaign('sms')}>✆ SMS</button>
              <button className="lf-btn" onClick={() => openBulkCampaign('contacts')}>Contacts</button>
            </>
          )}
        </div>
      </div>

      {loading && <div className="lf-card lf-skeleton" style={{ height: 320 }} />}
      {error && <div className="lf-alert lf-alert-error">{error}</div>}

      {showDeleteConfirm && (
        <div className="lf-alert lf-alert-warning" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <strong>Confirm Deletion</strong>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              {selected.size > 0
                ? `Are you sure you want to delete ${selected.size} selected lead${selected.size === 1 ? '' : 's'}?`
                : 'Are you sure you want to delete all leads?'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="lf-btn" onClick={() => setShowDeleteConfirm(false)} disabled={deleting}>
              Cancel
            </button>
            <button
              className="lf-btn lf-btn-danger"
              onClick={selected.size > 0 ? handleDeleteSelected : handleDeleteAll}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Confirm Delete'}
            </button>
          </div>
        </div>
      )}

      {!loading && !error && leads.length === 0 && (
        <div className="lf-empty">
          <p className="lf-empty-text">No leads found. Start a new search.</p>
          <Link className="lf-btn lf-btn-primary" to="/app/scraper">+ Find leads</Link>
        </div>
      )}

      {!loading && !error && leads.length > 0 && (
        <div className="lf-card lf-table-wrap">
          <table className="lf-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}><input type="checkbox" checked={visible.length > 0 && selected.size === visible.length} onChange={toggleAll} /></th>
                <th>Business Name</th>
                <th>Phone / WhatsApp</th>
                <th>Email</th>
                <th>Website</th>
                <th>Full Address</th>
                <th>City</th>
                <th>Rating</th>
                <th>Reviews</th>
                <th>AI Score</th>
                <th>Pipeline</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={12} className="lf-muted" style={{ textAlign: 'center', padding: 40 }}>No leads match your filters.</td></tr>
              ) : (
                visible.map((l) => {
                  const sc = scoreMap.get(l.id);
                  const camp = campaignMap.get(l.id);
                  const pipelineStatus = String(camp?.status || 'new').toLowerCase();
                  return (
                    <tr key={l.id}>
                      <td><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleSelect(l.id)} /></td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{l.name || '—'}</div>
                      </td>
                      <td>
                        {l.phone ? (
                          <span className="lf-contact-text">{l.phone}</span>
                        ) : (
                          <span className="lf-contact-muted">—</span>
                        )}
                      </td>
                      <td>
                        {l.email && l.email !== 'N/A' ? (
                          <a href={`mailto:${l.email}`} className="lf-email-link" title={`Email ${l.name || 'this business'}`}>
                            <span style={{ marginRight: 4 }}>✉</span>{l.email}
                          </a>
                        ) : (
                          <span className="lf-contact-muted">—</span>
                        )}
                      </td>
                      <td>
                        {l.website && l.website !== 'N/A' ? (
                          <a href={l.website} target="_blank" rel="noreferrer" className="lf-contact-link">{l.website.replace(/^https?:\/\//, '').slice(0, 28)}{l.website.length > 31 ? '…' : ''}</a>
                        ) : (
                          <span className="lf-contact-muted">—</span>
                        )}
                      </td>
                      <td style={{ maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={l.address || undefined}>
                        {l.address && l.address !== 'N/A' ? (
                          <a
                            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.address)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="lf-contact-link"
                          >
                            {l.address}
                          </a>
                        ) : (
                          <span className="lf-contact-muted">—</span>
                        )}
                      </td>
                      <td><span className="lf-pill">{l.city || '—'}</span></td>
                      <td>
                        {l.rating ? (
                          <span style={{ color: '#fbbf24', fontWeight: 700 }}>★ {l.rating}</span>
                        ) : (
                          <span className="lf-contact-muted">—</span>
                        )}
                      </td>
                      <td>
                        {l.reviews ? l.reviews.toLocaleString() : (
                          <span className="lf-contact-muted">—</span>
                        )}
                      </td>
                      <td>
                        {sc?.priority ? (
                          <span className={`lf-badge lf-badge-${sc.priority}`}>{sc.score}</span>
                        ) : (
                          <span className="lf-badge lf-badge-none">Unscored</span>
                        )}
                      </td>
                      <td>
                        <select
                          className="lf-input"
                          style={{ height: 32, minWidth: 120, fontSize: 12, padding: '0 8px' }}
                          value={pipelineStatus}
                          onChange={(e) => handlePipelineChange(l.id, e.target.value)}
                        >
                          <option value="new">New</option>
                          <option value="sent">Sent</option>
                          <option value="replied">Replied</option>
                          <option value="interested">Interested</option>
                          <option value="meeting">Meeting</option>
                          <option value="deal">Deal</option>
                          <option value="lost">Lost</option>
                        </select>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <Link className="lf-btn" style={{ height: 32, padding: '0 10px', fontSize: 12 }} to={`/app/inbox`}>Inbox</Link>
                          <Link className="lf-btn" style={{ height: 32, padding: '0 10px', fontSize: 12 }} to={`/app/whatsapp?phone=${encodeURIComponent(l.phone || '')}`}>WA</Link>
                          <Link className="lf-btn" style={{ height: 32, padding: '0 10px', fontSize: 12 }} to={`/app/email?lead=${l.id}`}>Email</Link>
                          {pipelineStatus === 'deal' && (
                            <button className="lf-btn" style={{ height: 32, padding: '0 10px', fontSize: 12 }} type="button" onClick={() => downloadHandover(l.id)}>
                              Handover
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </>
  );
}
