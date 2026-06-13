import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { setAccessToken } from './authConfig';
import { getSupabase } from './supabaseClient';

function applyToken(token) {
  setAccessToken(token);
  if (token) {
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete axios.defaults.headers.common['Authorization'];
  }
}

// Supabase session gate. Loaded lazily (only when AUTH_MODE=supabase) so the
// default disabled build never bundles the Supabase client.
export default function SupabaseGate({ children }) {
  const supabase = getSupabase();

  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      applyToken(data.session?.access_token);
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      applyToken(s?.access_token);
      setSession(s);
    });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, [supabase]);

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) setError(err.message);
  }

  if (loading) {
    return <div style={{ padding: 40, fontFamily: 'sans-serif' }}>Loading…</div>;
  }

  if (!session) {
    return (
      <div style={{ maxWidth: 360, margin: '80px auto', fontFamily: 'sans-serif' }}>
        <h2>Sign in to LeadFlow AI</h2>
        <form onSubmit={handleLogin}>
          <input type="email" placeholder="Email" value={email}
            onChange={(e) => setEmail(e.target.value)} required
            style={{ display: 'block', width: '100%', padding: 10, marginBottom: 10 }} />
          <input type="password" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} required
            style={{ display: 'block', width: '100%', padding: 10, marginBottom: 10 }} />
          <button type="submit" style={{ width: '100%', padding: 10 }}>Sign in</button>
          {error && <p style={{ color: 'crimson' }}>{error}</p>}
        </form>
      </div>
    );
  }

  return children;
}
