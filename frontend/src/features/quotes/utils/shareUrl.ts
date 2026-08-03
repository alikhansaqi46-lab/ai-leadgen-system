import { API_BASE } from '../../../lib/apiClient';

/** Absolute origin of the backend API (bypasses the CRA dev proxy for direct document URLs). */
export function apiOrigin() {
  if (API_BASE) return API_BASE.replace(/\/$/, '');
  if (typeof window !== 'undefined' && window.location.port === '3000') {
    return `${window.location.protocol}//${window.location.hostname}:5001`;
  }
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/** Public (token-based) PDF URL — no auth headers needed, safe for iframes and anchors. */
export function salesDocumentPublicPdfUrl(token: string) {
  return `${apiOrigin()}/api/public/quotes/${token}/pdf`;
}

/** Extract the share token from a quote card's metadata (publicToken field or shareUrl). */
export function extractShareToken(meta: { publicToken?: string; shareUrl?: string } | null | undefined): string {
  if (!meta) return '';
  if (meta.publicToken) return meta.publicToken;
  const m = /\/share\/quote\/([A-Za-z0-9_-]+)/.exec(meta.shareUrl || '');
  return m ? m[1] : '';
}

/** Resolve a customer-facing share URL — never expose raw localhost from the API. */
export function resolvePublicShareUrl(shareUrl: string, token: string) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const path = `/share/quote/${token}`;
  if (!shareUrl || /localhost|127\.0\.0\.1/i.test(shareUrl)) {
    return origin ? `${origin}${path}` : path;
  }
  return shareUrl;
}

export function whatsAppShareUrl(text: string) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function mailtoShareUrl(subject: string, body: string) {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function smsShareUrl(body: string) {
  return `sms:?body=${encodeURIComponent(body)}`;
}
