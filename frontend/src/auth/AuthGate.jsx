import React, { Suspense } from 'react';
import { AUTH_MODE } from './authConfig';

/**
 * S2 AuthGate — provider-abstracted authentication wrapper.
 *
 * AUTH_MODE=disabled (default): renders children directly. No login, no token,
 * and (thanks to lazy loading) the Supabase client is never bundled — identical
 * to pre-S2 behavior.
 *
 * AUTH_MODE=supabase: lazily loads the Supabase session gate.
 */
const SupabaseGate = React.lazy(() => import('./SupabaseGate'));

export default function AuthGate({ children }) {
  if (AUTH_MODE === 'supabase') {
    return (
      <Suspense fallback={<div style={{ padding: 40, fontFamily: 'sans-serif' }}>Loading…</div>}>
        <SupabaseGate>{children}</SupabaseGate>
      </Suspense>
    );
  }
  // disabled (default) and any unknown mode → no-op gate.
  return children;
}
