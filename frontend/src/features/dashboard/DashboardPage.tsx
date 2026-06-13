import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../common/PageHeader';
import { getLeads, getFilters, Lead, FiltersResponse } from '../../lib/apiClient';

interface Kpis {
  total: number;
  countries: number;
  niches: number;
  withWhatsapp: number;
  recent: Lead[];
}

function computeKpis(leads: Lead[], filters: FiltersResponse): Kpis {
  return {
    total: leads.length,
    countries: filters.countries?.length || 0,
    niches: filters.niches?.length || 0,
    withWhatsapp: leads.filter((l) => Boolean(l.whatsapp || l.phone)).length,
    recent: leads.slice(0, 5),
  };
}

export default function DashboardPage() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        const [leadsRes, filters] = await Promise.all([getLeads({ limit: 1000 }), getFilters()]);
        if (active) setKpis(computeKpis(leadsRes.leads, filters));
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="lf-page">
      <PageHeader
        title="Dashboard"
        subtitle="Overview of your lead pipeline"
        actions={
          <Link className="lf-btn lf-btn-primary" to="/app/scraper">
            + Find leads
          </Link>
        }
      />

      {loading && <div className="lf-skeleton-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="lf-card lf-skeleton" />)}</div>}
      {error && <div className="lf-alert lf-alert-error">{error}</div>}

      {kpis && !loading && (
        <>
          <div className="lf-kpi-grid">
            <KpiCard label="Total leads" value={kpis.total} />
            <KpiCard label="Countries" value={kpis.countries} />
            <KpiCard label="Niches" value={kpis.niches} />
            <KpiCard label="Reachable (phone/WA)" value={kpis.withWhatsapp} />
          </div>

          <div className="lf-card">
            <div className="lf-card-header">
              <h2 className="lf-card-title">Recent leads</h2>
              <Link className="lf-link" to="/app/leads">View all →</Link>
            </div>
            {kpis.recent.length === 0 ? (
              <p className="lf-muted">No leads yet. Start with the Scraper to capture businesses.</p>
            ) : (
              <table className="lf-table">
                <thead>
                  <tr><th>Name</th><th>City</th><th>Niche</th><th>Source</th></tr>
                </thead>
                <tbody>
                  {kpis.recent.map((l) => (
                    <tr key={l.id}>
                      <td>{l.name || '—'}</td>
                      <td>{l.city || '—'}</td>
                      <td>{l.niche || '—'}</td>
                      <td>{l.source || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="lf-card lf-kpi">
      <div className="lf-kpi-value">{value.toLocaleString()}</div>
      <div className="lf-kpi-label">{label}</div>
    </div>
  );
}
