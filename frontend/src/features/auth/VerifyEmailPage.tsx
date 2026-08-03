import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthLayout from './AuthLayout';
import { useAuth } from './AuthContext';

const PENDING_EMAIL_KEY = 'lf_pending_email';

export default function VerifyEmailPage() {
  const navigate = useNavigate();
  const { verifyEmail, resendEmailCode } = useAuth();

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [email, setEmail] = useState('');

  useEffect(() => {
    const pending = localStorage.getItem(PENDING_EMAIL_KEY);
    if (pending) setEmail(pending);
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!email) {
      setError('Email address is missing. Please sign up again.');
      return;
    }
    if (code.length !== 6) {
      setError('Please enter the 6-digit code.');
      return;
    }
    setLoading(true);
    try {
      await verifyEmail(email, code);
      setSuccess(true);
      localStorage.removeItem(PENDING_EMAIL_KEY);
      localStorage.setItem('login_success_message', 'Email verified successfully. You can now log in.');
      setTimeout(() => navigate('/login'), 1500);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Invalid code. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (countdown > 0 || !email) return;
    try {
      await resendEmailCode(email);
      setCountdown(60);
      setError('');
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to resend code.');
    }
  }

  return (
    <AuthLayout
      title="Verify your email"
      subtitle={`We sent a 6-digit code to ${email || 'your email address'}`}
    >
      {success ? (
        <div className="auth-success-block">
          <div className="auth-check">&#10003;</div>
          <h2 className="auth-success-title">Email verified</h2>
          <p className="auth-success-msg">Redirecting to sign in…</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <div className="auth-field">
            <label htmlFor="email-code" className="auth-label">Verification code</label>
            <input
              id="email-code"
              type="text"
              inputMode="numeric"
              maxLength={6}
              className="auth-input auth-input-code"
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="auth-btn-primary" disabled={loading}>
            {loading ? 'Verifying…' : 'Verify email'}
          </button>

          <button
            type="button"
            className="auth-btn-ghost"
            onClick={handleResend}
            disabled={countdown > 0}
          >
            {countdown > 0 ? `Resend code in ${countdown}s` : 'Resend code'}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
