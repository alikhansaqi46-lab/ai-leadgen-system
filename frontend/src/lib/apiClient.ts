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

export default client;
