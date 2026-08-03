import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import PageHeader from '../common/PageHeader';
import { getSubscriptionStatus, cancelPayPalSubscription } from '../../lib/apiClient';

export default function SubscriptionPage() {
  const [status, setStatus] = useState<string>('none');
  const [plan, setPlan] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [searchParams] = useSearchParams();
  const success = searchParams.get('subscription') === 'success';

  const load = async () => {
    try {
      const res = await getSubscriptionStatus();
      setStatus(res.status);
      setPlan(res.plan);
      setExpiresAt(res.expiresAt);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleCancel = async () => {
    if (!window.confirm('Are you sure you want to cancel your subscription?')) return;
    setCancelling(true);
    try {
      await cancelPayPalSubscription();
      setStatus('cancelled');
    } catch {
      alert('Failed to cancel subscription. Please try again.');
    } finally {
      setCancelling(false);
    }
  };

  const planName = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : 'None';
  const isActive = status === 'active';

  return (
    <div className="lf-page">
      <PageHeader title="Subscription" subtitle="Manage your plan and billing" />

      {success && (
        <div className="lf-toast lf-toast-success" style={{ marginBottom: 16 }}>
          Welcome to LeadFlow AI! Your subscription is being processed. Refresh this page in a moment to see updates.
        </div>
      )}

      <div className="lf-card" style={{ maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>Current Plan</h3>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              padding: '4px 10px',
              borderRadius: 999,
              background: isActive ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.12)',
              color: isActive ? '#4ade80' : '#94a3b8',
            }}
          >
            {status}
          </span>
        </div>

        {loading ? (
          <p style={{ color: '#94a3b8', fontSize: 14 }}>Loading…</p>
        ) : (
          <>
            <div style={{ fontSize: 32, fontWeight: 800, marginBottom: 4 }}>{planName}</div>
            {expiresAt && (
              <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 16px' }}>
                Renews on {new Date(expiresAt).toLocaleDateString()}
              </p>
            )}

            {isActive ? (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  className="lf-btn lf-btn-secondary"
                  onClick={handleCancel}
                  disabled={cancelling}
                >
                  {cancelling ? 'Cancelling…' : 'Cancel Subscription'}
                </button>
                <Link to="/pricing" className="lf-btn lf-btn-primary">
                  Change Plan
                </Link>
              </div>
            ) : (
              <div>
                <p style={{ color: '#94a3b8', fontSize: 14, margin: '0 0 16px' }}>
                  You don’t have an active subscription. Upgrade to unlock all features.
                </p>
                <Link to="/pricing" className="lf-btn lf-btn-primary">
                  View Plans
                </Link>
              </div>
            )}
          </>
        )}
      </div>

      <div className="lf-card" style={{ maxWidth: 560, marginTop: 20 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>What’s included</h3>
        <ul style={{ paddingLeft: 18, margin: 0, color: '#cbd5e1', fontSize: 14, lineHeight: 1.7 }}>
          <li>Unlimited lead scraping (plan limits apply)</li>
          <li>AI lead qualification & scoring</li>
          <li>WhatsApp, Email & SMS outreach</li>
          <li>Unified inbox & conversation CRM</li>
          <li>Campaign analytics & CSV exports</li>
        </ul>
      </div>
    </div>
  );
}
