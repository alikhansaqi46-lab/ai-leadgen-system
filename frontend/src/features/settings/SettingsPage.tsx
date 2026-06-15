import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../common/PageHeader';
import { getWhatsAppStatus, getEmailStatus } from '../../lib/apiClient';
// Auth helpers are legacy JS modules (allowJs).
import { AUTH_MODE } from '../../auth/authConfig';

interface Account {
  email: string;
  workspaceId: string;
}

function StatusPill({ on, labelOn = 'Connected', labelOff = 'Not configured' }: { on: boolean; labelOn?: string; labelOff?: string }) {
  return <span className={`lf-pill ${on ? 'lf-pill-on' : ''}`}>{on ? `● ${labelOn}` : labelOff}</span>;
}

export default function SettingsPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [whatsapp, setWhatsapp] = useState<boolean | null>(null);
  const [email, setEmail] = useState<boolean | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const supabaseMode = AUTH_MODE === 'supabase';

  useEffect(() => {
    let active = true;

    if (supabaseMode) {
      import('../../auth/supabaseClient')
        .then(({ getSupabase }) => getSupabase().auth.getSession())
        .then(({ data }: { data: { session: { user?: { email?: string; id?: string } } | null } }) => {
          if (!active) return;
          const user = data.session?.user;
          if (user) setAccount({ email: user.email || '—', workspaceId: user.id || '—' });
        })
        .catch(() => {
          /* session lookup best-effort */
        });
    }

    getWhatsAppStatus()
      .then((s) => active && setWhatsapp(Boolean(s.configured)))
      .catch(() => active && setWhatsapp(false));
    getEmailStatus()
      .then((s) => active && setEmail(Boolean(s.configured)))
      .catch(() => active && setEmail(false));

    return () => {
      active = false;
    };
  }, [supabaseMode]);

  const signOut = async () => {
    if (!supabaseMode) return;
    setSigningOut(true);
    try {
      const { getSupabase } = await import('../../auth/supabaseClient');
      await getSupabase().auth.signOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="lf-page">
      <PageHeader title="Settings" subtitle="Workspace, account, and integrations" />

      <div className="lf-stack">
        <div className="lf-card">
          <div className="lf-card-header">
            <h2 className="lf-card-title">Account</h2>
            {supabaseMode ? (
              <button className="lf-btn" onClick={signOut} disabled={signingOut}>
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            ) : null}
          </div>
          {supabaseMode ? (
            <dl className="lf-deflist">
              <div className="lf-defrow">
                <dt>Signed in as</dt>
                <dd>{account?.email ?? '…'}</dd>
              </div>
              <div className="lf-defrow">
                <dt>Workspace ID</dt>
                <dd><code>{account?.workspaceId ?? '…'}</code></dd>
              </div>
              <div className="lf-defrow">
                <dt>Auth mode</dt>
                <dd>Supabase (ES256 / JWKS)</dd>
              </div>
            </dl>
          ) : (
            <div className="lf-note">
              Running in local mode (<code>AUTH_MODE=disabled</code>). All data lives in the default
              workspace. Sign-in and per-user workspaces activate when the backend runs with Supabase auth.
            </div>
          )}
        </div>

        <div className="lf-card">
          <div className="lf-card-header">
            <h2 className="lf-card-title">Integrations</h2>
          </div>
          <div className="lf-deflist">
            <div className="lf-defrow">
              <dt>WhatsApp</dt>
              <dd className="lf-defrow-action">
                <StatusPill on={Boolean(whatsapp)} />
                <Link className="lf-link" to="/app/whatsapp">Manage →</Link>
              </dd>
            </div>
            <div className="lf-defrow">
              <dt>Email</dt>
              <dd className="lf-defrow-action">
                <StatusPill on={Boolean(email)} labelOn="Configured" />
                <Link className="lf-link" to="/app/email">Manage →</Link>
              </dd>
            </div>
            <div className="lf-defrow">
              <dt>Scraper (SerpAPI)</dt>
              <dd className="lf-defrow-action">
                <span className="lf-muted">Configured via backend <code>SERPAPI_KEY</code></span>
                <Link className="lf-link" to="/app/scraper">Open →</Link>
              </dd>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
