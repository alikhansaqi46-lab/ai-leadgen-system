import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from 'react';
import {
  bulkIntelligenceEventAction,
  bulkIntelligenceLibraryAction,
  createIntelligenceLaunchDraft,
  deleteIntelligenceTestData,
  getAdminCampaignIntelligence,
  getAdminIntelligence,
  getIntelligenceFacets,
  getIntelligenceLaunchOutcomes,
  getIntelligenceWorkspaces,
  intelligenceEventAction,
  intelligenceLibraryAction,
  launchIntelligenceDraft,
  listIntelligenceLaunchDrafts,
  recomputeIntelligenceScores,
  scanAdminIntelligence,
  updateIntelligenceLaunchDraft,
  type IntelFilters,
} from '../../lib/adminApi';
import { BarChart } from './saCharts';

type PanelProps = {
  icon?: string;
  title: string;
  desc?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  panelRef?: RefObject<HTMLDivElement>;
};

function SectionPanel({ icon, title, desc, actions, children, className, id, panelRef }: PanelProps) {
  return (
    <div id={id} ref={panelRef} className={`sa-card panel${className ? ` ${className}` : ''}`}>
      <div className="sa-section-head">
        <div>
          <h3 className="sa-section-title">{icon ? <span className="sa-ico">{icon}</span> : null}{title}</h3>
          {desc ? <p className="sa-section-desc">{desc}</p> : null}
        </div>
        {actions ? <div className="sa-toolbar">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

function KpiCard({ icon, label, value, tone = 'blue' }: { icon: string; label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={`sa-card sa-kpi-card tone-${tone}`}>
      <div className="sa-kpi-top">
        <div className="sa-kpi-icon">{icon}</div>
      </div>
      <div className="sa-kpi">{value}</div>
      <div className="sa-kpi-label">{label}</div>
    </div>
  );
}

function scoreTone(score: number) {
  if (score >= 9) return 'ok';
  if (score >= 8) return 'info';
  if (score >= 6.5) return 'warn';
  return 'bad';
}

function ScoreBadge({ score, label }: { score?: number; label?: string }) {
  const s = Number(score) || 0;
  return (
    <span className={`sa-pill sa-score ${scoreTone(s)}`} title={label || ''}>
      {s.toFixed(1)} / 10{label ? ` · ${label}` : ''}
    </span>
  );
}

type Props = {
  busy: string;
  run: (label: string, fn: () => Promise<void>) => void;
  setMsg: (m: string) => void;
  setError: (m: string) => void;
  externalOpenId?: string | null;
  onExternalOpenConsumed?: () => void;
};

const EMPTY_FILTERS: IntelFilters = {
  q: '',
  industry: '',
  country: '',
  workspace: '',
  channel: '',
  status: '',
  sort: 'score_desc',
  showTest: true,
  showArchived: false,
  page: 1,
  pageSize: 25,
};

export default function OwnerIntelligencePanel({
  busy, run, setMsg, setError, externalOpenId, onExternalOpenConsumed,
}: Props) {
  const [filters, setFilters] = useState<IntelFilters>({ ...EMPTY_FILTERS });
  const [filterOpen, setFilterOpen] = useState(false);
  const [intelEvents, setIntelEvents] = useState<any[]>([]);
  const [intelPatterns, setIntelPatterns] = useState<any>(null);
  const [intelFeed, setIntelFeed] = useState<any[]>([]);
  const [intelLibrary, setIntelLibrary] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [libraryTotalPages, setLibraryTotalPages] = useState(1);
  const [libraryItem, setLibraryItem] = useState<any>(null);
  const [campaignDetail, setCampaignDetail] = useState<any>(null);
  const [intelFlash, setIntelFlash] = useState<'campaign' | 'library' | 'recs' | 'track' | null>(null);
  const [intelFocusNonce, setIntelFocusNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [wizard, setWizard] = useState<null | {
    step: number;
    libraryId: string;
    draftId?: string;
    channel: string;
    workspaceId: string;
    name: string;
    subject: string;
    body: string;
    adaptNotes: string;
  }>(null);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [serverFacets, setServerFacets] = useState<{
    industries: string[]; countries: string[]; workspaces: string[]; channels: string[];
  }>({ industries: [], countries: [], workspaces: [], channels: [] });
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);
  const [launchDrafts, setLaunchDrafts] = useState<any[]>([]);
  const [trackOutcome, setTrackOutcome] = useState<any>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const campaignIntelRef = useRef<HTMLDivElement>(null);
  const libraryDetailRef = useRef<HTMLDivElement>(null);
  const recsRef = useRef<HTMLDivElement>(null);
  const pendingIntelFocus = useRef<'campaign' | 'library' | 'recs' | 'track' | null>(null);
  const intelFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleIntelFocus = useCallback((target: 'campaign' | 'library' | 'recs' | 'track') => {
    pendingIntelFocus.current = target;
    setIntelFocusNonce((n) => n + 1);
  }, []);

  const apiParams = useMemo((): IntelFilters => {
    const p: IntelFilters = {
      sort: filters.sort || 'score_desc',
      page: filters.page || 1,
      pageSize: filters.pageSize || 25,
      showTest: filters.showTest === false || filters.showTest === 'false' ? 'false' : 'true',
      showArchived: filters.showArchived === true || filters.showArchived === 'true' ? 'true' : 'false',
    };
    if (filters.q) p.q = String(filters.q);
    if (filters.industry) p.industry = String(filters.industry);
    if (filters.country) p.country = String(filters.country);
    if (filters.workspace) p.workspace = String(filters.workspace);
    if (filters.channel) p.channel = String(filters.channel);
    if (filters.status) p.status = String(filters.status);
    if (filters.pinned === true || filters.pinned === 'true') p.pinned = 'true';
    if (filters.minRevenue !== '' && filters.minRevenue != null) p.minRevenue = filters.minRevenue;
    if (filters.minConversion !== '' && filters.minConversion != null) p.minConversion = filters.minConversion;
    if (filters.minScore !== '' && filters.minScore != null) p.minScore = filters.minScore;
    if (filters.minReplyRate !== '' && filters.minReplyRate != null) p.minReplyRate = filters.minReplyRate;
    if (filters.minAppointments !== '' && filters.minAppointments != null) p.minAppointments = filters.minAppointments;
    if (filters.minLeadQuality !== '' && filters.minLeadQuality != null) p.minLeadQuality = filters.minLeadQuality;
    if (filters.dateFrom) p.dateFrom = String(filters.dateFrom);
    if (filters.dateTo) p.dateTo = String(filters.dateTo);
    return p;
  }, [filters]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [intel, facets, drafts] = await Promise.all([
        getAdminIntelligence(apiParams),
        getIntelligenceFacets().catch(() => null),
        listIntelligenceLaunchDrafts({ limit: 40 }).catch(() => ({ drafts: [] })),
      ]);
      setIntelEvents(intel.events || []);
      setIntelPatterns(intel.patterns || null);
      const filteredFeed = (intel.events || []).map((e: any) => ({
        id: e.id,
        title: e.title,
        customerName: e.customer_name || e.customer_email || e.workspace_id,
        country: e.country,
        niche: e.industry,
        campaignType: e.campaign_name || e.event_type,
        eventType: e.event_type,
        revenue: Number(e.revenue) || 0,
        dealValue: Number(e.metrics?.dealValue ?? e.revenue) || 0,
        leadCount: e.lead_count,
        replies: e.replies,
        conversionRate: Number(e.conversion_rate) || 0,
        channel: e.channel,
        aiScore: e.ai_score,
        scoreLabel: e.score_label,
        pinned: e.pinned,
        isTest: e.is_test,
        winningMessages: e.metrics?.winningMessages || [],
      }));
      setIntelFeed(filteredFeed.length ? filteredFeed : (intel.feed || []));
      setIntelLibrary(intel.library || []);
      setTotal(intel.total || 0);
      setPage(intel.page || 1);
      setTotalPages(intel.totalPages || 1);
      setLibraryTotal(intel.libraryTotal ?? (intel.library || []).length);
      setLibraryTotalPages(intel.libraryTotalPages || Math.max(1, Math.ceil((intel.libraryTotal ?? (intel.library || []).length) / (Number(apiParams.pageSize) || 25))));
      if (facets) {
        setServerFacets({
          industries: facets.industries || [],
          countries: facets.countries || [],
          workspaces: facets.workspaces || [],
          channels: facets.channels || [],
        });
      }
      setLaunchDrafts(drafts.drafts || []);
      setSelectedEventIds([]);
      setSelectedLibraryIds([]);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load intelligence');
    } finally {
      setLoading(false);
    }
  }, [apiParams, setError]);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => { void refresh(); }, 180);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [refresh]);

  const openCampaignIntelligence = useCallback(async (successEventId: string) => {
    if (!successEventId) return;
    setLoading(true);
    setError('');
    try {
      const detail = await getAdminCampaignIntelligence(successEventId);
      setCampaignDetail(detail);
      scheduleIntelFocus('campaign');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load campaign intelligence');
    } finally {
      setLoading(false);
    }
  }, [scheduleIntelFocus, setError]);

  useEffect(() => {
    if (!externalOpenId) return;
    void openCampaignIntelligence(externalOpenId).then(() => onExternalOpenConsumed?.());
  }, [externalOpenId, openCampaignIntelligence, onExternalOpenConsumed]);

  const openLibraryItem = useCallback((item: any) => {
    if (!item) return;
    setLibraryItem(item);
    scheduleIntelFocus('library');
  }, [scheduleIntelFocus]);

  useEffect(() => {
    if (!pendingIntelFocus.current) return;
    const target = pendingIntelFocus.current;
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (pendingIntelFocus.current !== target) return;
        const el = target === 'campaign'
          ? campaignIntelRef.current
          : target === 'library'
            ? libraryDetailRef.current
            : target === 'track'
              ? trackRef.current
              : recsRef.current;
        pendingIntelFocus.current = null;
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (intelFlashTimer.current) clearTimeout(intelFlashTimer.current);
        setIntelFlash(target);
        intelFlashTimer.current = setTimeout(() => {
          setIntelFlash(null);
          intelFlashTimer.current = null;
        }, 1600);
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [campaignDetail, libraryItem, intelFocusNonce, wizard, trackOutcome]);

  useEffect(() => () => {
    if (intelFlashTimer.current) clearTimeout(intelFlashTimer.current);
  }, []);

  const patchFilter = (patch: Partial<IntelFilters>) => {
    setFilters((f) => ({ ...f, ...patch, page: patch.page != null ? patch.page : 1 }));
  };

  const lifecycleEvent = (id: string, action: string) => {
    if (action === 'delete') {
      if (!window.confirm('Permanently delete this success event and its library entry?')) return;
    }
    run(`${action} event`, async () => {
      await intelligenceEventAction(id, action, action === 'delete' ? { confirm: true } : undefined);
      if (action === 'delete' && campaignDetail?.successEvent?.id === id) setCampaignDetail(null);
      setMsg(`Campaign ${action} complete`);
      await refresh();
    });
  };

  const lifecycleLibrary = (id: string, action: string) => {
    if (action === 'delete') {
      if (!window.confirm('Permanently delete this library campaign?')) return;
    }
    run(`${action} library`, async () => {
      await intelligenceLibraryAction(id, action, action === 'delete' ? { confirm: true } : undefined);
      if (action === 'delete' && libraryItem?.id === id) setLibraryItem(null);
      setMsg(`Library item ${action} complete`);
      await refresh();
    });
  };

  const bulkEvents = (action: string) => {
    if (!selectedEventIds.length) return;
    if (action === 'delete' && !window.confirm(`Permanently delete ${selectedEventIds.length} success events?`)) return;
    run(`Bulk ${action} events`, async () => {
      await bulkIntelligenceEventAction(selectedEventIds, action, action === 'delete');
      setMsg(`Bulk ${action}: ${selectedEventIds.length} events`);
      await refresh();
    });
  };

  const bulkLibrary = (action: string) => {
    if (!selectedLibraryIds.length) return;
    if (action === 'delete' && !window.confirm(`Permanently delete ${selectedLibraryIds.length} library items?`)) return;
    run(`Bulk ${action} library`, async () => {
      await bulkIntelligenceLibraryAction(selectedLibraryIds, action, action === 'delete');
      setMsg(`Bulk ${action}: ${selectedLibraryIds.length} library items`);
      await refresh();
    });
  };

  const openTrackResults = async (draftId: string) => {
    setLoading(true);
    try {
      const res = await getIntelligenceLaunchOutcomes(draftId);
      setTrackOutcome(res);
      scheduleIntelFocus('track');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load launch outcomes');
    } finally {
      setLoading(false);
    }
  };

  const toggleEventSel = (id: string) => {
    setSelectedEventIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleLibSel = (id: string) => {
    setSelectedLibraryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const startLaunchWizard = (item: any) => {
    run('Open launch wizard', async () => {
      const ws = await getIntelligenceWorkspaces();
      setWorkspaces(ws.workspaces || []);
      const draftRes = await createIntelligenceLaunchDraft(item.id, {
        channel: item.channel || 'email',
        name: `${item.name || 'Campaign'} (launch)`,
      });
      const d = draftRes.draft;
      setWizard({
        step: 1,
        libraryId: item.id,
        draftId: d.id,
        channel: d.channel || 'email',
        workspaceId: d.target_workspace_id || '',
        name: d.name || '',
        subject: d.subject || '',
        body: d.body || '',
        adaptNotes: d.settings?.adaptNotes || '',
      });
      setLibraryItem(item);
      scheduleIntelFocus('library');
    });
  };

  const saveWizardStep = async (nextStep?: number) => {
    if (!wizard?.draftId) return;
    const res = await updateIntelligenceLaunchDraft(wizard.draftId, {
      channel: wizard.channel,
      targetWorkspaceId: wizard.workspaceId || null,
      name: wizard.name,
      subject: wizard.subject,
      body: wizard.body,
      settings: { adaptNotes: wizard.adaptNotes || '' },
    });
    const d = res.draft;
    setWizard((w) => w ? {
      ...w,
      step: nextStep ?? w.step,
      channel: d.channel,
      workspaceId: d.target_workspace_id || '',
      name: d.name || '',
      subject: d.subject || '',
      body: d.body || '',
      adaptNotes: d.settings?.adaptNotes || w.adaptNotes || '',
    } : w);
  };

  const recs = campaignDetail?.recommendations
    || libraryItem?.recommendations
    || null;

  const filterFacets = useMemo(() => {
    const industries = new Set<string>(serverFacets.industries);
    const countries = new Set<string>(serverFacets.countries);
    const workspacesSet = new Set<string>(serverFacets.workspaces);
    for (const e of intelEvents) {
      if (e.industry) industries.add(e.industry);
      if (e.country) countries.add(e.country);
      if (e.workspace_id) workspacesSet.add(e.workspace_id);
    }
    for (const i of intelLibrary) {
      if (i.industry) industries.add(i.industry);
      if (i.country) countries.add(i.country);
      if (i.workspace_id) workspacesSet.add(i.workspace_id);
    }
    return {
      industries: Array.from(industries).sort(),
      countries: Array.from(countries).sort(),
      workspaces: Array.from(workspacesSet).sort(),
      channels: serverFacets.channels.length
        ? serverFacets.channels
        : ['email', 'whatsapp', 'sms', 'multi'],
    };
  }, [intelEvents, intelLibrary, serverFacets]);

  return (
    <>
      <div className="sa-intel-workflow">
        <span>Notify</span><span>→</span>
        <span>Open</span><span>→</span>
        <span>Analyze</span><span>→</span>
        <span>Study</span><span>→</span>
        <span>Duplicate</span><span>→</span>
        <span>Launch</span><span>→</span>
        <span
          role="button"
          tabIndex={0}
          onClick={() => scheduleIntelFocus('track')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') scheduleIntelFocus('track'); }}
        >
          Track
        </span>
      </div>

      <div className="sa-actions" style={{ marginTop: 0, marginBottom: 14 }}>
        <button className="sa-btn primary" type="button" disabled={!!busy || loading} onClick={() => run('Intelligence scan', async () => {
          await scanAdminIntelligence();
          await refresh();
          setMsg('Success scan complete');
        })}>
          Run success scan now
        </button>
        <button className="sa-btn" type="button" disabled={!!busy || loading} onClick={() => run('Recompute AI scores', async () => {
          const res = await recomputeIntelligenceScores(1000);
          setMsg(`Recomputed ${res.updatedEvents || 0} events · ${res.updatedLibrary || 0} library rows`);
          await refresh();
        })}>
          Recompute scores
        </button>
        <button className="sa-btn" type="button" onClick={() => setFilterOpen((v) => !v)}>
          {filterOpen ? 'Hide filters' : 'Filters'}
        </button>
        <select
          className="sa-select"
          style={{ width: 180 }}
          value={String(filters.sort || 'score_desc')}
          onChange={(e) => patchFilter({ sort: e.target.value })}
        >
          <option value="score_desc">Highest AI Score</option>
          <option value="revenue_desc">Highest Revenue</option>
          <option value="conversion_desc">Highest Conversion</option>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
        </select>
        <select
          className="sa-select"
          style={{ width: 110 }}
          value={String(filters.pageSize || 25)}
          onChange={(e) => patchFilter({ pageSize: Number(e.target.value) || 25, page: 1 })}
        >
          <option value={10}>10 / page</option>
          <option value={25}>25 / page</option>
          <option value={50}>50 / page</option>
          <option value={100}>100 / page</option>
        </select>
        <label className="sa-check">
          <input
            type="checkbox"
            checked={filters.showTest !== false && filters.showTest !== 'false'}
            onChange={(e) => patchFilter({ showTest: e.target.checked })}
          />
          Show test data
        </label>
        <button
          className="sa-btn"
          type="button"
          disabled={!!busy}
          onClick={() => patchFilter({ showTest: false })}
        >
          Hide test data
        </button>
        <button
          className="sa-btn danger"
          type="button"
          disabled={!!busy}
          onClick={() => {
            if (!window.confirm('Delete all test / demo intelligence data? Production rows stay.')) return;
            run('Delete test data', async () => {
              const res = await deleteIntelligenceTestData(true);
              setMsg(`Deleted test events ${res.deletedEvents || 0}, library ${res.deletedLibrary || 0}`);
              await refresh();
            });
          }}
        >
          Delete test data
        </button>
        {campaignDetail && (
          <button className="sa-btn" type="button" onClick={() => setCampaignDetail(null)}>Close campaign detail</button>
        )}
        {libraryItem && (
          <button className="sa-btn" type="button" onClick={() => setLibraryItem(null)}>Close library item</button>
        )}
      </div>

      {(loading || (!!busy && (busy === 'Load campaign' || /duplicate|launch|pin|archive|ignore|delete|recompute|bulk|wizard|scan|track/i.test(busy)))) && (
        <div className="sa-alert info sa-intel-loading" role="status" aria-live="polite">
          Loading intelligence…
        </div>
      )}

      {filterOpen && (
        <SectionPanel icon="☰" title="Intelligence filters" desc="Results update instantly as you change filters.">
          <div className="sa-filter-grid">
            <input className="sa-input" placeholder="Search…" value={String(filters.q || '')} onChange={(e) => patchFilter({ q: e.target.value })} />
            <select className="sa-select" value={String(filters.industry || '')} onChange={(e) => patchFilter({ industry: e.target.value })}>
              <option value="">All industries</option>
              {filterFacets.industries.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select className="sa-select" value={String(filters.country || '')} onChange={(e) => patchFilter({ country: e.target.value })}>
              <option value="">All countries</option>
              {filterFacets.countries.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select className="sa-select" value={String(filters.workspace || '')} onChange={(e) => patchFilter({ workspace: e.target.value })}>
              <option value="">All workspaces</option>
              {filterFacets.workspaces.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select className="sa-select" value={String(filters.channel || '')} onChange={(e) => patchFilter({ channel: e.target.value })}>
              <option value="">All channels</option>
              {filterFacets.channels.map((x) => (
                <option key={x} value={x}>{x === 'multi' ? 'Multi' : x === 'whatsapp' ? 'WhatsApp' : x === 'sms' ? 'SMS' : x.charAt(0).toUpperCase() + x.slice(1)}</option>
              ))}
            </select>
            <select className="sa-select" value={String(filters.status || '')} onChange={(e) => patchFilter({ status: e.target.value })}>
              <option value="">Status: default</option>
              <option value="active">Active</option>
              <option value="pinned">Pinned</option>
              <option value="archived">Archived</option>
              <option value="ignored">Ignored</option>
            </select>
            <input className="sa-input" type="number" placeholder="Min revenue" value={filters.minRevenue ?? ''} onChange={(e) => patchFilter({ minRevenue: e.target.value })} />
            <input className="sa-input" type="number" placeholder="Min conversion %" value={filters.minConversion ?? ''} onChange={(e) => patchFilter({ minConversion: e.target.value })} />
            <input className="sa-input" type="number" placeholder="Min AI score" value={filters.minScore ?? ''} onChange={(e) => patchFilter({ minScore: e.target.value })} />
            <input className="sa-input" type="number" placeholder="Min reply rate" value={filters.minReplyRate ?? ''} onChange={(e) => patchFilter({ minReplyRate: e.target.value })} />
            <input className="sa-input" type="number" placeholder="Min appointments" value={filters.minAppointments ?? ''} onChange={(e) => patchFilter({ minAppointments: e.target.value })} />
            <input className="sa-input" type="number" placeholder="Min lead quality" value={filters.minLeadQuality ?? ''} onChange={(e) => patchFilter({ minLeadQuality: e.target.value })} />
            <input className="sa-input" type="date" value={String(filters.dateFrom || '')} onChange={(e) => patchFilter({ dateFrom: e.target.value })} />
            <input className="sa-input" type="date" value={String(filters.dateTo || '')} onChange={(e) => patchFilter({ dateTo: e.target.value })} />
            <label className="sa-check">
              <input type="checkbox" checked={filters.pinned === true || filters.pinned === 'true'} onChange={(e) => patchFilter({ pinned: e.target.checked || '' })} />
              Pinned only
            </label>
            <label className="sa-check">
              <input type="checkbox" checked={filters.showArchived === true || filters.showArchived === 'true'} onChange={(e) => patchFilter({ showArchived: e.target.checked, status: e.target.checked ? 'archived' : '' })} />
              Show archived
            </label>
            <button className="sa-btn" type="button" onClick={() => setFilters({ ...EMPTY_FILTERS })}>Reset filters</button>
          </div>
        </SectionPanel>
      )}

      <SectionPanel icon="✦" title="Success Feed" desc={`${intelFeed.length} on this page · ranked by current sort.`}>
        <div className="sa-notif-grid">
          {intelFeed.length === 0 && (
            <div className="sa-empty" style={{ gridColumn: '1 / -1' }}>
              <strong>No success events yet</strong>Run a scan after customers generate pipeline results.
            </div>
          )}
          {intelFeed.map((s: any) => (
            <div key={s.id} className="sa-notif-card sa-alert success" style={{ margin: 0, display: 'block' }}>
              <div className="cat">{s.eventType}{s.pinned ? ' · pinned' : ''}{s.isTest ? ' · test' : ''}</div>
              <strong>{s.customerName}</strong>
              <div style={{ marginTop: 6 }}><ScoreBadge score={s.aiScore} label={s.scoreLabel} /></div>
              <div className="sa-muted" style={{ marginTop: 6 }}>
                {s.country || '—'} · {s.niche || '—'} · {s.campaignType}
              </div>
              <div className="sa-muted" style={{ marginTop: 6 }}>
                Rev ${Number(s.revenue || 0).toLocaleString()} · Deal ${Number(s.dealValue || 0).toLocaleString()} · Leads {s.leadCount} · Replies {s.replies} · Conv {s.conversionRate}%
              </div>
              <div className="sa-actions">
                <button className="sa-btn primary" type="button" onClick={() => void openCampaignIntelligence(s.id)}>Analyze</button>
                <button className="sa-btn" type="button" onClick={() => lifecycleEvent(s.id, s.pinned ? 'unpin' : 'pin')}>{s.pinned ? 'Unpin' : 'Pin'}</button>
                <button className="sa-btn" type="button" onClick={() => lifecycleEvent(s.id, 'archive')}>Archive</button>
                <button className="sa-btn" type="button" onClick={() => lifecycleEvent(s.id, 'ignore')}>Ignore</button>
                <button className="sa-btn danger" type="button" onClick={() => lifecycleEvent(s.id, 'delete')}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </SectionPanel>

      {campaignDetail && (
        <SectionPanel
          id="sa-intel-campaign-detail"
          panelRef={campaignIntelRef}
          icon="✦"
          title="Campaign Intelligence"
          desc="Full AI analysis of a detected customer success."
          className={`glow${intelFlash === 'campaign' ? ' sa-panel-flash' : ''}`}
        >
          <div className="sa-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiCard icon="★" label="AI Score" value={`${Number(campaignDetail.campaignSummary?.aiScore || 0).toFixed(1)} / 10`} tone="violet" />
            <KpiCard icon="$" label="Revenue" value={`$${Number(campaignDetail.campaignSummary?.revenue || 0).toLocaleString()}`} tone="green" />
            <KpiCard icon="%" label="Conversion" value={`${campaignDetail.campaignSummary?.conversionRate || 0}%`} tone="cyan" />
            <KpiCard icon="◆" label="Deals" value={campaignDetail.campaignSummary?.deals || 0} tone="blue" />
          </div>
          <p><strong>{campaignDetail.campaignSummary?.name}</strong>{' '}
            <ScoreBadge score={campaignDetail.campaignSummary?.aiScore} label={campaignDetail.campaignSummary?.scoreLabel} />
            {campaignDetail.campaignSummary?.isTest ? <span className="sa-pill warn">Test</span> : <span className="sa-pill ok">Production</span>}
          </p>
          <p className="sa-muted">
            {campaignDetail.campaignSummary?.customer} · {campaignDetail.campaignSummary?.industry || '—'} · {campaignDetail.campaignSummary?.country || '—'} · {campaignDetail.campaignSummary?.channel}
          </p>
          <p className="sa-muted">
            Leads {campaignDetail.campaignSummary?.leadCount} · Replies {campaignDetail.campaignSummary?.replies} · Meetings {campaignDetail.campaignSummary?.meetings}
            {' · '}Workspace {campaignDetail.campaignSummary?.workspaceId || '—'}
          </p>
          <div className="sa-actions" style={{ marginBottom: 12 }}>
            <button className="sa-btn" type="button" onClick={() => lifecycleEvent(campaignDetail.successEvent?.id, campaignDetail.campaignSummary?.pinned ? 'unpin' : 'pin')}>
              {campaignDetail.campaignSummary?.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button className="sa-btn" type="button" onClick={() => lifecycleEvent(campaignDetail.successEvent?.id, 'archive')}>Archive</button>
            <button className="sa-btn" type="button" onClick={() => lifecycleEvent(campaignDetail.successEvent?.id, 'ignore')}>Ignore</button>
            <button className="sa-btn danger" type="button" onClick={() => lifecycleEvent(campaignDetail.successEvent?.id, 'delete')}>Delete</button>
            {campaignDetail.library?.id && (
              <button className="sa-btn primary" type="button" onClick={() => startLaunchWizard(campaignDetail.library)}>Duplicate → Launch Wizard</button>
            )}
          </div>

          <div
            id="sa-intel-recs"
            ref={recsRef}
            className={`sa-alert info sa-recs${intelFlash === 'recs' ? ' sa-panel-flash' : ''}`}
            style={{ display: 'block', marginTop: 12 }}
          >
            <strong>AI Recommendation</strong>
            <div className="sa-recs-grid">
              <div><span className="sa-muted">AI Score</span><div><ScoreBadge score={recs?.aiScore ?? campaignDetail.campaignSummary?.aiScore} label={recs?.scoreLabel || campaignDetail.campaignSummary?.scoreLabel} /></div></div>
              <div><span className="sa-muted">Why it performed well</span><div>{recs?.whyItPerformed || campaignDetail.whyItWorked || '—'}</div></div>
              <div><span className="sa-muted">Weaknesses</span><div>{(recs?.weaknesses || []).join(' ') || '—'}</div></div>
              <div><span className="sa-muted">Best audience</span><div>{recs?.bestAudience || '—'}</div></div>
              <div><span className="sa-muted">Best country</span><div>{recs?.bestCountry || '—'}</div></div>
              <div><span className="sa-muted">Best industry</span><div>{recs?.bestIndustry || '—'}</div></div>
              <div><span className="sa-muted">Best send time</span><div>{recs?.bestSendTime || '—'}</div></div>
              <div><span className="sa-muted">Recommended channel</span><div>{recs?.recommendedChannel || '—'}</div></div>
              <div><span className="sa-muted">Reuse confidence</span><div>{recs?.reuseConfidence != null ? `${recs.reuseConfidence}%` : '—'}</div></div>
              <div>
                <span className="sa-muted">Expected if reused</span>
                <div>
                  Conv {recs?.expectedPerformance?.expectedConversion ?? '—'}% · Reply {recs?.expectedPerformance?.expectedReplyRate ?? '—'}% · Lift {recs?.expectedPerformance?.expectedRevenueLiftPct ?? 0}%
                </div>
              </div>
              <div style={{ gridColumn: '1 / -1' }}><span className="sa-muted">Action</span><div>{recs?.actionHint || '—'}</div></div>
            </div>
          </div>

          <div className="sa-alert success" style={{ display: 'block', marginTop: 12 }}>
            <strong>Why it worked</strong>
            <div style={{ marginTop: 6 }}>{campaignDetail.whyItWorked || 'Analysis pending.'}</div>
          </div>
          <div className="sa-split" style={{ marginTop: 12 }}>
            <SectionPanel icon="◉" title="Funnel performance">
              <BarChart
                points={[
                  { label: 'Leads', value: campaignDetail.funnel?.leads || 0 },
                  { label: 'Sent', value: campaignDetail.funnel?.sent || 0 },
                  { label: 'Replies', value: campaignDetail.funnel?.replies || 0 },
                  { label: 'Meetings', value: campaignDetail.funnel?.meetings || 0 },
                  { label: 'Deals', value: campaignDetail.funnel?.deals || 0 },
                ]}
                color="#22d3ee"
                height={180}
              />
            </SectionPanel>
            <SectionPanel icon="☰" title="Timeline">
              {(campaignDetail.timeline || []).map((t: any, i: number) => (
                <div key={i} className="sa-muted" style={{ marginBottom: 8 }}>
                  <strong>{t.label}</strong>
                  <div className="sa-mono">{t.at ? new Date(t.at).toLocaleString() : '—'}</div>
                </div>
              ))}
            </SectionPanel>
          </div>
          <SectionPanel icon="▣" title="Marketing assets" desc="Uploaded images and documents detected in this workspace.">
            {(campaignDetail.assets?.images || []).length === 0 && (campaignDetail.assets?.documents || []).length === 0 && (
              <div className="sa-empty"><strong>No media detected</strong>Images/docs appear when campaigns send media or attach files.</div>
            )}
            <div className="sa-asset-grid">
              {(campaignDetail.assets?.images || []).slice(0, 12).map((a: any, i: number) => {
                const src = a.url || a.preview || '';
                return (
                  <div key={`img-${i}`} className="sa-asset-card">
                    {src && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(src) ? (
                      <img src={src} alt="" className="sa-asset-thumb" />
                    ) : (
                      <div className="sa-asset-placeholder">Image</div>
                    )}
                    <div className="sa-muted sa-asset-cap">{src || a.type || '—'}</div>
                    {src && (
                      <button
                        className="sa-btn"
                        type="button"
                        onClick={() => {
                          if (wizard) setWizard({ ...wizard, body: `${wizard.body}\n\n[Asset] ${src}`.trim() });
                          else setMsg(`Asset ready: ${src}`);
                        }}
                      >
                        Copy to wizard
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {(campaignDetail.assets?.documents || []).slice(0, 8).map((a: any, i: number) => (
              <div key={`doc-${i}`} className="sa-muted" style={{ marginBottom: 6 }}>Doc · {a.url || a.preview || a.type || '—'}</div>
            ))}
          </SectionPanel>
          <SectionPanel icon="✉" title="Sequences & AI messages" desc="Recent workspace messages and AI drafts.">
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead><tr><th>Channel</th><th>Direction</th><th>Body</th><th>When</th></tr></thead>
                <tbody>
                  {(campaignDetail.sequences?.recentMessages || []).slice(0, 12).map((m: any, i: number) => (
                    <tr key={i}>
                      <td>{m.channel}</td>
                      <td>{m.direction}</td>
                      <td style={{ maxWidth: 360, whiteSpace: 'normal' }}>{m.body}</td>
                      <td className="sa-mono">{m.created_at ? new Date(m.created_at).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionPanel>
        </SectionPanel>
      )}

      <div className="sa-split sa-split-wide">
        <SectionPanel icon="✦" title="Detected successes" desc={`${total} matching campaigns · page ${page}/${totalPages}`}>
          {selectedEventIds.length > 0 && (
            <div className="sa-actions sa-bulk-bar">
              <span className="sa-muted">{selectedEventIds.length} selected</span>
              <button className="sa-btn" type="button" onClick={() => bulkEvents('pin')}>Pin</button>
              <button className="sa-btn" type="button" onClick={() => bulkEvents('archive')}>Archive</button>
              <button className="sa-btn" type="button" onClick={() => bulkEvents('ignore')}>Ignore</button>
              <button className="sa-btn danger" type="button" onClick={() => bulkEvents('delete')}>Delete</button>
              <button className="sa-btn" type="button" onClick={() => setSelectedEventIds([])}>Clear</button>
            </div>
          )}
          <div className="sa-table-wrap sa-table-virtual">
            <table className="sa-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={intelEvents.length > 0 && selectedEventIds.length === intelEvents.length}
                      onChange={(e) => setSelectedEventIds(e.target.checked ? intelEvents.map((x) => x.id) : [])}
                    />
                  </th>
                  <th>When</th><th>Customer</th><th>AI</th><th>Type</th><th>Industry</th><th>Country</th><th>Revenue</th><th></th>
                </tr>
              </thead>
              <tbody>
                {intelEvents.length === 0 && (
                  <tr><td colSpan={9}><div className="sa-empty"><strong>No successes yet</strong>Adjust filters or run a scan.</div></td></tr>
                )}
                {intelEvents.map((e) => (
                  <tr key={e.id} className={e.pinned ? 'sa-row-pinned' : ''}>
                    <td>
                      <input type="checkbox" checked={selectedEventIds.includes(e.id)} onChange={() => toggleEventSel(e.id)} />
                    </td>
                    <td className="sa-mono">{e.created_at ? new Date(e.created_at).toLocaleString() : '—'}</td>
                    <td>
                      {e.pinned ? <span className="sa-pill info">pinned</span> : null}{' '}
                      {e.customer_name || e.customer_email || e.workspace_id}
                      {e.is_test ? <span className="sa-pill warn" style={{ marginLeft: 6 }}>test</span> : null}
                    </td>
                    <td><ScoreBadge score={e.ai_score} label={e.score_label} /></td>
                    <td><span className="sa-pill ok">{e.event_type}</span></td>
                    <td>{e.industry || '—'}</td>
                    <td>{e.country || '—'}</td>
                    <td>${Number(e.revenue || 0).toLocaleString()}</td>
                    <td>
                      <div className="sa-actions">
                        <button className="sa-btn primary" type="button" onClick={() => void openCampaignIntelligence(e.id)}>Analyze</button>
                        <button className="sa-btn" type="button" onClick={() => lifecycleEvent(e.id, e.pinned ? 'unpin' : 'pin')}>{e.pinned ? 'Unpin' : 'Pin'}</button>
                        <button className="sa-btn" type="button" onClick={() => lifecycleEvent(e.id, 'archive')}>Archive</button>
                        <button className="sa-btn" type="button" onClick={() => lifecycleEvent(e.id, 'ignore')}>Ignore</button>
                        <button className="sa-btn danger" type="button" onClick={() => lifecycleEvent(e.id, 'delete')}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sa-actions" style={{ marginTop: 12 }}>
            <button className="sa-btn" type="button" disabled={page <= 1} onClick={() => patchFilter({ page: page - 1 })}>Prev</button>
            <span className="sa-muted">Page {page} / {totalPages} · {total} total</span>
            <button className="sa-btn" type="button" disabled={page >= totalPages} onClick={() => patchFilter({ page: page + 1 })}>Next</button>
          </div>
        </SectionPanel>
        <SectionPanel icon="◈" title="Pattern learning" desc="Highest converting industries, countries, styles, ROI and channels.">
          <h4 className="sa-section-title" style={{ fontSize: 13 }}>Industries</h4>
          {(intelPatterns?.highestConvertingIndustries || []).slice(0, 6).map((r: any) => (
            <div key={`i-${r.key}`} className="sa-muted" style={{ marginBottom: 6 }}>{r.key}: {r.wins} wins · conv {Math.round(r.avg_conversion || 0)}% · ${Number(r.revenue || 0).toLocaleString()}</div>
          ))}
          <h4 className="sa-section-title" style={{ fontSize: 13, marginTop: 12 }}>Countries</h4>
          {(intelPatterns?.bestCountries || []).slice(0, 6).map((r: any) => (
            <div key={`c-${r.key}`} className="sa-muted" style={{ marginBottom: 6 }}>{r.key}: {r.wins} wins · conv {Math.round(r.avg_conversion || 0)}%</div>
          ))}
          <h4 className="sa-section-title" style={{ fontSize: 13, marginTop: 12 }}>Copy styles</h4>
          {(intelPatterns?.bestCopyStyles || []).slice(0, 5).map((r: any) => (
            <div key={`s-${r.key}`} className="sa-muted" style={{ marginBottom: 6 }}>{r.key}: {r.wins} wins · conv {Math.round(r.avg_conversion || 0)}%</div>
          ))}
          <h4 className="sa-section-title" style={{ fontSize: 13, marginTop: 12 }}>Highest ROI</h4>
          {(intelPatterns?.highestRoiCampaigns || []).slice(0, 4).map((r: any) => (
            <div key={`roi-${r.id}`} className="sa-muted" style={{ marginBottom: 6 }}>
              {r.campaign_name || r.event_type}: ${Number(r.roi_proxy || r.revenue || 0).toLocaleString()} / lead · {r.industry || '—'}
            </div>
          ))}
          <h4 className="sa-section-title" style={{ fontSize: 13, marginTop: 12 }}>Fastest closes</h4>
          {(intelPatterns?.fastestClosingCampaigns || []).slice(0, 4).map((r: any) => (
            <div key={`f-${r.id}`} className="sa-muted" style={{ marginBottom: 6 }}>
              {r.campaign_name || r.event_type}: {r.created_at ? new Date(r.created_at).toLocaleDateString() : '—'} · ${Number(r.revenue || 0).toLocaleString()}
            </div>
          ))}
          <h4 className="sa-section-title" style={{ fontSize: 13, marginTop: 12 }}>Top revenue</h4>
          {(intelPatterns?.highestRevenueCampaigns || []).slice(0, 4).map((r: any) => (
            <div key={`r-${r.id}`} className="sa-muted" style={{ marginBottom: 6 }}>
              {r.campaign_name || r.event_type}: ${Number(r.revenue || 0).toLocaleString()} · {r.industry || '—'}
              {r.ai_score != null ? ` · AI ${Number(r.ai_score).toFixed(1)}` : ''}
            </div>
          ))}
          <h4 className="sa-section-title" style={{ fontSize: 13, marginTop: 12 }}>Channels</h4>
          <div className="sa-muted" style={{ marginBottom: 6 }}>WhatsApp wins: {(intelPatterns?.bestWhatsappCampaigns || []).length}</div>
          <div className="sa-muted" style={{ marginBottom: 6 }}>Email wins: {(intelPatterns?.bestEmailCampaigns || []).length}</div>
          {(intelPatterns?.futureModules || []).length > 0 && (
            <>
              <h4 className="sa-section-title" style={{ fontSize: 13, marginTop: 12 }}>Roadmap modules</h4>
              <div className="sa-muted">{(intelPatterns.futureModules || []).slice(0, 8).join(' · ')}</div>
            </>
          )}
        </SectionPanel>
      </div>

      <SectionPanel
        icon="▣"
        title="Winning Campaign Library"
        desc={`${libraryTotal} reusable campaigns · page ${page}/${libraryTotalPages}`}
        actions={(
          <>
            <input className="sa-input" style={{ width: 180 }} placeholder="Search library…" value={String(filters.q || '')} onChange={(e) => patchFilter({ q: e.target.value })} />
            <select className="sa-select" style={{ width: 130 }} value={String(filters.channel || '')} onChange={(e) => patchFilter({ channel: e.target.value })}>
              <option value="">All channels</option>
              {filterFacets.channels.map((x) => (
                <option key={x} value={x}>{x === 'multi' ? 'Multi' : x === 'whatsapp' ? 'WhatsApp' : x === 'sms' ? 'SMS' : x.charAt(0).toUpperCase() + x.slice(1)}</option>
              ))}
            </select>
            <button className="sa-btn primary" type="button" onClick={() => setFilterOpen(true)}>Open filters</button>
          </>
        )}
      >
        {libraryItem && (
          <div
            id="sa-intel-library-detail"
            ref={libraryDetailRef}
            className={`sa-alert info${intelFlash === 'library' ? ' sa-panel-flash' : ''}`}
            style={{ display: 'block', marginBottom: 12 }}
          >
            <strong>{libraryItem.name}</strong>{' '}
            <ScoreBadge score={libraryItem.ai_score} label={libraryItem.score_label} />
            <div className="sa-muted" style={{ marginTop: 6 }}>
              {libraryItem.industry || '—'} · {libraryItem.country || '—'} · {libraryItem.channel} · ${Number(libraryItem.revenue || 0).toLocaleString()}
              {libraryItem.is_test ? ' · TEST' : ' · PRODUCTION'}
            </div>
            <div style={{ marginTop: 8 }}>{libraryItem.why_it_worked || 'No AI summary yet.'}</div>
            {libraryItem.recommendations && (
              <div className="sa-muted" style={{ marginTop: 8 }}>
                Reuse confidence {libraryItem.recommendations.reuseConfidence ?? '—'}% · Channel {libraryItem.recommendations.recommendedChannel || '—'}
              </div>
            )}
            <div className="sa-actions">
              <button className="sa-btn primary" type="button" disabled={!!busy} onClick={() => startLaunchWizard(libraryItem)}>
                Duplicate / Launch Wizard
              </button>
              <button className="sa-btn" type="button" onClick={() => lifecycleLibrary(libraryItem.id, libraryItem.pinned ? 'unpin' : 'pin')}>
                {libraryItem.pinned ? 'Unpin' : 'Pin'}
              </button>
              <button className="sa-btn" type="button" onClick={() => lifecycleLibrary(libraryItem.id, 'archive')}>Archive</button>
              <button className="sa-btn" type="button" onClick={() => lifecycleLibrary(libraryItem.id, 'ignore')}>Ignore</button>
              <button className="sa-btn danger" type="button" onClick={() => lifecycleLibrary(libraryItem.id, 'delete')}>Delete</button>
              {libraryItem.success_event_id && (
                <button className="sa-btn" type="button" onClick={() => void openCampaignIntelligence(libraryItem.success_event_id)}>Study</button>
              )}
            </div>
          </div>
        )}

        {wizard && (
          <div className="sa-launch-wizard sa-alert info" style={{ display: 'block', marginBottom: 14 }}>
            <strong>Launch Wizard — Step {wizard.step} of 4</strong>
            <div className="sa-wizard-steps">
              {['Channel', 'Workspace', 'Review', 'Launch'].map((label, i) => (
                <span key={label} className={wizard.step === i + 1 ? 'active' : wizard.step > i + 1 ? 'done' : ''}>{i + 1}. {label}</span>
              ))}
            </div>
            {wizard.step === 1 && (
              <div className="sa-wizard-body">
                <p className="sa-muted">Choose Channel</p>
                {(['email', 'whatsapp', 'sms', 'multi'] as const).map((ch) => (
                  <label key={ch} className="sa-check" style={{ display: 'block', marginBottom: 8 }}>
                    <input type="radio" name="wiz-ch" checked={wizard.channel === ch} onChange={() => setWizard({ ...wizard, channel: ch })} />
                    {ch === 'multi' ? 'Multi Channel' : ch === 'whatsapp' ? 'WhatsApp' : ch === 'sms' ? 'SMS' : 'Email'}
                  </label>
                ))}
              </div>
            )}
            {wizard.step === 2 && (
              <div className="sa-wizard-body">
                <p className="sa-muted">Choose Workspace</p>
                <select
                  className="sa-select"
                  style={{ width: '100%', maxWidth: 420 }}
                  value={wizard.workspaceId}
                  onChange={(e) => setWizard({ ...wizard, workspaceId: e.target.value })}
                >
                  <option value="">Select workspace…</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.name} · {w.email} · {w.id}</option>
                  ))}
                </select>
              </div>
            )}
            {wizard.step === 3 && (
              <div className="sa-wizard-body">
                <p className="sa-muted">Review & adapt before launch · Channel: {wizard.channel}</p>
                <input className="sa-input" style={{ width: '100%', marginBottom: 8 }} value={wizard.name} onChange={(e) => setWizard({ ...wizard, name: e.target.value })} placeholder="Campaign name" />
                {(wizard.channel === 'email' || wizard.channel === 'multi') && (
                  <input className="sa-input" style={{ width: '100%', marginBottom: 8 }} value={wizard.subject} onChange={(e) => setWizard({ ...wizard, subject: e.target.value })} placeholder="Email subject" />
                )}
                <textarea
                  className="sa-textarea"
                  rows={6}
                  style={{ width: '100%', marginBottom: 8 }}
                  value={wizard.body}
                  onChange={(e) => setWizard({ ...wizard, body: e.target.value })}
                  placeholder={wizard.channel === 'whatsapp' || wizard.channel === 'sms' ? 'Message body' : 'Email / message body'}
                />
                <textarea
                  className="sa-textarea"
                  rows={3}
                  style={{ width: '100%' }}
                  value={wizard.adaptNotes}
                  onChange={(e) => setWizard({ ...wizard, adaptNotes: e.target.value })}
                  placeholder="Adapt notes (industry/country tweaks, offer changes…)"
                />
                <div className="sa-muted" style={{ marginTop: 8 }}>
                  Channel {wizard.channel} · Workspace {wizard.workspaceId || '—'}
                </div>
              </div>
            )}
            {wizard.step === 4 && (
              <div className="sa-wizard-body">
                <p><strong>Ready to launch</strong></p>
                <p className="sa-muted">{wizard.name} → {wizard.channel} → {wizard.workspaceId}</p>
                {(wizard.channel === 'email' || wizard.channel === 'multi') && wizard.subject ? (
                  <p className="sa-muted">Subject: {wizard.subject}</p>
                ) : null}
                {wizard.adaptNotes ? <p className="sa-muted">Adapt: {wizard.adaptNotes}</p> : null}
                <pre className="sa-log-pre" style={{ maxHeight: 160 }}>{wizard.body}</pre>
              </div>
            )}
            <div className="sa-actions">
              <button className="sa-btn" type="button" onClick={() => setWizard(null)}>Cancel</button>
              {wizard.step > 1 && (
                <button className="sa-btn" type="button" disabled={!!busy} onClick={() => run('Wizard back', async () => {
                  await saveWizardStep(wizard.step - 1);
                })}>
                  Back
                </button>
              )}
              {wizard.step < 4 && (
                <button className="sa-btn primary" type="button" disabled={!!busy || (wizard.step === 2 && !wizard.workspaceId)} onClick={() => run('Wizard next', async () => {
                  if (wizard.step === 1 && !wizard.channel) throw new Error('Choose a channel');
                  if (wizard.step === 2 && !wizard.workspaceId) throw new Error('Choose a workspace');
                  await saveWizardStep(wizard.step + 1);
                  scheduleIntelFocus('library');
                })}>
                  Next
                </button>
              )}
              {wizard.step === 4 && (
                <button className="sa-btn primary" type="button" disabled={!!busy} onClick={() => run('Launch campaign', async () => {
                  await saveWizardStep(4);
                  if (!wizard.draftId) throw new Error('Missing draft');
                  const res = await launchIntelligenceDraft(wizard.draftId);
                  const launchedId = res.draft?.id || wizard.draftId;
                  setMsg(`Launched into workspace ${res.draft?.target_workspace_id}`);
                  setWizard(null);
                  await refresh();
                  if (launchedId) await openTrackResults(launchedId);
                })}>
                  Launch → Track
                </button>
              )}
            </div>
          </div>
        )}

        {selectedLibraryIds.length > 0 && (
          <div className="sa-actions sa-bulk-bar">
            <span className="sa-muted">{selectedLibraryIds.length} selected</span>
            <button className="sa-btn" type="button" onClick={() => bulkLibrary('pin')}>Pin</button>
            <button className="sa-btn" type="button" onClick={() => bulkLibrary('archive')}>Archive</button>
            <button className="sa-btn" type="button" onClick={() => bulkLibrary('ignore')}>Ignore</button>
            <button className="sa-btn danger" type="button" onClick={() => bulkLibrary('delete')}>Delete</button>
            <button className="sa-btn" type="button" onClick={() => setSelectedLibraryIds([])}>Clear</button>
          </div>
        )}

        <div className="sa-table-wrap sa-table-virtual">
          <table className="sa-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={intelLibrary.length > 0 && selectedLibraryIds.length === intelLibrary.length}
                    onChange={(e) => setSelectedLibraryIds(e.target.checked ? intelLibrary.map((x) => x.id) : [])}
                  />
                </th>
                <th>Campaign</th><th>AI</th><th>Industry</th><th>Country</th><th>Channel</th>
                <th>Revenue</th><th>Conv</th><th>Style</th><th></th>
              </tr>
            </thead>
            <tbody>
              {intelLibrary.length === 0 && (
                <tr><td colSpan={10}><div className="sa-empty"><strong>Library empty</strong>Successful campaigns appear after scans.</div></td></tr>
              )}
              {intelLibrary.map((item) => (
                <tr key={item.id} className={item.pinned ? 'sa-row-pinned' : ''}>
                  <td>
                    <input type="checkbox" checked={selectedLibraryIds.includes(item.id)} onChange={() => toggleLibSel(item.id)} />
                  </td>
                  <td style={{ fontWeight: 700 }}>
                    {item.pinned ? <span className="sa-pill info">pinned</span> : null}{' '}
                    {item.name}
                    {item.is_test ? <span className="sa-pill warn" style={{ marginLeft: 6 }}>test</span> : null}
                  </td>
                  <td><ScoreBadge score={item.ai_score} label={item.score_label} /></td>
                  <td>{item.industry || '—'}</td>
                  <td>{item.country || '—'}</td>
                  <td><span className="sa-pill ok">{item.channel || '—'}</span></td>
                  <td>${Number(item.revenue || 0).toLocaleString()}</td>
                  <td>{Number(item.conversion_rate || 0)}%</td>
                  <td>{item.copy_style || '—'}</td>
                  <td>
                    <div className="sa-actions">
                      <button className="sa-btn" type="button" onClick={() => openLibraryItem(item)}>View</button>
                      {item.success_event_id && (
                        <button className="sa-btn primary" type="button" onClick={() => void openCampaignIntelligence(item.success_event_id)}>Study</button>
                      )}
                      <button className="sa-btn" type="button" disabled={!!busy} onClick={() => startLaunchWizard(item)}>Duplicate</button>
                      <button className="sa-btn" type="button" onClick={() => lifecycleLibrary(item.id, item.pinned ? 'unpin' : 'pin')}>{item.pinned ? 'Unpin' : 'Pin'}</button>
                      <button className="sa-btn" type="button" onClick={() => lifecycleLibrary(item.id, 'archive')}>Archive</button>
                      <button className="sa-btn" type="button" onClick={() => lifecycleLibrary(item.id, 'ignore')}>Ignore</button>
                      <button className="sa-btn danger" type="button" onClick={() => lifecycleLibrary(item.id, 'delete')}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="sa-actions" style={{ marginTop: 12 }}>
          <button className="sa-btn" type="button" disabled={page <= 1} onClick={() => patchFilter({ page: page - 1 })}>Prev</button>
          <span className="sa-muted">Library page {page} / {libraryTotalPages} · {libraryTotal} total</span>
          <button className="sa-btn" type="button" disabled={page >= libraryTotalPages} onClick={() => patchFilter({ page: page + 1 })}>Next</button>
        </div>
      </SectionPanel>

      <SectionPanel
        id="sa-intel-track"
        panelRef={trackRef}
        icon="◎"
        title="Track Results"
        desc="Post-launch outcomes vs source campaign — close the Owner workflow loop."
        className={intelFlash === 'track' ? 'sa-panel-flash' : undefined}
      >
        {launchDrafts.length === 0 && !trackOutcome && (
          <div className="sa-empty"><strong>No launches yet</strong>Duplicate a library campaign and launch to track results here.</div>
        )}
        {launchDrafts.length > 0 && (
          <div className="sa-table-wrap sa-table-virtual" style={{ maxHeight: 240, marginBottom: 12 }}>
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Draft</th><th>Status</th><th>Channel</th><th>Workspace</th><th>Launched</th><th></th>
                </tr>
              </thead>
              <tbody>
                {launchDrafts.map((d) => (
                  <tr key={d.id} className={trackOutcome?.draft?.id === d.id ? 'sa-row-pinned' : ''}>
                    <td style={{ fontWeight: 700 }}>{d.name}</td>
                    <td><span className={`sa-pill ${d.status === 'launched' ? 'ok' : 'info'}`}>{d.status}</span></td>
                    <td>{d.channel}</td>
                    <td className="sa-mono">{d.target_workspace_id || '—'}</td>
                    <td className="sa-mono">{d.launched_at ? new Date(d.launched_at).toLocaleString() : '—'}</td>
                    <td>
                      <button className="sa-btn primary" type="button" onClick={() => void openTrackResults(d.id)}>
                        Track
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {trackOutcome && (
          <div className="sa-track-detail">
            <div className="sa-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <KpiCard icon="↗" label="Outbound" value={trackOutcome.metrics?.outbound || 0} tone="blue" />
              <KpiCard icon="↩" label="Replies" value={trackOutcome.metrics?.replies || 0} tone="cyan" />
              <KpiCard icon="◆" label="Deals" value={trackOutcome.metrics?.deals || 0} tone="violet" />
              <KpiCard icon="$" label="Revenue" value={`$${Number(trackOutcome.metrics?.revenue || 0).toLocaleString()}`} tone="green" />
            </div>
            <p className="sa-muted" style={{ marginTop: 10 }}>
              {trackOutcome.comparison?.statusHint}
              {trackOutcome.source ? ` · Source AI ${Number(trackOutcome.source.aiScore || 0).toFixed(1)} · Source rev $${Number(trackOutcome.source.revenue || 0).toLocaleString()}` : ''}
              {trackOutcome.comparison?.revenueDelta != null ? ` · Δ $${Number(trackOutcome.comparison.revenueDelta).toLocaleString()}` : ''}
            </p>
            <div className="sa-actions">
              <button className="sa-btn" type="button" onClick={() => trackOutcome.draft?.id && void openTrackResults(trackOutcome.draft.id)}>Refresh outcomes</button>
              {trackOutcome.source?.id && (
                <button className="sa-btn" type="button" onClick={() => void openCampaignIntelligence(trackOutcome.source.id)}>Open source campaign</button>
              )}
              <button className="sa-btn" type="button" onClick={() => setTrackOutcome(null)}>Close</button>
            </div>
          </div>
        )}
      </SectionPanel>
    </>
  );
}
