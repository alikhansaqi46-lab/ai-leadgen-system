/**
 * AuthGate - passthrough for the custom AuthProvider flow.
 *
 * Login / signup / verify-email / forgot-password are owned by
 * frontend/src/features/auth (AuthContext -> POST /api/auth/*).
 * Do not wrap those pages in SupabaseGate; that path conflicts with the
 * working custom JWT auth against public.users.
 *
 * SupabaseGate.jsx remains in the repo for optional S2 experiments but is
 * not mounted here.
 */
export default function AuthGate({ children }) {
  return children;
}
