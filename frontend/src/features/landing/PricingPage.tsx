import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Logo from '../../components/Logo';
import { getPayPalPlans, createPayPalSubscription, getSubscriptionStatus } from '../../lib/apiClient';
import './landing.css';

declare global {
  interface Window {
    paypal?: any;
  }
}

interface Plan {
  key: string;
  name: string;
  price: string;
  planId: string;
  features: string[];
}

export default function PricingPage() {
  const [plans, setPlans] = useState<Plan[]>([
    { key: 'starter', name: 'Starter', price: '$20/month', planId: '', features: ['500 leads/month', 'WhatsApp outreach', 'Email campaigns', 'Basic analytics'] },
    { key: 'pro', name: 'Pro', price: '$50/month', planId: '', features: ['2,000 leads/month', 'All Starter features', 'AI message generation', 'Multi-channel inbox', 'CSV exports'] },
    { key: 'agency', name: 'Agency', price: '$100/month', planId: '', features: ['Unlimited leads', 'All Pro features', 'White-label reports', 'Priority support', 'Sub-accounts'] },
  ]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchParams] = useSearchParams();
  const canceled = searchParams.get('canceled');
  const paypalLoaded = useRef(false);

  useEffect(() => {
    getPayPalPlans()
      .then((res: { success: boolean; plans: Plan[] }) => {
        if (res.plans?.length) {
          setPlans(res.plans.map((p) => ({
            key: p.key,
            name: p.name,
            price: p.price,
            planId: p.planId,
            features: p.features,
          })));
        }
      })
      .catch(() => {/* use defaults */})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (loading || paypalLoaded.current) return;
    const clientId = process.env.REACT_APP_PAYPAL_CLIENT_ID;
    if (!clientId) return;
    if (document.getElementById('paypal-script')) return;

    const script = document.createElement('script');
    script.id = 'paypal-script';
    script.src = `https://www.paypal.com/sdk/js?client-id=${clientId}&vault=true&intent=subscription`;
    script.async = true;
    script.onload = () => { paypalLoaded.current = true; };
    document.body.appendChild(script);
  }, [loading]);

  return (
    <div className="lf-landing">
      <nav className="lf-landing-nav">
        <div className="lf-landing-nav-inner">
          <Link to="/" className="lf-landing-brand">
            <Logo size={40} />
            <span>LeadFlow AI</span>
          </Link>
          <div className="lf-landing-nav-links">
            <Link to="/">Home</Link>
            <Link to="/login" className="lf-landing-nav-login">Sign In</Link>
            <Link to="/signup" className="lf-landing-nav-cta">Get Started</Link>
          </div>
        </div>
      </nav>

      <section className="lf-landing-hero" style={{ paddingTop: 60, paddingBottom: 40 }}>
        <div className="lf-landing-hero-inner">
          <h1 style={{ fontSize: 40 }}>Simple, Transparent Pricing</h1>
          <p className="lf-landing-hero-sub">
            Start free, upgrade when you're ready. No hidden fees.
          </p>
          {canceled && (
            <div style={{ background: 'rgba(239,68,68,0.1)', color: '#fca5a5', padding: '12px 20px', borderRadius: 10, marginBottom: 20, fontSize: 14 }}>
              Payment was canceled. You can try again below.
            </div>
          )}
        </div>
      </section>

      <section className="lf-landing-section" style={{ paddingTop: 20 }}>
        <div className="lf-landing-section-inner">
          {error && (
            <div style={{ textAlign: 'center', color: '#fca5a5', marginBottom: 20 }}>{error}</div>
          )}
          <div className="lf-pricing-plans">
            {plans.map((plan) => (
              <PricingCard key={plan.key} plan={plan} onError={setError} />
            ))}
          </div>
        </div>
      </section>

      <section className="lf-landing-cta">
        <div className="lf-landing-cta-inner">
          <h2>Questions?</h2>
          <p>Email us at support@leadflowai.com — we're here to help.</p>
          <Link to="/" className="lf-landing-btn-secondary">Back to Home</Link>
        </div>
      </section>

      <footer className="lf-landing-footer">
        <div className="lf-landing-footer-inner">
          <div>
            <div className="lf-landing-footer-brand">
              <Logo size={28} />
              <span>LeadFlow AI</span>
            </div>
            <p>Autonomous AI lead generation & outreach platform.</p>
          </div>
          <div className="lf-landing-footer-links">
            <Link to="/">Home</Link>
            <Link to="/login">Sign In</Link>
            <Link to="/signup">Get Started</Link>
          </div>
        </div>
        <div className="lf-landing-footer-copy">
          © {new Date().getFullYear()} LeadFlow AI. All rights reserved.
        </div>
      </footer>
    </div>
  );
}

function PricingCard({ plan, onError }: { plan: Plan; onError: (msg: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    getSubscriptionStatus().catch(() => null).then(() => setIsLoggedIn(true));
  }, []);

  useEffect(() => {
    if (!window.paypal || !containerRef.current || !plan.planId) return;
    containerRef.current.innerHTML = '';

    try {
      window.paypal.Buttons({
        style: { shape: 'pill', color: 'blue', layout: 'vertical', label: 'subscribe' },
        createSubscription: async (_data: any, _actions: any) => {
          try {
            const res = await createPayPalSubscription(plan.key);
            if (!res.approvalUrl) throw new Error('No approval URL');
            window.location.href = res.approvalUrl;
            return res.subscriptionId;
          } catch (err: any) {
            onError(err.message || 'Failed to start subscription');
            throw err;
          }
        },
        onApprove: () => {
          // Redirect handled by PayPal return_url; this is a fallback
          window.location.href = '/app/settings?subscription=success';
        },
        onError: (err: any) => {
          console.error('PayPal button error:', err);
          onError('PayPal checkout error. Please try again.');
        },
      }).render(containerRef.current);
    } catch (err) {
      console.error('PayPal render error:', err);
    }
  }, [plan.planId, plan.key, onError]);

  const isPopular = plan.key === 'pro';

  return (
    <div className={`lf-pricing-card${isPopular ? ' popular' : ''}`}>
      {isPopular && <div className="lf-pricing-badge">Most Popular</div>}
      <h3>{plan.name}</h3>
      <div className="price">{plan.price.replace('/month', '')}<span>/month</span></div>
      <p className="desc">
        {plan.key === 'starter' && 'Perfect for freelancers just starting out.'}
        {plan.key === 'pro' && 'Best for agencies running multiple campaigns.'}
        {plan.key === 'agency' && 'For power users who need unlimited scale.'}
      </p>
      <ul className="lf-pricing-features">
        {plan.features.map((f, i) => (
          <li key={i}><span className="check">✓</span> {f}</li>
        ))}
      </ul>
      {plan.planId ? (
        <div ref={containerRef} />
      ) : (
        <Link to={isLoggedIn ? '/app/settings' : '/signup'} className="lf-landing-btn-primary">
          {isLoggedIn ? 'Choose Plan' : 'Get Started'}
        </Link>
      )}
    </div>
  );
}
