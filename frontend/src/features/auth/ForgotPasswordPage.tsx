import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthLayout from './AuthLayout';
import { useAuth } from './AuthContext';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const { forgotPassword, resetPassword } = useAuth();

  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const PENDING_EMAIL_KEY = 'lf_pending_email';

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }
    setLoading(true);
    try {
      await forgotPassword(email.trim());
      localStorage.setItem(PENDING_EMAIL_KEY, email.trim());
      setStep('reset');
    } catch (err: any) {
      setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (code.length !== 6) {
      setError('Please enter the 6-digit reset code.');
      return;
    }
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    const resetEmail = localStorage.getItem(PENDING_EMAIL_KEY);
    if (!resetEmail) {
      setLoading(false);
      setError('Email address is missing. Please request a new reset code.');
      return;
    }
    try {
      await resetPassword(resetEmail, code, newPassword);
      localStorage.removeItem(PENDING_EMAIL_KEY);
      setSuccess(true);
      setTimeout(() => navigate('/login'), 2000);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Invalid reset code. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title={step === 'request' ? 'Reset password' : 'Create new password'}
      subtitle={
        step === 'request'
          ? 'Enter your email and we will send a reset code.'
          : 'Enter the code we sent to your email and your new password.'
      }
      footer={
        <p className="auth-footer-text">
          <Link to="/login" className="auth-link">Back to sign in</Link>
        </p>
      }
    >
      {success ? (
        <div className="auth-success-block">
          <div className="auth-check">&#10003;</div>
          <h2 className="auth-success-title">Password updated</h2>
          <p className="auth-success-msg">Redirecting to sign in…</p>
        </div>
      ) : step === 'request' ? (
        <form onSubmit={handleRequest} className="auth-form" noValidate>
          <div className="auth-field">
            <label htmlFor="fp-email" className="auth-label">Email address</label>
            <input
              id="fp-email"
              type="email"
              autoComplete="email"
              className="auth-input"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="auth-btn-primary" disabled={loading}>
            {loading ? 'Sending…' : 'Send reset code'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleReset} className="auth-form" noValidate>
          <div className="auth-field">
            <label htmlFor="fp-code" className="auth-label">Reset code</label>
            <input
              id="fp-code"
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
          <div className="auth-field">
            <label htmlFor="fp-new" className="auth-label">New password</label>
            <input
              id="fp-new"
              type="password"
              autoComplete="new-password"
              className="auth-input"
              placeholder="••••••••"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </div>
          <div className="auth-field">
            <label htmlFor="fp-confirm" className="auth-label">Confirm new password</label>
            <input
              id="fp-confirm"
              type="password"
              autoComplete="new-password"
              className="auth-input"
              placeholder="••••••••"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="auth-btn-primary" disabled={loading}>
            {loading ? 'Updating…' : 'Update password'}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
