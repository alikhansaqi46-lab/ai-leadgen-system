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

// ===================== S5.2: Outreach drafts + approval =====================

export type OutreachChannel = 'email' | 'whatsapp';
export type OutreachKind = 'initial' | 'followup';
export type DraftStatus = 'draft' | 'approved' | 'rejected';

export interface OutreachDraft {
  id: string;
  leadId: string;
  channel: OutreachChannel;
  kind: OutreachKind;
  step: number;
  waitDays: number;
  subject: string | null;
  body: string;
  status: DraftStatus;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  lead?: Lead | null;
}

export interface OutreachResponse {
  leadId: string;
  drafts: OutreachDraft[];
  count: number;
  model?: string;
}

export interface DraftsResponse {
  drafts: OutreachDraft[];
  count: number;
  mode?: string;
}

export async function generateOutreach(leadId: string): Promise<OutreachResponse> {
  const { data } = await client.post<OutreachResponse>('/api/ai/outreach', { leadId });
  return data;
}

export async function getDrafts(leadId?: string): Promise<DraftsResponse> {
  const params = leadId ? { leadId } : {};
  const { data } = await client.get<DraftsResponse>('/api/ai/drafts', { params });
  return data;
}

export async function approveDraft(id: string): Promise<OutreachDraft> {
  const { data } = await client.post<{ draft: OutreachDraft }>(`/api/ai/drafts/${id}/approve`);
  return data.draft;
}

export async function rejectDraft(id: string): Promise<OutreachDraft> {
  const { data } = await client.post<{ draft: OutreachDraft }>(`/api/ai/drafts/${id}/reject`);
  return data.draft;
}

// ===================== S5.3: Inbox (conversations + messages) =====================

export type MessageDirection = 'outbound' | 'inbound';
export type ConversationStatus = 'open' | 'closed';

export interface Message {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  channel: OutreachChannel;
  body: string;
  source: string | null;
  draftId: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  leadId: string;
  channel: OutreachChannel;
  status: ConversationStatus;
  subject: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  lead?: Lead | null;
  messageCount?: number;
  lastMessage?: { body: string; direction: MessageDirection; createdAt: string } | null;
}

export interface ConversationsResponse {
  conversations: Conversation[];
  count: number;
}

export interface MessagesResponse {
  conversation: Conversation;
  messages: Message[];
  count: number;
}

export async function getConversations(): Promise<ConversationsResponse> {
  const { data } = await client.get<ConversationsResponse>('/api/ai/conversations');
  return data;
}

export async function getMessages(conversationId: string): Promise<MessagesResponse> {
  const { data } = await client.get<MessagesResponse>(`/api/ai/conversations/${conversationId}/messages`);
  return data;
}

export async function sendMessage(
  conversationId: string,
  body: string,
  direction: MessageDirection = 'outbound'
): Promise<Message> {
  const { data } = await client.post<{ message: Message }>(
    `/api/ai/conversations/${conversationId}/messages`,
    { body, direction }
  );
  return data.message;
}

export async function startConversationFromDraft(
  draftId: string
): Promise<{ conversation: Conversation; message: Message }> {
  const { data } = await client.post<{ conversation: Conversation; message: Message }>(
    '/api/ai/conversations/from-draft',
    { draftId }
  );
  return data;
}

export default client;
