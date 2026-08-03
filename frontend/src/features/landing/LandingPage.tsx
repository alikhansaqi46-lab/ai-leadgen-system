import { Link } from 'react-router-dom';
import Logo from '../../components/Logo';
import './landing.css';

export default function LandingPage() {
  return (
    <div className="lf-landing">
      {/* Navbar */}
      <nav className="lf-landing-nav">
        <div className="lf-landing-nav-inner">
          <Link to="/" className="lf-landing-brand">
            <Logo size={40} />
            <span>LeadFlow AI</span>
          </Link>
          <div className="lf-landing-nav-links">
            <a href="#features">Features</a>
            <a href="#how-it-works">How It Works</a>
            <Link to="/pricing">Pricing</Link>
            <Link to="/login" className="lf-landing-nav-login">Sign In</Link>
            <Link to="/signup" className="lf-landing-nav-cta">Get Started</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="lf-landing-hero">
        <div className="lf-landing-hero-inner">
          <div className="lf-landing-hero-badge">AI-Powered Lead Generation</div>
          <h1>
            Find, Qualify & Reach<br />
            <span className="gradient-text">High-Intent Leads</span> on Autopilot
          </h1>
          <p className="lf-landing-hero-sub">
            LeadFlow AI scrapes targeted business leads from Google Maps, scores them with AI,
            and automates WhatsApp, Email & SMS outreach — so you can close more deals.
          </p>
          <div className="lf-landing-hero-ctas">
            <Link to="/signup" className="lf-landing-btn-primary">Start Free Trial</Link>
            <Link to="/pricing" className="lf-landing-btn-secondary">View Pricing</Link>
          </div>
          <div className="lf-landing-hero-stats">
            <div><strong>10,000+</strong><span>Leads Generated</span></div>
            <div><strong>3 Channels</strong><span>WhatsApp · Email · SMS</span></div>
            <div><strong>AI Scoring</strong><span>Hot / Warm / Cold</span></div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="lf-landing-section">
        <div className="lf-landing-section-inner">
          <h2>Everything you need to scale your outreach</h2>
          <p className="lf-landing-section-desc">
            From scraping to closing — one platform does it all.
          </p>
          <div className="lf-landing-features">
            <div className="lf-landing-feature">
              <div className="lf-landing-feature-icon">🔍</div>
              <h3>Smart Lead Scraping</h3>
              <p>Extract business leads from Google Maps with emails, phones, ratings, and addresses — up to 500 per search.</p>
            </div>
            <div className="lf-landing-feature">
              <div className="lf-landing-feature-icon">🤖</div>
              <h3>AI Lead Qualification</h3>
              <p>Automatically score leads 0-100 based on contactability, web presence, reputation, and niche fit.</p>
            </div>
            <div className="lf-landing-feature">
              <div className="lf-landing-feature-icon">💬</div>
              <h3>WhatsApp Automation</h3>
              <p>Bulk-send personalized WhatsApp messages using Meta Cloud API. 300+ templates in 12 languages.</p>
            </div>
            <div className="lf-landing-feature">
              <div className="lf-landing-feature-icon">✉️</div>
              <h3>Email Campaigns</h3>
              <p>Send personalized cold emails with AI-generated copy. Track opens, replies, and conversions.</p>
            </div>
            <div className="lf-landing-feature">
              <div className="lf-landing-feature-icon">📊</div>
              <h3>Unified Inbox & CRM</h3>
              <p>Manage all conversations in one place. Track lead status from "New" → "Sent" → "Deal".</p>
            </div>
            <div className="lf-landing-feature">
              <div className="lf-landing-feature-icon">📁</div>
              <h3>CSV Export & Reports</h3>
              <p>Download leads, campaign analytics, and performance reports for your clients or team.</p>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="lf-landing-section lf-landing-dark">
        <div className="lf-landing-section-inner">
          <h2>How it works</h2>
          <div className="lf-landing-steps">
            <div className="lf-landing-step">
              <div className="lf-landing-step-num">1</div>
              <h4>Enter Search</h4>
              <p>Type a niche and location (e.g., "Dentists in Kuala Lumpur").</p>
            </div>
            <div className="lf-landing-step-arrow">→</div>
            <div className="lf-landing-step">
              <div className="lf-landing-step-num">2</div>
              <h4>Scrape Leads</h4>
              <p>LeadFlow AI pulls businesses with full contact data in seconds.</p>
            </div>
            <div className="lf-landing-step-arrow">→</div>
            <div className="lf-landing-step">
              <div className="lf-landing-step-num">3</div>
              <h4>AI Qualifies</h4>
              <p>Each lead is scored Hot, Warm, or Cold so you know who to contact first.</p>
            </div>
            <div className="lf-landing-step-arrow">→</div>
            <div className="lf-landing-step">
              <div className="lf-landing-step-num">4</div>
              <h4>Launch Campaign</h4>
              <p>Send WhatsApp, Email, or SMS outreach in bulk with one click.</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="lf-landing-cta">
        <div className="lf-landing-cta-inner">
          <h2>Ready to fill your pipeline?</h2>
          <p>Join freelancers and agencies using LeadFlow AI to win more clients.</p>
          <Link to="/pricing" className="lf-landing-btn-primary lg">Start Free Trial</Link>
        </div>
      </section>

      {/* Footer */}
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
            <Link to="/pricing">Pricing</Link>
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
