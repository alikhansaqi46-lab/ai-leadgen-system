import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { setAccessToken, getAccessToken } from '../../auth/authConfig';

/* ------------------------------------------------------------------ */
// Types
/* ------------------------------------------------------------------ */

export interface AuthUser {
  id: string;
  fullName: string;
  businessName: string;
  email: string;
  whatsappNumber: string;
  emailVerified: boolean;
  role?: string;
  isAdmin?: boolean;
  subscriptionStatus?: string;
  subscriptionPlan?: string | null;
  subscriptionExpiresAt?: string | null;
  createdAt: string;
}

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string, remember?: boolean) => Promise<void>;
  logout: () => void;
  signup: (data: SignupData) => Promise<void>;
  verifyEmail: (email: string, code: string) => Promise<boolean>;
  resendEmailCode: (email: string) => Promise<void>;
  forgotPassword: (email: string) => Promise<void>;
  resetPassword: (email: string, code: string, newPassword: string) => Promise<boolean>;
  updateProfile: (updates: Partial<AuthUser>) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<boolean>;
}

export interface SignupData {
  fullName: string;
  businessName: string;
  email: string;
  whatsappNumber: string;
  password: string;
}

/* ------------------------------------------------------------------ */
// API client
/* ------------------------------------------------------------------ */

const API_BASE = process.env.REACT_APP_API_URL || '';

function api() {
  const token = getAccessToken();
  return axios.create({
    baseURL: API_BASE,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

const PENDING_EMAIL_KEY = 'lf_pending_email';

/* ------------------------------------------------------------------ */
// Context
/* ------------------------------------------------------------------ */

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/* ------------------------------------------------------------------ */
// Provider
/* ------------------------------------------------------------------ */

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();

  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
  });

  // Rehydrate user from token on mount
  useEffect(() => {
    let active = true;
    const token = getAccessToken();
    if (!token) {
      setState({ user: null, isAuthenticated: false, isLoading: false });
      return;
    }
    api()
      .get('/api/auth/me')
      .then(({ data }) => {
        if (!active) return;
        const user = data as AuthUser;
        user.isAdmin = user.role === 'super_admin' || user.role === 'admin';
        setState({ user, isAuthenticated: true, isLoading: false });
      })
      .catch(() => {
        if (!active) return;
        setAccessToken(null);
        setState({ user: null, isAuthenticated: false, isLoading: false });
      });
    return () => { active = false; };
  }, []);

  /* ----------------- login ----------------- */
  const login = useCallback(async (email: string, password: string, remember?: boolean) => {
    const { data } = await axios.post(`${API_BASE}/api/auth/login`, { email, password, rememberMe: !!remember });
    setAccessToken(data.token);
    localStorage.removeItem('lf_scrape_history');
    const user = data.user as AuthUser;
    user.isAdmin = user.role === 'super_admin' || user.role === 'admin';
    setState({ user, isAuthenticated: true, isLoading: false });
  }, []);

  /* ----------------- logout ----------------- */
  const logout = useCallback(() => {
    const token = getAccessToken();
    if (token) {
      axios.post(`${API_BASE}/api/auth/logout`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
    }
    setAccessToken(null);
    localStorage.removeItem(PENDING_EMAIL_KEY);
    setState({ user: null, isAuthenticated: false, isLoading: false });
    navigate('/login');
  }, [navigate]);

  /* ----------------- signup ----------------- */
  const signup = useCallback(async (data: SignupData) => {
    await axios.post(`${API_BASE}/api/auth/signup`, {
      fullName: data.fullName,
      businessName: data.businessName,
      email: data.email,
      whatsappNumber: data.whatsappNumber,
      password: data.password,
    });
    localStorage.setItem(PENDING_EMAIL_KEY, data.email);
  }, []);

  /* ----------------- verify email ----------------- */
  const verifyEmail = useCallback(async (email: string, code: string): Promise<boolean> => {
    await axios.post(`${API_BASE}/api/auth/verify-email`, { email, code });
    return true;
  }, []);

  /* ----------------- resend email code ----------------- */
  const resendEmailCode = useCallback(async (email: string) => {
    await axios.post(`${API_BASE}/api/auth/resend-verification`, { email });
  }, []);

  /* ----------------- forgot password ----------------- */
  const forgotPassword = useCallback(async (email: string) => {
    await axios.post(`${API_BASE}/api/auth/forgot-password`, { email });
    localStorage.setItem(PENDING_EMAIL_KEY, email);
  }, []);

  const resetPassword = useCallback(async (email: string, code: string, newPassword: string): Promise<boolean> => {
    await axios.post(`${API_BASE}/api/auth/reset-password`, { email, code, newPassword });
    return true;
  }, []);

  /* ----------------- profile / password ----------------- */
  const updateProfile = useCallback(async (updates: Partial<AuthUser>) => {
    const { data } = await api().put('/api/auth/me', updates);
    setState((s) => ({ ...s, user: data as AuthUser }));
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string): Promise<boolean> => {
    await api().post('/api/auth/change-password', { currentPassword, newPassword });
    return true;
  }, []);

  /* ------------------------------------------------------------------ */

  const value: AuthContextValue = {
    ...state,
    login,
    logout,
    signup,
    verifyEmail,
    resendEmailCode,
    forgotPassword,
    resetPassword,
    updateProfile,
    changePassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
