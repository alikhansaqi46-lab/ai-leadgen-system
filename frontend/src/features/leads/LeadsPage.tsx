import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../common/PageHeader';
import { getLeads, getFilters, exportLeadsUrl, Lead, FiltersResponse } from '../../lib/apiClient';

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filters, setFilters] = useState<FiltersResponse>({ countries: [], niches: [] });
  const [country, setCountry] = useState('');
  const [niche, setNiche] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        const [leadsRes, filtersRes] = await Promise.all([
          getLeads({ country: country || undefined, niche: niche || undefined, limit: 1000 }),
          getFilters(),
        ]);
        if (active) {
          setLeads(leadsRes.leads);
          setFilters(filtersRes);
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

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((l) =>
      [l.name, l.phone, l.email, l.city, l.niche].some((v) => (v || '').toString().toLowerCase().includes(q)),
    );
  }, [leads, search]);

  return (
    <div className="lf-page">
      <PageHeader
        title="Leads"
        subtitle={`${visible.length} of ${leads.length} leads`}
        actions={
          <a className="lf-btn lf-btn-primary" href={exportLeadsUrl({ country: country || undefined, niche: niche || undefined })}>
            Export CSV
          </a>
        }
      />

      <div className="lf-toolbar">
        <input className="lf-input" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="lf-input" value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">All countries</option>
          {filters.countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="lf-input" value={niche} onChange={(e) => setNiche(e.target.value)}>
          <option value="">All niches</option>
          {filters.niches.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      <div className="lf-note">
        Read-only view powered by the new typed API client. Full management (bulk delete, edit,
        campaigns) lives in <Link className="lf-link" to="/app/workspace">Workspace (Classic)</Link> and
        migrates here in S4.
      </div>

      {loading && <div className="lf-card lf-skeleton" style={{ height: 240 }} />}
      {error && <div className="lf-alert lf-alert-error">{error}</div>}

      {!loading && !error && (
        <div className="lf-card lf-table-wrap">
          <table className="lf-table">
            <thead>
              <tr><th>Name</th><th>Phone</th><th>Email</th><th>City</th><th>Country</th><th>Niche</th><th>Source</th></tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={7} className="lf-muted" style={{ textAlign: 'center', padding: 24 }}>No leads match.</td></tr>
              ) : (
                visible.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name || '—'}</td>
                    <td>{l.phone || '—'}</td>
                    <td>{l.email || '—'}</td>
                    <td>{l.city || '—'}</td>
                    <td>{l.country || '—'}</td>
                    <td>{l.niche || '—'}</td>
                    <td>{l.source || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
