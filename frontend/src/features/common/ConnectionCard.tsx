import { useState, useCallback } from 'react';
import axios from 'axios';
import { getOAuthUrl, connectIntegrationApiKey, disconnectIntegration, IntegrationStatus } from '../../lib/apiClient';

interface ProviderConfig {
  key: string;
  name: string;
  icon: string;
  authType: 'oauth2' | 'api_key' | 'basic_auth';
  fields?: { key: string; label: string; type: string; required: boolean }[] | null;
}

interface ConnectionCardProps {
  provider: ProviderConfig;
  status?: IntegrationStatus | null;
  onChange?: () => void;
}

export default function ConnectionCard({ provider, status, onChange }: ConnectionCardProps) {
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const connected = status?.connected || false;

  const handleOAuthConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const res = await getOAuthUrl(provider.key);
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
          setError('Popup blocked. Please allow popups for this site.');
          setConnecting(false);
          return;
        }

        // Listen for OAuth completion or error message from popup
        const listener = (event: MessageEvent) => {
          if (event.data?.provider !== provider.key) return;
          if (event.data?.type === 'oauth-success') {
            window.removeEventListener('message', listener);
            setConnecting(false);
            onChange?.();
          } else if (event.data?.type === 'oauth-error') {
            window.removeEventListener('message', listener);
            setConnecting(false);
            setError(event.data?.error || 'OAuth connection failed');
          }
        };
        window.addEventListener('message', listener);

        // Fallback: poll if popup closes without message
        const checkClosed = setInterval(() => {
          if (popup.closed) {
            clearInterval(checkClosed);
            window.removeEventListener('message', listener);
            setConnecting(false);
            onChange?.();
          }
        }, 500);
      }
    } catch (err) {
      let msg = 'Connection failed';
      if (axios.isAxiosError(err)) {
        const data = err.response?.data as { message?: string; error?: string } | undefined;
        msg = data?.message || data?.error || err.message;
      } else if (err instanceof Error) {
        msg = err.message;
      }
      setError(msg);
      setConnecting(false);
    }
  }, [provider.key, provider.authType, onChange]);

  const handleApiKeyConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const res = await connectIntegrationApiKey(provider.key, formData);
      if (res.success) {
        setFormData({});
        onChange?.();
      } else {
        setError(res.message || 'Connection failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setConnecting(false);
    }
  }, [provider.key, formData, onChange]);

  const handleDisconnect = useCallback(async () => {
    setError(null);
    setDisconnecting(true);
    try {
      await disconnectIntegration(provider.key);
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed');
    } finally {
      setDisconnecting(false);
    }
  }, [provider.key, onChange]);

  return (
    <div className="lf-card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div className="lf-kpi-icon-wrap lf-kpi-icon-cyan" style={{ marginBottom: 0 }}>
          {provider.icon}
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{provider.name}</div>
          <div style={{ fontSize: 13, color: 'var(--lf-text-secondary)' }}>
            {connected
              ? `● Connected${status?.account ? ` — ${status.account}` : ''}`
              : 'Not connected'}
          </div>
        </div>
      </div>

      {error && <div className="lf-alert lf-alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {connected ? (
        <button className="lf-btn" onClick={handleDisconnect} disabled={disconnecting}>
          {disconnecting ? 'Disconnecting…' : 'Disconnect'}
        </button>
      ) : provider.authType === 'oauth2' ? (
        <button className="lf-btn lf-btn-primary" onClick={handleOAuthConnect} disabled={connecting}>
          {connecting ? 'Connecting…' : `Connect ${provider.name}`}
        </button>
      ) : (
        <>
          {provider.fields?.map((field) => (
            <div key={field.key} className="lf-field" style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, fontWeight: 600 }}>{field.label}</label>
              <input
                className="lf-input"
                type={field.type}
                placeholder={field.label}
                value={formData[field.key] || ''}
                onChange={(e) => setFormData((prev) => ({ ...prev, [field.key]: e.target.value }))}
                style={{ width: '100%', marginTop: 4 }}
              />
            </div>
          ))}
          <button
            className="lf-btn lf-btn-primary"
            onClick={handleApiKeyConnect}
            disabled={connecting || provider.fields?.some((f) => f.required && !formData[f.key])}
          >
            {connecting ? 'Connecting…' : `Connect ${provider.name}`}
          </button>
        </>
      )}
    </div>
  );
}
