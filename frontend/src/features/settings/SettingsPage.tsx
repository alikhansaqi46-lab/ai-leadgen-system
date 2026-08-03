import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../common/PageHeader';
import ConnectionCard from '../common/ConnectionCard';
import OpenAiSettings from './OpenAiSettings';
import { getIntegrations, getEmailStatus, getIntegrationProviders, getScraperConfig, IntegrationStatus, ProviderDefinition, getPreviewSettings, updatePreviewSettings, PreviewSettings, getUserProfile, getSenderEmail, setSenderEmail, getOAuthUrl, disconnectIntegration, getAiAgentSettings, updateAiAgentSettings, AiAgentSettings, DEFAULT_AI_AGENT_SETTINGS, getEmailSettings, updateEmailSettings, EmailSettings, AiKnowledgeStatus } from '../../lib/apiClient';
import { useAuth } from '../auth/AuthContext';
import { AUTH_MODE } from '../../auth/authConfig';

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const [providers, setProviders] = useState<ProviderDefinition[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [scraperConfigured, setScraperConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const [previewSettings, setPreviewSettings] = useState<PreviewSettings | null>(null);
  const [previewSaving, setPreviewSaving] = useState(false);
  const [previewMsg, setPreviewMsg] = useState('');

  // Sender email (separate from account/login email)
  const [senderEmail, setSenderEmailState] = useState<string>('');
  const [senderEmailInput, setSenderEmailInput] = useState<string>('');
  const [senderEmailSaving, setSenderEmailSaving] = useState(false);
  const [senderEmailMsg, setSenderEmailMsg] = useState('');
  const [emailConnecting, setEmailConnecting] = useState(false);

  const [aiAgentSettings, setAiAgentSettings] = useState<AiAgentSettings | null>(null);
  const [aiAgentSaving, setAiAgentSaving] = useState(false);
  const [aiAgentMsg, setAiAgentMsg] = useState('');
  const [aiAgentError, setAiAgentError] = useState<string | null>(null);
  const [aiAgentLoaded, setAiAgentLoaded] = useState(false);
  const [aiKnowledgeStatus, setAiKnowledgeStatus] = useState<AiKnowledgeStatus | null>(null);
  const [emailSettings, setEmailSettings] = useState<EmailSettings | null>(null);
  const [emailSettingsSaving, setEmailSettingsSaving] = useState(false);
  const [emailSettingsMsg, setEmailSettingsMsg] = useState('');

  const authModeLabel = user
    ? 'LeadFlow JWT (/api/auth login)'
    : AUTH_MODE === 'supabase'
    ? 'Supabase (ES256 / JWKS)'
    : AUTH_MODE === 'local'
    ? 'Local (JWT / per-user workspace)'
    : 'Disabled (no auth)';

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [providerRes, integrationRes, scraperCfg, previewRes, senderRes, aiAgentRes, emailSettingsRes] = await Promise.all([
        getIntegrationProviders().catch(() => ({ success: false, providers: [] })),
        getIntegrations().catch(() => ({ success: false, integrations: [] })),
        getScraperConfig().catch(() => ({ configured: false })),
        getPreviewSettings().catch(() => ({ success: false, settings: null })),
        getSenderEmail().catch(() => ({ senderEmail: null })),
        getAiAgentSettings().catch(() => ({ success: false, settings: null })),
        getEmailSettings().catch(() => ({ success: false, settings: { includeUnsubscribeFooter: false } })),
      ]);
      setProviders(providerRes.providers || []);
      setIntegrations(integrationRes.integrations || []);
      setScraperConfigured(scraperCfg.configured || false);
      if (previewRes.settings) setPreviewSettings(previewRes.settings);
      if (aiAgentRes?.settings) {
        setAiAgentSettings(aiAgentRes.settings);
        setAiKnowledgeStatus(aiAgentRes.knowledgeStatus || null);
        setAiAgentError(null);
      } else {
        setAiAgentSettings(DEFAULT_AI_AGENT_SETTINGS);
        setAiAgentError('Could not load saved AI profile. Showing defaults — save to persist.');
      }
      if (emailSettingsRes?.settings) setEmailSettings(emailSettingsRes.settings);
      else setEmailSettings({ includeUnsubscribeFooter: false });
      setAiAgentLoaded(true);
      const se = senderRes.senderEmail || '';
      setSenderEmailState(se);
      setSenderEmailInput(se);
    } catch {
      setAiAgentSettings(DEFAULT_AI_AGENT_SETTINGS);
      setAiAgentError('Some settings failed to load. Showing defaults where needed.');
      setAiAgentLoaded(true);
      // Fallback: check email status directly if integrations API fails
      try {
        const email = await getEmailStatus();
        setIntegrations([
          { provider: 'email', name: 'Email', icon: '@', connected: Boolean(email.configured), account: email.account || null },
        ]);
      } catch {
        setIntegrations([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    load();
    return () => { active = false };
  }, [load]);

  // Auto-fill preview phone/email from user profile when settings load empty
  useEffect(() => {
    if (!previewSettings) return;
    if (previewSettings.previewPhone && previewSettings.previewEmail) return;
    (async () => {
      try {
        const profile = await getUserProfile();
        if (!profile) return;
        const updates: Partial<PreviewSettings> = {};
        if (!previewSettings.previewPhone && (profile as any).phone) {
          updates.previewPhone = (profile as any).phone;
        }
        if (!previewSettings.previewPhone && profile.whatsappNumber) {
          updates.previewPhone = profile.whatsappNumber;
        }
        if (!previewSettings.previewEmail && profile.email) {
          updates.previewEmail = profile.email;
        }
        if (Object.keys(updates).length > 0) {
          const res = await updatePreviewSettings(updates);
          setPreviewSettings(res.settings);
        }
      } catch { /* ignore */ }
    })();
  }, [previewSettings?.previewPhone, previewSettings?.previewEmail]);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
    }
  };

  const getStatus = (key: string) => integrations.find((i) => i.provider === key) || null;
  const emailIntegration = getStatus('email');
  const emailConnected = Boolean(emailIntegration?.connected);

  const handleEmailOAuthConnect = useCallback(async () => {
    setSenderEmailMsg('');
    setEmailConnecting(true);
    try {
      const res = await getOAuthUrl('email');
      if (res.success && res.url) {
        const width = 500;
        const height = 600;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;
        const popup = window.open(
          res.url,
          'oauth',
          `width=${width},height=${height},left=${left},top=${top},popup=1`
        );
        if (!popup) {
          setSenderEmailMsg('Popup blocked. Please allow popups for this site.');
          setEmailConnecting(false);
          return;
        }
        const listener = (event: MessageEvent) => {
          if (event.data?.provider !== 'email') return;
          if (event.data?.type === 'oauth-success') {
            window.removeEventListener('message', listener);
            setEmailConnecting(false);
            setSenderEmailMsg('Gmail connected successfully.');
            load();
          } else if (event.data?.type === 'oauth-error') {
            window.removeEventListener('message', listener);
            setEmailConnecting(false);
            setSenderEmailMsg(event.data?.error || 'OAuth connection failed');
          }
        };
        window.addEventListener('message', listener);
        const checkClosed = setInterval(() => {
          if (popup.closed) {
            clearInterval(checkClosed);
            window.removeEventListener('message', listener);
            setEmailConnecting(false);
            load();
          }
        }, 500);
      }
    } catch {
      setSenderEmailMsg('Failed to start OAuth flow. Check server configuration.');
      setEmailConnecting(false);
    }
  }, [load]);

  const handleEmailDisconnect = useCallback(async () => {
    setSenderEmailSaving(true); setSenderEmailMsg('');
    try {
      await disconnectIntegration('email');
      await setSenderEmail(null);
      setSenderEmailState('');
      setSenderEmailInput('');
      setSenderEmailMsg('Email disconnected.');
      load();
    } catch {
      setSenderEmailMsg('Failed to disconnect email.');
    } finally {
      setSenderEmailSaving(false);
    }
  }, [load]);

  return (
    <div className="lf-page">
      <PageHeader title="Settings" subtitle="Workspace, account, and integrations" />

      <div className="lf-stack">
        {/* Account Card */}
        <div className="lf-card">
          <div className="lf-card-header">
            <h2 className="lf-card-title">Account</h2>
            <button className="lf-btn" onClick={handleSignOut} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
          {user ? (
            <dl className="lf-deflist">
              <div className="lf-defrow">
                <dt>Signed in as</dt>
                <dd>{user.email}</dd>
              </div>
              <div className="lf-defrow">
                <dt>Workspace ID</dt>
                <dd><code>{user.id}</code></dd>
              </div>
              <div className="lf-defrow">
                <dt>Auth mode</dt>
                <dd>{authModeLabel}</dd>
              </div>
            </dl>
          ) : (
            <div className="lf-note">
              Not signed in. Please log in to see your account details.
            </div>
          )}
        </div>

        {/* Gmail OAuth Connection */}
        <div className="lf-card">
          <div className="lf-card-header">
            <h2 className="lf-card-title">Email (Gmail OAuth)</h2>
            <span className={`lf-pill ${emailConnected ? (emailIntegration?.needsReconnect ? '' : 'lf-pill-on') : ''}`}>
              {emailConnected
                ? (emailIntegration?.needsReconnect ? '● Reconnect required' : '● Connected')
                : 'Not connected'}
            </span>
          </div>
          <div className="lf-note" style={{ marginBottom: 12 }}>
            Connect your Gmail account via OAuth to enable email campaigns and inbox sync.
            The connected account is the source of truth for the sender identity.
          </div>
          {emailConnected && emailIntegration?.needsReconnect && (
            <div className="lf-alert-error" style={{ marginBottom: 12 }}>
              Gmail authorization expired (<code>invalid_grant</code>). Click <strong>Reconnect Gmail</strong> below,
              approve access again, then resend your quotation from Inbox.
            </div>
          )}
          {user ? (
            <div className="lf-deflist">
              <div className="lf-defrow">
                <dt>Account Email</dt>
                <dd>{user.email} <span style={{ fontSize: 11, color: 'var(--lf-text-secondary)' }}>(login only)</span></dd>
              </div>
                  {emailConnected ? (
                <>
                  <div className="lf-defrow">
                    <dt>Connected Gmail</dt>
                    <dd><strong style={{ color: emailIntegration?.needsReconnect ? '#fbbf24' : '#34d399' }}>{emailIntegration?.account || senderEmail || '—'}</strong></dd>
                  </div>
                  {(emailIntegration?.needsReconnect) && (
                    <div className="lf-defrow">
                      <dt>Fix connection</dt>
                      <dd>
                        <button
                          className="lf-btn lf-btn-primary"
                          disabled={emailConnecting}
                          onClick={handleEmailOAuthConnect}
                        >
                          {emailConnecting ? 'Reconnecting…' : 'Reconnect Gmail'}
                        </button>
                      </dd>
                    </div>
                  )}
                  <div className="lf-defrow">
                    <dt>Sender Email</dt>
                    <dd style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <input
                        className="lf-input"
                        style={{ minWidth: 220, maxWidth: 320 }}
                        type="email"
                        value={senderEmailInput}
                        onChange={(e) => setSenderEmailInput(e.target.value)}
                        placeholder="Override sender address (optional)"
                      />
                      <button
                        className="lf-btn"
                        disabled={senderEmailSaving}
                        onClick={async () => {
                          setSenderEmailSaving(true); setSenderEmailMsg('');
                          try {
                            const email = senderEmailInput.trim() || null;
                            const res = await setSenderEmail(email);
                            setSenderEmailState(res.senderEmail || '');
                            setSenderEmailInput(res.senderEmail || '');
                            setSenderEmailMsg('Sender email updated.');
                          } catch {
                            setSenderEmailMsg('Failed to update sender email.');
                          } finally {
                            setSenderEmailSaving(false);
                          }
                        }}
                      >
                        {senderEmailSaving ? 'Saving…' : 'Change'}
                      </button>
                      <button
                        className="lf-btn lf-btn-danger"
                        disabled={senderEmailSaving}
                        onClick={handleEmailDisconnect}
                      >
                        {senderEmailSaving ? 'Disconnecting…' : 'Disconnect'}
                      </button>
                    </dd>
                  </div>
                  {emailIntegration?.connectedAt && (
                    <div className="lf-defrow">
                      <dt>Last connected</dt>
                      <dd>{new Date(emailIntegration.connectedAt).toLocaleString()}</dd>
                    </div>
                  )}
                </>
              ) : (
                <div className="lf-defrow">
                  <dt>Connect Gmail</dt>
                  <dd style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      className="lf-input"
                      style={{ minWidth: 220, maxWidth: 320 }}
                      type="email"
                      value={senderEmailInput}
                      onChange={(e) => setSenderEmailInput(e.target.value)}
                      placeholder="e.g. hello@yourcompany.com"
                    />
                    <button
                      className="lf-btn lf-btn-primary"
                      disabled={emailConnecting}
                      onClick={handleEmailOAuthConnect}
                    >
                      {emailConnecting ? 'Connecting…' : 'Connect with Gmail'}
                    </button>
                  </dd>
                </div>
              )}
              {senderEmailMsg && (
                <div style={{ marginTop: 4, fontSize: 12, color: senderEmailMsg.includes('Failed') || senderEmailMsg.includes('blocked') ? 'var(--lf-danger)' : 'var(--lf-success)' }}>
                  {senderEmailMsg}
                </div>
              )}
              {emailConnecting && <div className="lf-skeleton" style={{ height: 4, marginTop: 8 }} />}
              <div className="lf-defrow" style={{ marginTop: 12 }}>
                <dt>Include unsubscribe footer</dt>
                <dd>
                  <label className="lf-toggle">
                    <input
                      type="checkbox"
                      checked={emailSettings?.includeUnsubscribeFooter ?? false}
                      onChange={async (e) => {
                        setEmailSettingsSaving(true); setEmailSettingsMsg('');
                        try {
                          const res = await updateEmailSettings({ includeUnsubscribeFooter: e.target.checked });
                          setEmailSettings(res.settings);
                          setEmailSettingsMsg(e.target.checked ? 'Unsubscribe footer enabled for marketing compliance.' : 'Unsubscribe footer disabled for CRM emails.');
                        } catch {
                          setEmailSettingsMsg('Failed to save email setting.');
                        } finally {
                          setEmailSettingsSaving(false);
                        }
                      }}
                    />
                    <span className="lf-toggle-slider" />
                  </label>
                  <div style={{ fontSize: 12, color: 'var(--lf-text-secondary)', marginTop: 6 }}>
                    Off by default for normal CRM/business emails. Enable only when you need marketing compliance.
                  </div>
                </dd>
              </div>
              {emailSettingsMsg && (
                <div style={{ marginTop: 4, fontSize: 12, color: emailSettingsMsg.includes('Failed') ? 'var(--lf-danger)' : 'var(--lf-success)' }}>
                  {emailSettingsMsg}
                </div>
              )}
              {emailSettingsSaving && <div className="lf-skeleton" style={{ height: 4, marginTop: 8 }} />}
            </div>
          ) : (
            <div className="lf-note">Sign in to connect your Gmail account.</div>
          )}
        </div>

        {/* Integrations Grid */}
        <div className="lf-card">
          <div className="lf-card-header">
            <h2 className="lf-card-title">Integrations</h2>
          </div>

          {loading ? (
            <div className="lf-skeleton" style={{ height: 120 }} />
          ) : (
            <div className="lf-deflist">
              {providers.map((provider: ProviderDefinition) => {
                const status = getStatus(provider.key);
                // For email, show the unified senderEmail instead of the OAuth auth account
                const displayAccount = provider.key === 'email' && senderEmail
                  ? senderEmail
                  : status?.account;
                return (
                  <div className="lf-defrow" key={provider.key}>
                    <dt>
                      <span style={{ marginRight: 8 }}>{provider.icon}</span>
                      {provider.name}
                    </dt>
                    <dd className="lf-defrow-action">
                      <span className={`lf-pill ${status?.connected ? 'lf-pill-on' : ''}`}>
                        {status?.connected
                          ? `● Connected${displayAccount ? ` — ${displayAccount}` : ''}`
                          : 'Not connected'}
                      </span>
                      <Link className="lf-link" to={provider.key === 'email' ? '/app/settings' : provider.managePath}>
                        {provider.key === 'email' ? 'Set in Settings →' : 'Manage →'}
                      </Link>
                    </dd>
                  </div>
                );
              })}
              <div className="lf-defrow">
                <dt>Scraper (SerpAPI)</dt>
                <dd className="lf-defrow-action">
                  <span className={`lf-pill ${scraperConfigured ? 'lf-pill-on' : ''}`}>
                    {scraperConfigured ? '● Configured' : 'Not connected'}
                  </span>
                  <Link className="lf-link" to="/app/scraper">Configure →</Link>
                </dd>
              </div>
            </div>
          )}
        </div>

        {/* Preview & Trust Mode */}
        <div className="lf-card">
          <div className="lf-card-header">
            <h2 className="lf-card-title">Preview & Testing</h2>
            <span className="lf-pill">Trust Mode</span>
          </div>
          <div className="lf-note" style={{ marginBottom: 12 }}>
            When enabled, a copy of every campaign message is sent to your own account so you can verify exactly what your leads receive.
          </div>
          {previewSettings ? (
            <div className="lf-deflist">
              <div className="lf-defrow">
                <dt>Send WhatsApp Preview</dt>
                <dd>
                  <label className="lf-toggle">
                    <input
                      type="checkbox"
                      checked={previewSettings.whatsappPreview}
                      onChange={async (e) => {
                        setPreviewSaving(true); setPreviewMsg('');
                        try {
                          const res = await updatePreviewSettings({ whatsappPreview: e.target.checked });
                          setPreviewSettings(res.settings);
                          setPreviewMsg('WhatsApp preview setting saved.');
                        } catch { setPreviewMsg('Failed to save.'); }
                        finally { setPreviewSaving(false); }
                      }}
                    />
                    <span className="lf-toggle-slider" />
                  </label>
                </dd>
              </div>
              <div className="lf-defrow">
                <dt>Send Email Preview</dt>
                <dd>
                  <label className="lf-toggle">
                    <input
                      type="checkbox"
                      checked={previewSettings.emailPreview}
                      onChange={async (e) => {
                        setPreviewSaving(true); setPreviewMsg('');
                        try {
                          const res = await updatePreviewSettings({ emailPreview: e.target.checked });
                          setPreviewSettings(res.settings);
                          setPreviewMsg('Email preview setting saved.');
                        } catch { setPreviewMsg('Failed to save.'); }
                        finally { setPreviewSaving(false); }
                      }}
                    />
                    <span className="lf-toggle-slider" />
                  </label>
                </dd>
              </div>
              <div className="lf-defrow">
                <dt>Send SMS Preview</dt>
                <dd>
                  <label className="lf-toggle">
                    <input
                      type="checkbox"
                      checked={previewSettings.smsPreview}
                      onChange={async (e) => {
                        setPreviewSaving(true); setPreviewMsg('');
                        try {
                          const res = await updatePreviewSettings({ smsPreview: e.target.checked });
                          setPreviewSettings(res.settings);
                          setPreviewMsg('SMS preview setting saved.');
                        } catch { setPreviewMsg('Failed to save.'); }
                        finally { setPreviewSaving(false); }
                      }}
                    />
                    <span className="lf-toggle-slider" />
                  </label>
                </dd>
              </div>
              <div className="lf-defrow">
                <dt>Preview Phone Number</dt>
                <dd>
                  <input
                    className="lf-input"
                    style={{ maxWidth: 220 }}
                    value={previewSettings.previewPhone}
                    onChange={async (e) => {
                      const val = e.target.value;
                      setPreviewSettings((s) => s ? { ...s, previewPhone: val } : s);
                    }}
                    onBlur={async () => {
                      if (!previewSettings) return;
                      setPreviewSaving(true); setPreviewMsg('');
                      try {
                        const res = await updatePreviewSettings({ previewPhone: previewSettings.previewPhone });
                        setPreviewSettings(res.settings);
                        setPreviewMsg('Preview phone saved.');
                      } catch { setPreviewMsg('Failed to save.'); }
                      finally { setPreviewSaving(false); }
                    }}
                    placeholder="+1 555 0199"
                  />
                </dd>
              </div>
              <div className="lf-defrow">
                <dt>Preview Email</dt>
                <dd>
                  <input
                    className="lf-input"
                    style={{ maxWidth: 280 }}
                    value={previewSettings.previewEmail}
                    onChange={(e) => {
                      const val = e.target.value;
                      setPreviewSettings((s) => s ? { ...s, previewEmail: val } : s);
                    }}
                    onBlur={async () => {
                      if (!previewSettings) return;
                      setPreviewSaving(true); setPreviewMsg('');
                      try {
                        const res = await updatePreviewSettings({ previewEmail: previewSettings.previewEmail });
                        setPreviewSettings(res.settings);
                        setPreviewMsg('Preview email saved.');
                      } catch { setPreviewMsg('Failed to save.'); }
                      finally { setPreviewSaving(false); }
                    }}
                    placeholder="you@company.com"
                  />
                </dd>
              </div>
              {previewMsg && (
                <div style={{ marginTop: 8, fontSize: 12, color: previewMsg.includes('Failed') ? 'var(--lf-danger)' : 'var(--lf-success)' }}>
                  {previewMsg}
                </div>
              )}
              {previewSaving && <div className="lf-skeleton" style={{ height: 4, marginTop: 8 }} />}
            </div>
          ) : (
            <div className="lf-skeleton" style={{ height: 120 }} />
          )}
        </div>

        {/* AI Sales Agent Knowledge */}
        <div className="lf-card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginTop: 0 }}>AI Sales Agent</h3>
          <p style={{ color: 'var(--lf-muted)', fontSize: 13, marginTop: 0 }}>
            Train your workspace AI with business knowledge. This profile powers autonomous Email and WhatsApp replies in the shared Inbox.
          </p>
          {aiAgentLoaded && aiAgentSettings ? (
            <div className="lf-deflist">
              {aiKnowledgeStatus && (
                <div
                  style={{
                    marginBottom: 16,
                    padding: '12px 14px',
                    borderRadius: 10,
                    border: `1px solid ${aiKnowledgeStatus.level === 'complete' ? 'rgba(34,197,94,0.35)' : 'rgba(251,191,36,0.35)'}`,
                    background: aiKnowledgeStatus.level === 'complete' ? 'rgba(34,197,94,0.08)' : 'rgba(251,191,36,0.08)',
                    fontSize: 13,
                  }}
                >
                  <strong>{aiKnowledgeStatus.icon} {aiKnowledgeStatus.label}</strong>
                  <div style={{ marginTop: 4, color: 'var(--lf-text-secondary)' }}>{aiKnowledgeStatus.message}</div>
                </div>
              )}
              {aiAgentError && (
                <div className="lf-alert lf-alert-error" style={{ marginBottom: 12, fontSize: 12 }}>{aiAgentError}</div>
              )}
              <div className="lf-defrow">
                <dt>Autonomous Email Replies</dt>
                <dd>
                  <label className="lf-toggle">
                    <input
                      type="checkbox"
                      checked={aiAgentSettings.emailAutoReplyEnabled}
                      onChange={async (e) => {
                        setAiAgentSaving(true); setAiAgentMsg('');
                          try {
                            const res = await updateAiAgentSettings({ emailAutoReplyEnabled: e.target.checked });
                            setAiAgentSettings(res.settings);
                            if (res.knowledgeStatus) setAiKnowledgeStatus(res.knowledgeStatus);
                            setAiAgentMsg('Autonomous email reply setting saved.');
                        } catch { setAiAgentMsg('Failed to save.'); }
                        finally { setAiAgentSaving(false); }
                      }}
                    />
                    <span className="lf-toggle-slider" />
                  </label>
                </dd>
              </div>
              <div className="lf-defrow">
                <dt>Autonomous WhatsApp Replies</dt>
                <dd>
                  <label className="lf-toggle">
                    <input
                      type="checkbox"
                      checked={aiAgentSettings.whatsappAutoReplyEnabled !== false}
                      onChange={async (e) => {
                        setAiAgentSaving(true); setAiAgentMsg('');
                        try {
                          const res = await updateAiAgentSettings({ whatsappAutoReplyEnabled: e.target.checked });
                          setAiAgentSettings(res.settings);
                          if (res.knowledgeStatus) setAiKnowledgeStatus(res.knowledgeStatus);
                          setAiAgentMsg('Autonomous WhatsApp reply setting saved.');
                        } catch { setAiAgentMsg('Failed to save.'); }
                        finally { setAiAgentSaving(false); }
                      }}
                    />
                    <span className="lf-toggle-slider" />
                  </label>
                </dd>
              </div>
              {([
                ['businessName', 'Business Name', 'text'],
                ['companyDescription', 'Company Description', 'textarea'],
                ['products', 'Products', 'textarea'],
                ['services', 'Services', 'textarea'],
                ['pricing', 'Pricing', 'textarea'],
                ['features', 'Features', 'textarea'],
                ['offers', 'Offers', 'textarea'],
                ['promotions', 'Promotions', 'textarea'],
                ['faqs', 'FAQs', 'textarea'],
                ['objectionHandling', 'Objection Handling', 'textarea'],
                ['salesTone', 'Sales Tone', 'text'],
                ['writingStyle', 'Writing Style', 'text'],
                ['callToAction', 'Call To Action', 'text'],
                ['companyPolicies', 'Company Policies', 'textarea'],
                ['appointmentInstructions', 'Appointment Booking Instructions', 'textarea'],
                ['supportInfo', 'Support Information', 'textarea'],
              ] as const).map(([key, label, kind]) => (
                <div className={`lf-defrow${kind === 'textarea' ? ' lf-defrow-knowledge' : ''}`} key={key}>
                  <dt>{label}</dt>
                  <dd>
                    {kind === 'textarea' ? (
                      <textarea
                        className="lf-input lf-ai-knowledge-textarea"
                        rows={10}
                        value={(aiAgentSettings as any)[key] || ''}
                        onChange={(e) => setAiAgentSettings((s) => s ? { ...s, [key]: e.target.value } : s)}
                        onBlur={async () => {
                          if (!aiAgentSettings) return;
                          setAiAgentSaving(true); setAiAgentMsg('');
                          try {
                            const res = await updateAiAgentSettings({ [key]: (aiAgentSettings as any)[key] });
                            setAiAgentSettings(res.settings);
                            if (res.knowledgeStatus) setAiKnowledgeStatus(res.knowledgeStatus);
                            setAiAgentMsg('AI Sales Agent profile saved.');
                          } catch { setAiAgentMsg('Failed to save.'); }
                          finally { setAiAgentSaving(false); }
                        }}
                      />
                    ) : (
                      <input
                        className="lf-input"
                        value={(aiAgentSettings as any)[key] || ''}
                        onChange={(e) => setAiAgentSettings((s) => s ? { ...s, [key]: e.target.value } : s)}
                        onBlur={async () => {
                          if (!aiAgentSettings) return;
                          setAiAgentSaving(true); setAiAgentMsg('');
                          try {
                            const res = await updateAiAgentSettings({ [key]: (aiAgentSettings as any)[key] });
                            setAiAgentSettings(res.settings);
                            if (res.knowledgeStatus) setAiKnowledgeStatus(res.knowledgeStatus);
                            setAiAgentMsg('AI Sales Agent profile saved.');
                          } catch { setAiAgentMsg('Failed to save.'); }
                          finally { setAiAgentSaving(false); }
                        }}
                      />
                    )}
                  </dd>
                </div>
              ))}
              {aiAgentMsg && (
                <div style={{ marginTop: 8, fontSize: 12, color: aiAgentMsg.includes('Failed') ? 'var(--lf-danger)' : 'var(--lf-success)' }}>
                  {aiAgentMsg}
                </div>
              )}
              {aiAgentSaving && <div className="lf-skeleton" style={{ height: 4, marginTop: 8 }} />}
            </div>
          ) : !aiAgentLoaded ? (
            <div className="lf-skeleton" style={{ height: 180 }} />
          ) : (
            <div className="lf-alert lf-alert-error">Failed to initialize AI Sales Agent settings.</div>
          )}
        </div>

        {/* OpenAI API Key Management */}
        <OpenAiSettings />

        {/* Connection Cards — detailed connection UI per provider */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {providers.map((provider: ProviderDefinition) => (
            <ConnectionCard
              key={provider.key}
              provider={provider}
              status={getStatus(provider.key)}
              onChange={load}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
