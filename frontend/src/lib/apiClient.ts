// Typed API client (S3).
// One axios instance for the whole app. The request interceptor attaches the
// S2 access token when present, so every module gets auth for free while
// AUTH_MODE=disabled keeps working with no token.
import axios, { AxiosInstance } from 'axios';
import { getAccessToken } from '../auth/authConfig';

export const API_BASE: string = process.env.REACT_APP_API_URL || '';

export interface Lead {
  id: string;
  name?: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  city?: string;
  area?: string;
  country?: string;
  niche?: string;
  category?: string;
  location?: string;
  rating?: number | string;
  reviews?: number | string;
  mapsUrl?: string;
  whatsapp?: string;
  source?: string;
  createdAt?: string;
  workspaceId?: string;
}

export interface LeadsResponse {
  leads: Lead[];
  count: number;
}

export interface FiltersResponse {
  countries: string[];
  niches: string[];
}

export interface LeadQuery {
  country?: string;
  niche?: string;
  limit?: number;
}

export interface WhatsAppStatus {
  configured?: boolean;
  [key: string]: unknown;
}

const client: AxiosInstance = axios.create({ baseURL: API_BASE });

client.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

export async function getLeads(query: LeadQuery = {}): Promise<LeadsResponse> {
  const { data } = await client.get<LeadsResponse>('/api/leads', { params: query });
  return data;
}

export async function getFilters(): Promise<FiltersResponse> {
  const { data } = await client.get<FiltersResponse>('/api/leads/filters');
  return data;
}

export function exportLeadsUrl(query: LeadQuery = {}): string {
  const params = new URLSearchParams();
  if (query.country) params.set('country', query.country);
  if (query.niche) params.set('niche', query.niche);
  const qs = params.toString();
  return `${API_BASE}/api/leads/export${qs ? `?${qs}` : ''}`;
}

export async function getWhatsAppStatus(): Promise<WhatsAppStatus> {
  const { data } = await client.get<WhatsAppStatus>('/api/whatsapp/status');
  return data;
}

// ===================== S5.1: AI Qualification =====================

export type LeadPriority = 'hot' | 'warm' | 'cold';

export interface ScoreFactor {
  key: string;
  label: string;
  points: number;
  max: number;
  reasons: string[];
}

export interface ScoreBreakdown {
  factors: ScoreFactor[];
  total: number;
  max: number;
}

// A lead joined with its (possibly null) AI qualification score.
export interface ScoredLead {
  leadId: string;
  lead: Lead;
  score: number | null;
  priority: LeadPriority | null;
  breakdown: ScoreBreakdown | null;
  model: string | null;
  scoredAt: string | null;
}

export interface ScoresResponse {
  scores: ScoredLead[];
  count: number;
  model?: string;
  mode?: string;
}

export async function qualifyLeads(leadIds?: string[]): Promise<ScoresResponse> {
  const body = leadIds && leadIds.length > 0 ? { leadIds } : {};
  const { data } = await client.post<ScoresResponse>('/api/ai/qualify', body);
  return data;
}

export async function getScores(): Promise<ScoresResponse> {
  const { data } = await client.get<ScoresResponse>('/api/ai/scores');
  return data;
}

export default client;
