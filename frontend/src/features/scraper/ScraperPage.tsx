import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import PageHeader from '../common/PageHeader';
import { scrapeLeads, Lead, getScraperConfig, setScraperConfig, startCampaign, StartCampaignReport } from '../../lib/apiClient';
import { useAuth } from '../auth/AuthContext';

interface ScrapeOutcome {
  savedCount: number;
  totalScraped: number;
  leads: Lead[];
  keyword: string;
  location: string;
  scope: string;
  timestamp: string;
}

interface SearchRecord {
  keyword: string;
  location: string;
  scope: string;
  savedCount: number;
  totalScraped: number;
  timestamp: string;
}

const SCOPE_LABELS: Record<string, string> = { city: 'City', state: 'State', country: 'Country' };
const LIMIT_OPTIONS = [20, 50, 100, 200, 500];

function historyKey(userId: string | null) {
  return userId ? `lf_scrape_history_${userId}` : 'lf_scrape_history';
}

function loadHistory(userId: string | null): SearchRecord[] {
  try { return JSON.parse(localStorage.getItem(historyKey(userId)) || '[]'); } catch { return []; }
}
function saveHistory(rec: SearchRecord, userId: string | null) {
  const all = [rec, ...loadHistory(userId)].slice(0, 20);
  localStorage.setItem(historyKey(userId), JSON.stringify(all));
}
function deleteHistoryItems(indices: number[], userId: string | null) {
  const all = loadHistory(userId);
  const filtered = all.filter((_, i) => !indices.includes(i));
  localStorage.setItem(historyKey(userId), JSON.stringify(filtered));
  return filtered;
}
function clearHistory(userId: string | null) {
  localStorage.setItem(historyKey(userId), '[]');
  // Also clear the old unscoped key so it never leaks to new users
  localStorage.removeItem('lf_scrape_history');
  return [];
}

export default function ScraperPage() {
  const { user } = useAuth();
  const userId = user?.id || null;

  const [keyword, setKeyword] = useState('');
  const [location, setLocation] = useState('');
  const [scope, setScope] = useState<'city' | 'state' | 'country'>('city');
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [result, setResult] = useState<ScrapeOutcome | null>(null);
  const [history, setHistory] = useState<SearchRecord[]>([]);
  const [selectedHistory, setSelectedHistory] = useState<Set<number>>(new Set());
  const [showHistoryDeleteConfirm, setShowHistoryDeleteConfirm] = useState(false);
  const [deletingHistory, setDeletingHistory] = useState(false);

  // Autonomous Start Campaign
  const [campaignGoal, setCampaignGoal] = useState('Book Appointments');
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [campaignReport, setCampaignReport] = useState<StartCampaignReport | null>(null);
  const [campaignError, setCampaignError] = useState<string | null>(null);

  // Load user-scoped history and clear old unscoped key
  useEffect(() => { setHistory(loadHistory(userId)); }, [userId]);

  // Check scraper config on mount
  useEffect(() => {
    getScraperConfig()
      .then((cfg) => setConfigured(cfg.configured))
      .catch(() => setConfigured(false));
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!keyword.trim() || !location.trim() || loading) return;
    setLoading(true);
    setError(null);
    setSetupRequired(false);
    try {
      const searchLocation = location.trim();
      const res = await scrapeLeads(keyword.trim(), searchLocation, limit);
      const outcome: ScrapeOutcome = {
        savedCount: res.savedCount,
        totalScraped: res.totalScraped,
        leads: res.leads,
        keyword: keyword.trim(),
        location: location.trim(),
        scope,
        timestamp: new Date().toISOString(),
      };
      setResult(outcome);
      const rec: SearchRecord = { keyword: keyword.trim(), location: location.trim(), scope, savedCount: res.savedCount, totalScraped: res.totalScraped, timestamp: outcome.timestamp };
      saveHistory(rec, userId);
      setHistory(loadHistory(userId));
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { error?: string; setupRequired?: boolean } | undefined;
        if (data?.setupRequired || err.response?.status === 503) setSetupRequired(true);
        setError(data?.error || err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Search failed');
      }
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const replaySearch = async (rec: SearchRecord) => {
    setKeyword(rec.keyword);
    setLocation(rec.location);
    setScope(rec.scope as 'city' | 'state' | 'country');
    setResult(null);
    setError(null);
    setLoading(true);
    try {
      const res = await scrapeLeads(rec.keyword, rec.location, limit);
      const outcome: ScrapeOutcome = {
        savedCount: res.savedCount,
        totalScraped: res.totalScraped,
        leads: res.leads,
        keyword: rec.keyword,
        location: rec.location,
        scope: rec.scope as 'city' | 'state' | 'country',
        timestamp: new Date().toISOString(),
      };
      setResult(outcome);
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { error?: string; setupRequired?: boolean } | undefined;
        if (data?.setupRequired || err.response?.status === 503) setSetupRequired(true);
        setError(data?.error || err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Search failed');
      }
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const handleConfigured = () => {
    setConfigured(true);
    setSetupRequired(false);
    setShowConfig(false);
  };

  const onStartCampaign = async (e: FormEvent) => {
    e.preventDefault();
    if (!keyword.trim() || !location.trim() || campaignLoading) return;
    setCampaignLoading(true);
    setCampaignError(null);
    setCampaignReport(null);
    try {
      const res = await startCampaign({
        businessType: keyword.trim(),
        location: location.trim(),
        goal: campaignGoal.trim() || 'Book Appointments',
        limit: Math.min(limit, 50),
        autoSend: false,
      });
      if (!res.success) {
        setCampaignError(res.error || 'Campaign start failed');
      }
      if (res.report) setCampaignReport(res.report);
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { error?: string; report?: StartCampaignReport } | undefined;
        setCampaignError(data?.error || err.message);
        if (data?.report) setCampaignReport(data.report);
      } else {
        setCampaignError(err instanceof Error ? err.message : 'Campaign start failed');
      }
    } finally {
      setCampaignLoading(false);
    }
  };

  const handleDeleteHistorySelected = () => {
    if (selectedHistory.size === 0) return;
    setDeletingHistory(true);
    const updated = deleteHistoryItems(Array.from(selectedHistory), userId);
    setHistory(updated);
    setSelectedHistory(new Set());
    setShowHistoryDeleteConfirm(false);
    setDeletingHistory(false);
  };

  const handleDeleteHistoryAll = () => {
    if (history.length === 0) return;
    setDeletingHistory(true);
    const updated = clearHistory(userId);
    setHistory(updated);
    setSelectedHistory(new Set());
    setShowHistoryDeleteConfirm(false);
    setDeletingHistory(false);
  };

  const toggleHistorySelect = (index: number) => {
    setSelectedHistory((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleHistoryAll = () => {
    if (selectedHistory.size === history.length) {
      setSelectedHistory(new Set());
    } else {
      setSelectedHistory(new Set(history.map((_, i) => i)));
    }
  };

  const handleDeleteSingleHistory = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeletingHistory(true);
    const updated = deleteHistoryItems([index], userId);
    setHistory(updated);
    setSelectedHistory(new Set());
    setDeletingHistory(false);
  };

  const duplicates = result ? Math.max(0, result.totalScraped - result.savedCount) : 0;
  const totalSaved = history.reduce((sum, h) => sum + h.savedCount, 0);
  const totalFound = history.reduce((sum, h) => sum + h.totalScraped, 0);
  const totalDups = Math.max(0, totalFound - totalSaved);

  return (
    <div className="lf-page">
      <PageHeader
        title="AI Sales Employee"
        subtitle="Enter business type, location, and goal — LeadFlow runs the sales workflow"
        actions={
          <Link className="lf-btn" to="/app/leads">View all leads →</Link>
        }
      />

      <div className="lf-card-premium lf-card-emerald" style={{ marginBottom: 20, padding: 22 }}>
        <div className="lf-card-accent" />
        <h3 style={{ marginTop: 0, fontSize: 20 }}>Start Campaign</h3>
        <p style={{ color: 'var(--lf-text-secondary)', fontSize: 13, marginBottom: 16, maxWidth: 640 }}>
          LeadFlow scrapes businesses, discovers emails, qualifies leads, drafts outreach, schedules follow-ups,
          and fires automations. Sending stays gated until you enable send automations or approve drafts.
        </p>
        <form onSubmit={onStartCampaign} style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <label style={{ display: 'grid', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)' }}>
            Business Type
            <input className="lf-input" placeholder="e.g. Dental Clinic" value={keyword} onChange={(e) => setKeyword(e.target.value)} required />
          </label>
          <label style={{ display: 'grid', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)' }}>
            Location
            <input className="lf-input" placeholder="e.g. Kuala Lumpur" value={location} onChange={(e) => setLocation(e.target.value)} required />
          </label>
          <label style={{ display: 'grid', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--lf-text-secondary)' }}>
            Campaign Goal
            <input className="lf-input" placeholder="e.g. Book Appointments" value={campaignGoal} onChange={(e) => setCampaignGoal(e.target.value)} required />
          </label>
          <button className="lf-btn lf-btn-primary" type="submit" disabled={campaignLoading || !configured} style={{ height: 44, fontWeight: 700 }}>
            {campaignLoading ? 'Running autonomous campaign…' : 'Start Campaign'}
          </button>
        </form>
        {campaignError && <div className="lf-alert lf-alert-error" style={{ marginTop: 12 }}>{campaignError}</div>}
        {campaignReport && (
          <div style={{ marginTop: 16, fontSize: 13 }}>
            <div>
              <strong>Saved:</strong> {campaignReport.leadsSaved}
              {' · '}<strong>Emails:</strong> {campaignReport.emailsDiscovered ?? 0}
              {' · '}<strong>Hot:</strong> {campaignReport.hot}
              {' · '}<strong>Drafts:</strong> {campaignReport.draftsGenerated ?? 0}
              {' · '}<strong>Follow-ups:</strong> {campaignReport.followUpsScheduled}
            </div>
            <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
              {campaignReport.steps.map((s, i) => (
                <li key={i}>{s.step}: {s.status}{s.count != null ? ` (${s.count})` : ''}{s.error ? ` — ${s.error}` : ''}</li>
              ))}
            </ul>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <Link className="lf-btn lf-btn-primary" to="/app/ai-agent">Review drafts →</Link>
              <Link className="lf-btn" to="/app/automations">Automations</Link>
              <Link className="lf-btn" to="/app">Dashboard</Link>
            </div>
          </div>
        )}
      </div>

      {/* KPI Cards */}
      <div className="lf-kpi-grid">
        <div className="lf-card-premium">
          <div className="lf-card-accent" />
          <div className="lf-kpi-icon-wrap lf-kpi-icon-cyan">⌕</div>
          <div className="lf-kpi-value-premium">{totalFound.toLocaleString()}</div>
          <div className="lf-kpi-label-premium">Leads Found</div>
        </div>
        <div className="lf-card-premium lf-card-emerald">
          <div className="lf-card-accent" />
          <div className="lf-kpi-icon-wrap lf-kpi-icon-emerald">↓</div>
          <div className="lf-kpi-value-premium">{totalSaved.toLocaleString()}</div>
          <div className="lf-kpi-label-premium">Leads Imported</div>
        </div>
        <div className="lf-card-premium lf-card-gold">
          <div className="lf-card-accent" />
          <div className="lf-kpi-icon-wrap lf-kpi-icon-amber">◈</div>
          <div className="lf-kpi-value-premium">{totalDups.toLocaleString()}</div>
          <div className="lf-kpi-label-premium">Duplicates Removed</div>
        </div>
        <div className="lf-card-premium lf-card-purple">
          <div className="lf-card-accent" />
          <div className="lf-kpi-icon-wrap lf-kpi-icon-purple">◷</div>
          <div className="lf-kpi-value-premium">{history.length}</div>
          <div className="lf-kpi-label-premium">Search History</div>
        </div>
      </div>

      {/* SerpAPI Configuration — always accessible */}
      {showConfig || setupRequired || !configured ? (
        <SerpAPISetupCard onConfigured={handleConfigured} />
      ) : (
        <div className="lf-card-premium lf-card-cyan" style={{ marginBottom: 20 }}>
          <div className="lf-card-accent" />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="lf-kpi-icon-wrap lf-kpi-icon-cyan" style={{ marginBottom: 0 }}>⚡</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>SerpAPI Connected</div>
                <div style={{ fontSize: 13, color: 'var(--lf-text-secondary)' }}>Your API key is saved and ready for scraping.</div>
              </div>
            </div>
            <button className="lf-btn" onClick={() => setShowConfig(true)}>Update Key</button>
          </div>
        </div>
      )}

      {/* Premium Search Form */}
      <div className="lf-card-premium" style={{ marginBottom: 20 }}>
        <div className="lf-card-accent" />
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Search Businesses</div>
        <form onSubmit={onSubmit} className="scraper-form">
          <div className="scraper-field">
            <label>Business Type / Niche</label>
            <input className="scraper-input" placeholder="e.g. Dentist, Lawyer, Gym" value={keyword} onChange={(e) => setKeyword(e.target.value)} disabled={loading} />
          </div>
          <div className="scraper-field">
            <label>Location</label>
            <input className="scraper-input" placeholder="e.g. Kuala Lumpur" value={location} onChange={(e) => setLocation(e.target.value)} disabled={loading} />
          </div>
          <div className="scraper-field" style={{ flex: '0 0 140px' }}>
            <label>Scope</label>
            <select className="scraper-input" value={scope} onChange={(e) => setScope(e.target.value as 'city' | 'state' | 'country')} disabled={loading}>
              <option value="city">City</option>
              <option value="state">State</option>
              <option value="country">Country</option>
            </select>
          </div>
          <div className="scraper-field" style={{ flex: '0 0 120px' }}>
            <label>Max Results</label>
            <select className="scraper-input" value={limit} onChange={(e) => setLimit(Number(e.target.value))} disabled={loading}>
              {LIMIT_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <button className="scraper-search-btn" type="submit" disabled={loading || !keyword.trim() || !location.trim()}>
            {loading ? <><span className="scraper-spinner" />Searching…</> : <><span style={{ fontSize: 16 }}>⌕</span> Search</>}
          </button>
        </form>
        <div className="scraper-meta">
          Scope: <strong>{SCOPE_LABELS[scope]}</strong> — Searching for “{keyword || '…'}” in “{location || '…'}” {scope !== 'country' ? `(${SCOPE_LABELS[scope]} level)` : ''} · Max {limit} results
        </div>
      </div>

      {loading && (
        <div className="lf-note" style={{ marginTop: 12 }}>
          Searching Google Maps for “{keyword}” in “{location}” ({SCOPE_LABELS[scope]} scope, up to {limit} results) — this can take a minute while we paginate, de-duplicate, and extract emails.
        </div>
      )}

      {error && !setupRequired && <div className="lf-alert lf-alert-error">{error}</div>}

      {/* Results */}
      {result && !loading && (
        <>
          <div className="lf-alert lf-alert-success">
            Saved <strong>{result.savedCount}</strong> new lead{result.savedCount === 1 ? '' : 's'} from “{result.keyword}” in “{result.location}” ({SCOPE_LABELS[result.scope]} scope).
            {result.totalScraped} found{duplicates > 0 ? `, ${duplicates} duplicate${duplicates === 1 ? '' : 's'} removed` : ''}.
          </div>

          {result.leads.length > 0 ? (
            <div className="lf-card lf-table-wrap">
              <table className="lf-table">
                <thead>
                  <tr>
                    <th>Business Name</th>
                    <th>Phone</th>
                    <th>Email</th>
                    <th>Website</th>
                    <th>Full Address</th>
                    <th>City</th>
                    <th>Rating</th>
                    <th>Reviews</th>
                  </tr>
                </thead>
                <tbody>
                  {result.leads.map((l) => (
                    <tr key={l.id}>
                      <td style={{ fontWeight: 600 }}>{l.name || '—'}</td>
                      <td>{l.phone && l.phone !== 'N/A' ? l.phone : '—'}</td>
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
                          <a className="lf-contact-link" href={l.website} target="_blank" rel="noreferrer">{l.website.replace(/^https?:\/\//, '').slice(0, 28)}{l.website.length > 31 ? '…' : ''}</a>
                        ) : (
                          <span className="lf-contact-muted">—</span>
                        )}
                      </td>
                      <td style={{ maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={l.address || undefined}>
                        <span className="lf-contact-text">{l.address || '—'}</span>
                      </td>
                      <td><span className="lf-pill">{l.city || '—'}</span></td>
                      <td>{l.rating ? <span style={{ color: '#fbbf24', fontWeight: 700 }}>★ {l.rating}</span> : '—'}</td>
                      <td>{l.reviews ? l.reviews.toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="lf-empty">
              <p className="lf-empty-text">No new leads were added — every match was already in your workspace, or the search returned nothing. Try a different niche or location.</p>
            </div>
          )}
        </>
      )}

      {/* Search History */}
      {history.length > 0 ? (
        <div className="lf-card-premium" style={{ marginTop: 20 }}>
          <div className="lf-card-accent" />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Recent Searches</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="lf-btn" onClick={() => setShowHistoryDeleteConfirm(true)} disabled={deletingHistory}>
                Delete All
              </button>
              {selectedHistory.size > 0 && (
                <button className="lf-btn lf-btn-danger" onClick={() => setShowHistoryDeleteConfirm(true)} disabled={deletingHistory}>
                  Delete Selected ({selectedHistory.size})
                </button>
              )}
            </div>
          </div>
          {showHistoryDeleteConfirm && (
            <div className="lf-alert lf-alert-warning" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
              <div>
                <strong>Confirm Deletion</strong>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  {selectedHistory.size > 0
                    ? `Are you sure you want to delete ${selectedHistory.size} selected search${selectedHistory.size === 1 ? '' : 'es'}?`
                    : 'Are you sure you want to delete all search history?'}
                  <div style={{ fontSize: 12, color: 'var(--lf-muted)', marginTop: 2 }}>This will not delete your leads.</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="lf-btn" onClick={() => setShowHistoryDeleteConfirm(false)} disabled={deletingHistory}>
                  Cancel
                </button>
                <button
                  className="lf-btn lf-btn-danger"
                  onClick={selectedHistory.size > 0 ? handleDeleteHistorySelected : handleDeleteHistoryAll}
                  disabled={deletingHistory}
                >
                  {deletingHistory ? 'Deleting…' : 'Confirm Delete'}
                </button>
              </div>
            </div>
          )}
          <table className="lf-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}><input type="checkbox" checked={history.length > 0 && selectedHistory.size === history.length} onChange={toggleHistoryAll} /></th>
                <th>Keyword</th>
                <th>Location</th>
                <th>Scope</th>
                <th>Imported</th>
                <th>Found</th>
                <th>When</th>
                <th style={{ width: 200 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i} className="lf-history-row">
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selectedHistory.has(i)} onChange={() => toggleHistorySelect(i)} /></td>
                  <td style={{ fontWeight: 600 }}>{h.keyword}</td>
                  <td>{h.location}</td>
                  <td><span className="lf-pill">{SCOPE_LABELS[h.scope]}</span></td>
                  <td><span style={{ color: '#34d399', fontWeight: 700 }}>{h.savedCount}</span></td>
                  <td>{h.totalScraped}</td>
                  <td style={{ fontSize: 12, color: 'var(--lf-muted)' }}>{new Date(h.timestamp).toLocaleString()}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Link
                        className="lf-btn lf-btn-primary"
                        style={{ height: 28, padding: '0 10px', fontSize: 11 }}
                        to={`/app/leads?keyword=${encodeURIComponent(h.keyword)}&location=${encodeURIComponent(h.location)}&scope=${h.scope}`}
                      >
                        View Leads
                      </Link>
                      <button
                        className="lf-btn"
                        style={{ height: 28, padding: '0 10px', fontSize: 11 }}
                        onClick={() => replaySearch(h)}
                        disabled={loading}
                      >
                        Re-Run
                      </button>
                      <button
                        className="lf-btn lf-btn-danger"
                        style={{ height: 28, padding: '0 8px', fontSize: 11 }}
                        onClick={(e) => handleDeleteSingleHistory(i, e)}
                        disabled={deletingHistory}
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="lf-card-premium" style={{ marginTop: 20 }}>
          <div className="lf-card-accent" />
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Recent Searches</div>
          <div className="lf-empty">
            <p className="lf-empty-text">No search history yet. Start a new search to see your history here.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function SerpAPISetupCard({ onConfigured }: { onConfigured: () => void }) {
  const [step, setStep] = useState(1);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setSaving(true);
    setSaveError(null);
    try {
      await setScraperConfig(key);
      onConfigured();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="lf-card-premium lf-card-cyan" style={{ marginBottom: 20 }}>
      <div className="lf-card-accent" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div className="lf-kpi-icon-wrap lf-kpi-icon-cyan" style={{ marginBottom: 0 }}>⚡</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Connect SerpAPI</div>
          <div style={{ fontSize: 13, color: 'var(--lf-text-secondary)' }}>Unlock Google Maps scraping with a few simple steps</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {[1, 2, 3].map((s) => (
          <div key={s} style={{ flex: 1, height: 4, borderRadius: 4, background: s <= step ? 'linear-gradient(90deg, #22d3ee, #6366f1)' : 'rgba(30, 41, 59, 0.5)' }} />
        ))}
      </div>

      {step === 1 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Step 1: Create a SerpAPI Account</div>
          <p style={{ fontSize: 13, color: 'var(--lf-text-secondary)', marginBottom: 16 }}>
            SerpAPI provides the Google Maps data we need. Start with their free tier (100 searches/month).
          </p>
          <a className="lf-btn lf-btn-primary" href="https://serpapi.com/users/sign_up" target="_blank" rel="noreferrer">Create Free Account →</a>
          <button className="lf-btn" style={{ marginLeft: 8 }} onClick={() => setStep(2)}>I already have an account</button>
        </div>
      )}

      {step === 2 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Step 2: Get Your API Key</div>
          <p style={{ fontSize: 13, color: 'var(--lf-text-secondary)', marginBottom: 16 }}>
            Log in to SerpAPI, go to your dashboard, and copy your API Key.
          </p>
          <a className="lf-btn lf-btn-primary" href="https://serpapi.com/dashboard" target="_blank" rel="noreferrer">Open Dashboard →</a>
          <button className="lf-btn" style={{ marginLeft: 8 }} onClick={() => setStep(3)}>I have my API key</button>
        </div>
      )}

      {step === 3 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Step 3: Connect API Key</div>
          <p style={{ fontSize: 13, color: 'var(--lf-text-secondary)', marginBottom: 12 }}>
            Paste your API key below. It will be saved to your backend configuration.
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input className="lf-input" style={{ flex: 1 }} placeholder="serp_api_..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <button className="lf-btn lf-btn-primary" onClick={handleSave} disabled={saving || !apiKey.trim()}>
              {saving ? 'Saving…' : 'Save Key'}
            </button>
          </div>
          {saveError && <div className="lf-alert lf-alert-error" style={{ marginBottom: 8 }}>{saveError}</div>}
          <div style={{ fontSize: 12, color: 'var(--lf-muted)' }}>
            Advanced: You can also set the <code>SERPAPI_KEY</code> environment variable directly on your server and restart.
          </div>
        </div>
      )}
    </div>
  );
}
