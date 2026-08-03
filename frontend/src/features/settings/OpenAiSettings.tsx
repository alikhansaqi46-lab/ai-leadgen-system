import { useState, useEffect, useCallback } from 'react';
import { getOpenAiStatus, saveOpenAiKey, deleteOpenAiKey, testOpenAiKey } from '../../lib/apiClient';

export default function OpenAiSettings() {
  const [status, setStatus] = useState({
    enabled: false,
    source: 'master',
    freeMessagesRemaining: 0,
    freeMessagesTotal: 100,
    masterConfigured: false,
  });
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const res = await getOpenAiStatus();
      setStatus(res);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load OpenAI status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError('Please enter an API key.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const res = await saveOpenAiKey(apiKey.trim());
      setSuccess(res.message);
      setApiKey('');
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || err.response?.data?.detail || 'Failed to save API key.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Remove your OpenAI API key? You will revert to using the master key (if available) with free message limits.')) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const res = await deleteOpenAiKey();
      setSuccess(res.message);
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to remove API key.');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError('');
    setSuccess('');
    try {
      const res = await testOpenAiKey();
      if (res.valid) {
        setSuccess('Connection successful! Your API key is working.');
      } else {
        setError(res.error || 'Connection failed. Check your API key.');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to test connection.');
    } finally {
      setTesting(false);
    }
  };

  const isUsingOwnKey = status.enabled && status.source === 'user';
  const isUsingMaster = !status.enabled && status.source === 'master';

  return (
    <div className="lf-card">
      <div className="lf-card-header">
        <h2 className="lf-card-title">OpenAI API</h2>
        <span
          className={`lf-pill ${isUsingOwnKey ? 'lf-pill-on' : ''}`}
          style={{
            background: isUsingOwnKey
              ? 'rgba(34,197,94,0.12)'
              : isUsingMaster
              ? 'rgba(56,189,248,0.12)'
              : undefined,
            color: isUsingOwnKey ? '#4ade80' : isUsingMaster ? '#38bdf8' : undefined,
          }}
        >
          {isUsingOwnKey
            ? '● Using your key'
            : isUsingMaster
            ? '● Using master key'
            : '● Not configured'}
        </span>
      </div>

      {loading ? (
        <div className="lf-skeleton" style={{ height: 80 }} />
      ) : (
        <>
          {/* Free Messages Progress */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6, color: '#94a3b8' }}>
              <span>Free AI Messages</span>
              <span>
                {status.freeMessagesRemaining} / {status.freeMessagesTotal}
              </span>
            </div>
            <div
              style={{
                height: 8,
                borderRadius: 999,
                background: 'rgba(30,41,59,0.5)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${(status.freeMessagesRemaining / status.freeMessagesTotal) * 100}%`,
                  background: status.freeMessagesRemaining === 0 ? '#ef4444' : 'linear-gradient(135deg, #38bdf8, #818cf8)',
                  borderRadius: 999,
                  transition: 'width 0.5s ease',
                }}
              />
            </div>
            {status.freeMessagesRemaining === 0 && !isUsingOwnKey && (
              <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>
                You have used your {status.freeMessagesTotal} free AI messages.
                Add your own OpenAI API key below to continue using the AI Sales Agent.
              </p>
            )}
            {isUsingOwnKey && (
              <p style={{ color: '#4ade80', fontSize: 13, marginTop: 8 }}>
                You are using your own API key. No free message limits apply.
              </p>
            )}
          </div>

          {/* API Key Input */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#cbd5e1', marginBottom: 8 }}>
              OpenAI API Key
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={isUsingOwnKey ? 'Enter new key to update…' : 'sk-…'}
                disabled={saving}
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  borderRadius: 10,
                  border: '1px solid rgba(148,163,184,0.2)',
                  background: 'rgba(15,23,42,0.5)',
                  color: '#e2e8f0',
                  fontSize: 14,
                  outline: 'none',
                }}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="lf-btn"
                style={{ minWidth: 60 }}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              className="lf-btn lf-btn-primary"
              onClick={handleSave}
              disabled={saving || !apiKey.trim()}
            >
              {saving ? 'Saving…' : isUsingOwnKey ? 'Update Key' : 'Save Key'}
            </button>

            {isUsingOwnKey && (
              <button className="lf-btn lf-btn-secondary" onClick={handleDelete} disabled={saving}>
                {saving ? 'Removing…' : 'Delete Key'}
              </button>
            )}

            <button className="lf-btn" onClick={handleTest} disabled={testing}>
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
          </div>

          {/* Alerts */}
          {error && (
            <div className="lf-alert lf-alert-error" style={{ marginTop: 14 }}>
              {error}
            </div>
          )}
          {success && (
            <div className="lf-alert lf-alert-success" style={{ marginTop: 14 }}>
              {success}
            </div>
          )}
        </>
      )}
    </div>
  );
}
