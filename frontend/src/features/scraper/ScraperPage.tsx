import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import PageHeader from '../common/PageHeader';
import { scrapeLeads, Lead } from '../../lib/apiClient';

interface ScrapeOutcome {
  savedCount: number;
  totalScraped: number;
  leads: Lead[];
}

export default function ScraperPage() {
  const [keyword, setKeyword] = useState('');
  const [location, setLocation] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [result, setResult] = useState<ScrapeOutcome | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!keyword.trim() || !location.trim() || loading) return;
    setLoading(true);
    setError(null);
    setSetupRequired(false);
    try {
      const res = await scrapeLeads(keyword.trim(), location.trim());
      setResult({ savedCount: res.savedCount, totalScraped: res.totalScraped, leads: res.leads });
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { error?: string; setupRequired?: boolean } | undefined;
        if (data?.setupRequired || err.response?.status === 503) {
          setSetupRequired(true);
        }
        setError(data?.error || err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Search failed');
      }
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const duplicates = result ? Math.max(0, result.totalScraped - result.savedCount) : 0;

  return (
    <div className="lf-page">
      <PageHeader
        title="Scraper"
        subtitle="Find businesses on Google Maps and capture them as leads"
        actions={
          <Link className="lf-btn" to="/app/leads">
            View all leads →
          </Link>
        }
      />

      <div className="lf-note">
        Searches Google Maps via SerpAPI and saves matching businesses straight into your workspace —
        deduplicated against leads you already have. Qualify them next in the{' '}
        <Link className="lf-link" to="/app/ai-agent">AI Agent</Link>.
      </div>

      <form className="lf-toolbar" onSubmit={onSubmit}>
        <input
          className="lf-input"
          style={{ flex: '1 1 220px' }}
          placeholder="Niche / keyword (e.g. dentist)"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          disabled={loading}
        />
        <input
          className="lf-input"
          style={{ flex: '1 1 220px' }}
          placeholder="Location (e.g. Austin, TX)"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          disabled={loading}
        />
        <button className="lf-btn lf-btn-primary" type="submit" disabled={loading || !keyword.trim() || !location.trim()}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {loading && (
        <div className="lf-note" style={{ marginTop: 12 }}>
          Searching Google Maps for “{keyword}” in “{location}” — this can take up to a minute while
          we page through and de-duplicate results.
        </div>
      )}

      {error && (
        <div className="lf-alert lf-alert-error">
          {setupRequired ? (
            <>
              Scraping isn’t configured on this backend. An admin needs to set the{' '}
              <code>SERPAPI_KEY</code> environment variable, then restart the server.
            </>
          ) : (
            error
          )}
        </div>
      )}

      {result && !loading && (
        <>
          <div className="lf-alert lf-alert-success">
            Saved <strong>{result.savedCount}</strong> new lead{result.savedCount === 1 ? '' : 's'} to your
            workspace ({result.totalScraped} found{duplicates > 0 ? `, ${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped` : ''}).
          </div>

          {result.leads.length > 0 ? (
            <div className="lf-card lf-table-wrap">
              <table className="lf-table">
                <thead>
                  <tr><th>Name</th><th>Phone</th><th>Website</th><th>City</th><th>Rating</th><th>Reviews</th></tr>
                </thead>
                <tbody>
                  {result.leads.map((l) => (
                    <tr key={l.id}>
                      <td>{l.name || '—'}</td>
                      <td>{l.phone && l.phone !== 'N/A' ? l.phone : '—'}</td>
                      <td>
                        {l.website && l.website !== 'N/A' ? (
                          <a className="lf-link" href={l.website} target="_blank" rel="noreferrer">site</a>
                        ) : '—'}
                      </td>
                      <td>{l.city || '—'}</td>
                      <td>{l.rating ?? '—'}</td>
                      <td>{l.reviews ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="lf-empty">
              <p className="lf-empty-text">
                No new leads were added — every match was already in your workspace, or the search
                returned nothing. Try a different niche or location.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
