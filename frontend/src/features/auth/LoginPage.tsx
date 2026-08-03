import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthLayout from './AuthLayout';
import { useAuth } from './AuthContext';

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, resendEmailCode } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isVerificationError, setIsVerificationError] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    const successMsg = localStorage.getItem('login_success_message');
    if (successMsg) {
      setError(successMsg);
      localStorage.removeItem('login_success_message');
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsVerificationError(false);
    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password.');
      return;
    }
    setLoading(true);
    try {
      await login(email.trim(), password, rememberMe);
      navigate('/app');
    } catch (err: any) {
      const errorMsg =
        err?.response?.data?.error
        || err?.response?.data?.message
        || err?.message
        || 'Login failed. Please try again.';
      setError(errorMsg);
      if (String(errorMsg).toLowerCase().includes('verify your email')) {
        setIsVerificationError(true);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleResendVerification() {
    if (!email.trim()) {
      setError('Please enter your email address to resend the verification code.');
      return;
    }
    setResending(true);
    try {
      await resendEmailCode(email.trim());
      setError('Verification code sent. Please check your email.');
      setIsVerificationError(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to resend verification code.');
    } finally {
      setResending(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your LeadFlow AI account"
      footer={
        <p className="auth-footer-text">
          Don&apos;t have an account? <Link to="/signup" className="auth-link">Create one</Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit} className="auth-form" noValidate>
        <div className="auth-field">
          <label htmlFor="login-email" className="auth-label">Email address</label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            className="auth-input"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="auth-field">
          <label htmlFor="login-password" className="auth-label">Password</label>
          <div className="auth-input-wrapper">
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              className="auth-input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              type="button"
              className="auth-input-toggle"
              onClick={() => setShowPassword((s) => !s)}
              tabIndex={-1}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <div className="auth-row-between">
          <label className="auth-checkbox-label">
            <input
              type="checkbox"
              className="auth-checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            <span>Remember me</span>
          </label>
          <Link to="/forgot-password" className="auth-link-small">Forgot password?</Link>
        </div>

        {error && <div className="auth-error">{error}</div>}

        {isVerificationError && (
          <button
            type="button"
            className="auth-btn-ghost"
            onClick={handleResendVerification}
            disabled={resending}
          >
            {resending ? 'Sending…' : 'Resend Verification Code'}
          </button>
        )}

        <button type="submit" className="auth-btn-primary" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthLayout>
  );
}
