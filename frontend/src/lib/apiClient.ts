// Typed API client (S3).
// One axios instance for the whole app. The request interceptor attaches the
// S2 access token when present, so every module gets auth for free while
// AUTH_MODE=disabled keeps working with no token.
import axios, { AxiosInstance } from 'axios';
import { getAccessToken, setAccessToken } from '../auth/authConfig';

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
  score?: number;
  notes?: string;
  createdAt?: string;
  workspaceId?: string;
}

export type ContactChannel = 'email' | 'phone' | 'whatsapp' | 'sms' | string;

export interface ContactMethod {
  id: string;
  leadId: string;
  workspaceId?: string;
  channel: ContactChannel;
  value: string;
  normalizedValue?: string;
  label?: string | null;
  notes?: string | null;
  isPrimary: boolean;
  isVerified: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContactTag {
  id: string;
  name: string;
  color?: string | null;
  workspaceId?: string;
}

export interface ContactNote {
  id: string;
  leadId: string;
  contactId?: string | null;
  body: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContactCustomField {
  id: string;
  leadId: string;
  key: string;
  label?: string | null;
  type: string;
  value: unknown;
}

export interface ContactProfile {
  lead: Lead;
  leadId: string;
  contactMethods: ContactMethod[];
  primaryContact?: ContactMethod | null;
  tags: ContactTag[];
  notes?: ContactNote[];
  customFields?: ContactCustomField[];
  history?: any[];
}

export interface PersonalContact {
  id: string;
  workspaceId?: string;
  name?: string;
  company?: string;
  whatsappNumber?: string;
  whatsappNormalized?: string;
  smsNumber?: string;
  smsNormalized?: string;
  email?: string;
  emailNormalized?: string;
  notes?: string;
  source?: string;
  duplicateOf?: string | null;
  isDuplicate?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PersonalContactInput {
  name?: string;
  whatsappNumber?: string;
  smsNumber?: string;
  email?: string;
  company?: string;
  notes?: string;
}

export interface ContactsResponse {
  success: boolean;
  contacts: PersonalContact[];
  count: number;
  total: number;
  limit: number;
  offset: number;
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
  configured: boolean;
  connected?: boolean;
  status?: string;
  transport?: 'meta';
  phone?: string | null;
  hasToken: boolean;
  hasPhoneNumberId: boolean;
  hasWabaId?: boolean;
  provider?: string;
  credentialSource?: string | null;
  webhook?: {
    verifyTokenConfigured: boolean;
    signatureSecretConfigured: boolean;
  };
}

export interface WhatsAppCredentialsInfo {
  configured: boolean;
  connected?: boolean;
  status?: string;
  transport?: 'meta';
  phone?: string | null;
  hasToken: boolean;
  hasPhoneNumberId: boolean;
  hasWabaId?: boolean;
  phoneNumberId: string | null;
  wabaId?: string | null;
  credentialSource?: string | null;
}

export interface WhatsAppCredentialsInput {
  token: string;
  phoneNumberId: string;
  wabaId?: string;
}

export interface WhatsAppTemplate {
  name: string;
  status: string;
  language: string;
  category?: string;
}

export interface WhatsAppTemplatesResponse {
  success: boolean;
  templates: WhatsAppTemplate[];
  demo?: boolean;
  message?: string;
}

export interface WhatsAppSendResult {
  success: boolean;
  message: string;
  messageId?: string;
  status?: string;
  testMode: boolean;
  phone: string;
}

export interface WhatsAppBulkLead {
  id?: string;
  phone?: string;
  name?: string;
  city?: string;
  niche?: string;
}

export interface WhatsAppBulkResultRow {
  leadId?: string;
  name?: string;
  phone?: string;
  status: 'sent' | 'failed' | 'skipped';
  messageId?: string;
  error?: string;
}

export interface WhatsAppBulkResponse {
  success: boolean;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  testMode: boolean;
  results: WhatsAppBulkResultRow[];
}

export const client: AxiosInstance = axios.create({ baseURL: API_BASE });

client.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    if (status === 401 && getAccessToken()) {
      setAccessToken(null);
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      }
    }
    return Promise.reject(error);
  },
);

export async function getLeads(query: LeadQuery = {}): Promise<LeadsResponse> {
  const { data } = await client.get<LeadsResponse>('/api/leads', { params: query });
  return data;
}

export async function getFilters(): Promise<FiltersResponse> {
  const { data } = await client.get<FiltersResponse>('/api/leads/filters');
  return data;
}

export async function deleteLead(id: string): Promise<{ message: string }> {
  const { data } = await client.delete<{ message: string }>(`/api/leads/${id}`);
  return data;
}

export async function deleteLeadsBulk(ids: string[]): Promise<{ message: string; count: number }> {
  const { data } = await client.post<{ message: string; count: number }>('/api/leads/bulk-delete', { ids });
  return data;
}

export function exportLeadsUrl(query: LeadQuery = {}): string {
  const params = new URLSearchParams();
  if (query.country) params.set('country', query.country);
  if (query.niche) params.set('niche', query.niche);
  const qs = params.toString();
  return `${API_BASE}/api/leads/export${qs ? `?${qs}` : ''}`;
}

/** Authenticated CSV download — uses axios so the Bearer token is sent automatically. */
export async function downloadExportCsv(query: LeadQuery = {}, filename?: string): Promise<void> {
  const params = new URLSearchParams();
  if (query.country) params.set('country', query.country);
  if (query.niche) params.set('niche', query.niche);
  const qs = params.toString();
  const url = `${API_BASE}/api/leads/export${qs ? `?${qs}` : ''}`;

  const response = await client.get(url, {
    responseType: 'blob',
  });

  const blob = new Blob([response.data], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename || `leads_export_${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

// ===================== Universal Contact Manager =====================

export async function getContacts(query: { search?: string; limit?: number; offset?: number } = {}): Promise<ContactsResponse> {
  const { data } = await client.get<ContactsResponse>('/api/contacts', { params: query });
  return data;
}

export async function getContact(id: string): Promise<{ success: boolean; contact: PersonalContact }> {
  const { data } = await client.get<{ success: boolean; contact: PersonalContact }>(`/api/contacts/${id}`);
  return data;
}

export async function createContact(input: PersonalContactInput): Promise<{ success: boolean; contact: PersonalContact }> {
  const { data } = await client.post<{ success: boolean; contact: PersonalContact }>('/api/contacts', input);
  return data;
}

export async function updateContact(id: string, input: PersonalContactInput): Promise<{ success: boolean; contact: PersonalContact }> {
  const { data } = await client.put<{ success: boolean; contact: PersonalContact }>(`/api/contacts/${id}`, input);
  return data;
}

export async function downloadContactsCsv(search?: string, filename?: string): Promise<void> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  const response = await client.get(`/api/contacts/export.csv${params.toString() ? `?${params.toString()}` : ''}`, {
    responseType: 'blob',
  });
  const blob = new Blob([response.data], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename || `contacts_export_${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

export async function bulkImportContacts(input: {
  text?: string;
  mode?: 'mixed' | 'email';
  contacts?: PersonalContactInput[];
  source?: string;
}): Promise<{ success: boolean; parsed: number; created: number; duplicates: number; skipped: number; contacts: PersonalContact[] }> {
  const { data } = await client.post('/api/contacts/bulk-import', input);
  return data;
}

export async function deleteContactsBulk(ids: string[]): Promise<{ success: boolean; deleted: number }> {
  const { data } = await client.post<{ success: boolean; deleted: number }>('/api/contacts/bulk-delete', { ids });
  return data;
}

export async function getWhatsAppStatus(): Promise<WhatsAppStatus> {
  const { data } = await client.get<WhatsAppStatus>('/api/whatsapp/status');
  return data;
}

// ===================== S4.2: WhatsApp =====================

export async function getWhatsAppCredentials(): Promise<WhatsAppCredentialsInfo> {
  const { data } = await client.get<WhatsAppCredentialsInfo>('/api/whatsapp/credentials');
  return data;
}

// Validate credentials without persisting them.
export async function validateWhatsAppCredentials(
  input: WhatsAppCredentialsInput,
): Promise<{ valid: boolean; message?: string; error?: string }> {
  const { data } = await client.post<{ valid: boolean; message?: string; error?: string }>(
    '/api/whatsapp/validate',
    input,
  );
  return data;
}

// Validate + persist credentials for the caller's workspace.
export async function saveWhatsAppCredentials(
  input: WhatsAppCredentialsInput,
): Promise<{ success: boolean }> {
  const { data } = await client.post<{ success: boolean }>('/api/whatsapp/credentials', input);
  return data;
}

export async function deleteWhatsAppCredentials(): Promise<{ success: boolean }> {
  const { data } = await client.delete<{ success: boolean }>('/api/whatsapp/credentials');
  return data;
}

export async function getWhatsAppTemplates(): Promise<WhatsAppTemplatesResponse> {
  const { data } = await client.get<WhatsAppTemplatesResponse>('/api/whatsapp/templates');
  return data;
}

export async function updateLeadNotes(leadId: string, notes: string): Promise<{ success: boolean; lead: Lead }> {
  const { data } = await client.put(`/api/leads/${leadId}`, { notes });
  return data;
}

export async function sendWhatsAppMessage(input: {
  phone: string;
  message: string;
  testMode: boolean;
}): Promise<WhatsAppSendResult> {
  const { data } = await client.post<WhatsAppSendResult>('/api/whatsapp/send', input);
  return data;
}

export async function sendWhatsAppBulk(input: {
  leads: WhatsAppBulkLead[];
  message: string;
  testMode: boolean;
}): Promise<WhatsAppBulkResponse> {
  const { data } = await client.post<WhatsAppBulkResponse>('/api/whatsapp/send-bulk', input);
  return data;
}

export interface WhatsAppWorkspaceResponse {
  success: boolean;
  connectionStatus: 'connected' | 'connecting' | 'disconnected' | 'error';
  configured: boolean;
  provider: string;
  transport?: 'meta';
  credentialSource?: string | null;
  lastConnectedAt: string | null;
  account: {
    phoneNumberId: string | null;
    wabaId: string | null;
    displayPhoneNumber: string | null;
    displayName: string | null;
    businessName?: string | null;
    displayNameStatus?: string | null;
    qualityRating: string | null;
    messagingLimit: string | null;
    verifiedStatus: string | null;
    platformType: string | null;
  } | null;
  tokenStatus: string;
  connectionError: string | null;
  webhook: {
    url: string | null;
    verifyTokenConfigured: boolean;
    signatureSecretConfigured: boolean;
    note?: string;
  };
  connect: {
    mode: string;
    note: string;
  };
  campaignJob: WhatsAppCampaignJob;
}

export interface WhatsAppCampaignJob {
  status: string;
  scheduledAt: string | null;
  updatedAt: string;
  total: number;
  sent: number;
  failed: number;
}

export interface WhatsAppLiveStats {
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replied: number;
  responseRate: number;
  successRate: number;
}

export async function getWhatsAppWorkspace(): Promise<WhatsAppWorkspaceResponse> {
  const { data } = await client.get<WhatsAppWorkspaceResponse>('/api/whatsapp/workspace');
  return data;
}

export async function getWhatsAppLiveStats(): Promise<{ success: boolean; stats: WhatsAppLiveStats; campaignJob: WhatsAppCampaignJob; generatedAt: string }> {
  const { data } = await client.get('/api/whatsapp/stats');
  return data;
}

export async function getWhatsAppLogs(limit = 80): Promise<{ success: boolean; logs: any[]; timeline: any[]; count: number }> {
  const { data } = await client.get('/api/whatsapp/logs', { params: { limit } });
  return data;
}

export async function controlWhatsAppCampaign(action: string, opts: { scheduledAt?: string; total?: number } = {}): Promise<{ success: boolean; campaignJob: WhatsAppCampaignJob }> {
  const { data } = await client.post('/api/whatsapp/campaign-control', { action, ...opts });
  return data;
}

export async function whatsAppAiCompose(input: {
  action: 'write' | 'rewrite' | 'translate';
  text?: string;
  language?: string;
  tone?: string;
  businessType?: string;
  goal?: string;
}): Promise<{ success: boolean; message: string }> {
  const { data } = await client.post('/api/whatsapp/ai-compose', input);
  return data;
}

export async function sendWhatsAppMedia(input: {
  phone: string;
  leadId?: string;
  mediaType: 'image' | 'document' | 'video';
  mediaUrl: string;
  caption?: string;
  filename?: string;
  testMode?: boolean;
}): Promise<{ success: boolean; messageId?: string }> {
  const { data } = await client.post('/api/whatsapp/send-media', input);
  return data;
}

export async function testWhatsAppConnection(): Promise<{
  success: boolean;
  valid: boolean;
  error?: string;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
  displayNameStatus?: string | null;
  qualityRating?: string | null;
}> {
  const { data } = await client.post('/api/whatsapp/test-connection');
  return data;
}

export async function getWhatsAppBusinessInfo(): Promise<{ success: boolean; data: any }> {
  const { data } = await client.get('/api/whatsapp/business-info');
  return data;
}

// ===================== S4.3: Email =====================

export interface EmailStatus {
  configured: boolean;
  sendable?: boolean;
  provider?: string;
  account?: string | null;
  senderEmail?: string | null;
  type?: string;
}

export interface EmailBulkLead {
  id?: string;
  email?: string;
  name?: string;
  city?: string;
  niche?: string;
}

export interface EmailSendResult {
  success: boolean;
  message: string;
  messageId?: string;
  testMode: boolean;
  email: string;
}

export interface EmailBulkResultRow {
  leadId?: string;
  name?: string;
  email?: string;
  status: 'sent' | 'failed';
  messageId?: string;
  error?: string;
}

export interface EmailBulkResponse {
  success: boolean;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  testMode: boolean;
  results: EmailBulkResultRow[];
}

export async function getEmailStatus(): Promise<EmailStatus> {
  const { data } = await client.get<EmailStatus>('/api/email/status');
  return data;
}

export interface SmsStatus {
  configured: boolean;
  connected?: boolean;
  account?: string | null;
  phoneNumber?: string | null;
}

export async function getSmsStatus(): Promise<SmsStatus> {
  const { data } = await client.get<SmsStatus>('/api/sms/status');
  return data;
}

export async function sendEmail(input: {
  lead: EmailBulkLead;
  subject: string;
  message: string;
  testMode: boolean;
}): Promise<EmailSendResult> {
  const { data } = await client.post<EmailSendResult>('/api/email/send', input);
  return data;
}

export async function sendEmailBulk(input: {
  leads: EmailBulkLead[];
  subject: string;
  message: string;
  testMode: boolean;
  imageUrl?: string;
}): Promise<EmailBulkResponse> {
  const { data } = await client.post<EmailBulkResponse>('/api/email/send-bulk', input);
  return data;
}

export interface SmsSendResult {
  success: boolean;
  messageId: string;
  status: string;
  testMode?: boolean;
  conversationId?: string | null;
}

export async function sendSms(input: {
  leadId: string;
  message: string;
  testMode?: boolean;
}): Promise<SmsSendResult> {
  const { data } = await client.post<SmsSendResult>('/api/sms/send', input);
  return data;
}

export async function sendSmsBulk(input: {
  leads: { id?: string; phone?: string; phoneNumber?: string; name?: string; city?: string; niche?: string; business?: string; company?: string; companyName?: string; product?: string }[];
  message: string;
  testMode?: boolean;
  delayMs?: number;
  imageUrl?: string;
}): Promise<{ success: boolean; total: number; sent: number; failed: number; skipped: number; testMode: boolean; results: any[] }> {
  const { data } = await client.post('/api/sms/send-bulk', input);
  return data;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  variables: string[];
  createdAt?: string;
  updatedAt?: string;
}

export async function getEmailTemplates(): Promise<{ success: boolean; templates: EmailTemplate[] }> {
  const { data } = await client.get<{ success: boolean; templates: EmailTemplate[] }>('/api/email/templates');
  return data;
}

export async function createEmailTemplate(input: Omit<EmailTemplate, 'id' | 'createdAt' | 'updatedAt'>): Promise<{ success: boolean; template: EmailTemplate }> {
  const { data } = await client.post<{ success: boolean; template: EmailTemplate }>('/api/email/templates', input);
  return data;
}

export async function deleteEmailTemplate(id: string): Promise<{ success: boolean }> {
  const { data } = await client.delete<{ success: boolean }>(`/api/email/templates/${id}`);
  return data;
}

// ===================== S8: Unified Integrations =====================

export interface IntegrationStatus {
  provider: string;
  name: string;
  icon: string;
  connected: boolean;
  needsReconnect?: boolean;
  reconnectReason?: string | null;
  type?: string;
  account?: string | null;
  connectedAt?: string | null;
}

export interface IntegrationsResponse {
  success: boolean;
  integrations: IntegrationStatus[];
}

export async function getIntegrations(): Promise<IntegrationsResponse> {
  const { data } = await client.get<IntegrationsResponse>('/api/integrations');
  return data;
}

export interface ProviderDefinition {
  key: string;
  name: string;
  icon: string;
  channel: string;
  authType: 'oauth2' | 'api_key' | 'basic_auth';
  fields: { key: string; label: string; type: string; required: boolean }[] | null;
  managePath: string;
}

export async function getIntegrationProviders(): Promise<{ success: boolean; providers: ProviderDefinition[] }> {
  const { data } = await client.get<{ success: boolean; providers: ProviderDefinition[] }>('/api/integrations/providers');
  return data;
}

export async function getIntegrationStatus(provider: string): Promise<{ success: boolean } & IntegrationStatus> {
  const { data } = await client.get<{ success: boolean } & IntegrationStatus>(`/api/integrations/${provider}`);
  return data;
}

export async function disconnectIntegration(provider: string): Promise<{ success: boolean; removed: boolean }> {
  const { data } = await client.post<{ success: boolean; removed: boolean }>(`/api/integrations/${provider}/disconnect`);
  return data;
}

export async function connectIntegrationApiKey(provider: string, credentials: Record<string, string>): Promise<{ success: boolean; message: string }> {
  const { data } = await client.post<{ success: boolean; message: string }>(`/api/integrations/${provider}/connect`, { credentials });
  return data;
}

export async function getOAuthUrl(provider: string): Promise<{ success: boolean; url: string }> {
  const { data } = await client.get<{ success: boolean; url: string }>(`/api/integrations/${provider}/oauth/url`);
  return data;
}

// ===================== S4.1: Scraper =====================

export interface ScrapeResponse {
  leads: Lead[];
  savedCount: number;
  totalScraped: number;
}

// Searches Google Maps (via SerpAPI) and persists the results into the caller's
// workspace, deduplicated against existing leads. Returns only the newly saved
// leads. Throws on failure; a 503 with `setupRequired` means SERPAPI_KEY is unset.
export async function scrapeLeads(keyword: string, location: string, limit = 20): Promise<ScrapeResponse> {
  const { data } = await client.get<ScrapeResponse>('/api/scrape', {
    params: { keyword, location, limit },
  });
  return data;
}

export interface ScraperConfigResponse {
  configured: boolean;
}

export async function getScraperConfig(): Promise<ScraperConfigResponse> {
  const { data } = await client.get<ScraperConfigResponse>('/api/scrape/config');
  return data;
}

export async function setScraperConfig(serpApiKey: string) {
  const { data } = await client.post('/api/scrape/config', { serpApiKey });
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
  return { scores: data?.scores ?? [], count: data?.count ?? 0, mode: data?.mode };
}

// ===================== S5.2: Outreach drafts + approval =====================

export type OutreachChannel = 'email' | 'whatsapp' | 'sms';
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
export type ConversationStatus =
  | 'open'
  | 'closed'
  | 'ai_active'
  | 'human_active'
  | 'needs_human'
  | 'waiting'
  | 'quote_sent'
  | 'invoice_sent'
  | 'archived'
  | string;

export interface Message {
  id: string;
  conversationId: string;
  conversationChannel?: OutreachChannel;
  direction: MessageDirection;
  channel: OutreachChannel;
  body: string;
  source: string | null;
  draftId: string | null;
  status?: 'sent' | 'delivered' | 'read' | null;
  messageType?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  leadId: string;
  channel: OutreachChannel;
  channels?: OutreachChannel[];
  status: ConversationStatus;
  subject: string | null;
  lastMessageAt: string | null;
  unreadCount?: number;
  archived?: boolean;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown> | null;
  lead?: Lead | null;
  contact?: Lead | null;
  entityType?: 'lead' | 'contact';
  messageCount?: number;
  lastMessage?: { body: string; direction: MessageDirection; createdAt: string; metadata?: any } | null;
  pipelineStatus?: string;
  notificationStatus?: {
    type: 'new_reply' | 'ai_replied' | 'waiting' | 'sending' | 'human_required';
    label: string;
    icon: string;
  } | null;
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
  return { conversations: data?.conversations ?? [], count: data?.count ?? 0 };
}

export async function getMessages(conversationId: string, unified = true): Promise<MessagesResponse> {
  const { data } = await client.get<MessagesResponse>(`/api/ai/conversations/${conversationId}/messages`, {
    params: unified ? { unified: '1' } : undefined,
  });
  return {
    conversation: data?.conversation,
    messages: data?.messages ?? [],
    count: data?.count ?? (data?.messages?.length ?? 0),
  };
}

export async function sendConversationReply(
  conversationId: string,
  payload: { body: string; subject?: string; imageUrl?: string }
): Promise<{ success: boolean; message: Message; sent: boolean; conversationId: string; messageId?: string }> {
  const { data } = await client.post(`/api/ai/conversations/${conversationId}/send-reply`, payload);
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

export async function startInboxSession(): Promise<{ success: boolean; active?: boolean; pollIntervalMs?: number; reason?: string }> {
  const { data } = await client.post('/api/email/inbox/session/start');
  return data;
}

export async function stopInboxSession(): Promise<{ success: boolean; active?: boolean; refCount?: number }> {
  const { data } = await client.post('/api/email/inbox/session/stop');
  return data;
}

export async function syncEmail(): Promise<{ success: boolean; processed: number; skipped: number; suspended?: boolean; reason?: string }> {
  const { data } = await client.post('/api/email/sync');
  return data;
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

export async function markConversationRead(conversationId: string): Promise<{ success: boolean; conversationId: string }> {
  const { data } = await client.post<{ success: boolean; conversationId: string }>(
    `/api/ai/conversations/${conversationId}/read`
  );
  return data;
}

export async function markConversationUnread(conversationId: string): Promise<{ success: boolean; conversationId: string }> {
  const { data } = await client.post<{ success: boolean; conversationId: string }>(
    `/api/ai/conversations/${conversationId}/unread`
  );
  return data;
}

export async function archiveConversation(conversationId: string): Promise<{ success: boolean; conversationId: string; archived: boolean }> {
  const { data } = await client.post<{ success: boolean; conversationId: string; archived: boolean }>(
    `/api/ai/conversations/${conversationId}/archive`
  );
  return data;
}

export async function unarchiveConversation(conversationId: string): Promise<{ success: boolean; conversationId: string; archived: boolean }> {
  const { data } = await client.post<{ success: boolean; conversationId: string; archived: boolean }>(
    `/api/ai/conversations/${conversationId}/unarchive`
  );
  return data;
}

export async function pinConversation(conversationId: string): Promise<{ success: boolean; conversationId: string; pinned: boolean }> {
  const { data } = await client.post<{ success: boolean; conversationId: string; pinned: boolean }>(
    `/api/ai/conversations/${conversationId}/pin`
  );
  return data;
}

export async function unpinConversation(conversationId: string): Promise<{ success: boolean; conversationId: string; pinned: boolean }> {
  const { data } = await client.post<{ success: boolean; conversationId: string; pinned: boolean }>(
    `/api/ai/conversations/${conversationId}/unpin`
  );
  return data;
}

export async function deleteConversation(conversationId: string): Promise<{ success: boolean; conversationId: string }> {
  const { data } = await client.delete<{ success: boolean; conversationId: string }>(
    `/api/ai/conversations/${conversationId}`
  );
  return data;
}

export async function bulkArchiveConversations(conversationIds: string[]): Promise<{ success: boolean; updated: number }> {
  const { data } = await client.post<{ success: boolean; updated: number }>(
    '/api/ai/conversations/bulk-archive',
    { conversationIds }
  );
  return data;
}

export async function bulkUnarchiveConversations(conversationIds: string[]): Promise<{ success: boolean; updated: number }> {
  const { data } = await client.post<{ success: boolean; updated: number }>(
    '/api/ai/conversations/bulk-unarchive',
    { conversationIds }
  );
  return data;
}

export async function bulkDeleteConversations(conversationIds: string[]): Promise<{ success: boolean; deleted: number }> {
  const { data } = await client.post<{ success: boolean; deleted: number }>(
    '/api/ai/conversations/bulk-delete',
    { conversationIds }
  );
  return data;
}

export async function deleteConversationMessages(
  conversationId: string,
  messageIds: string[]
): Promise<{ success: boolean; conversationId: string; deleted: number }> {
  const { data } = await client.post<{ success: boolean; conversationId: string; deleted: number }>(
    `/api/ai/conversations/${conversationId}/messages/delete`,
    { messageIds }
  );
  return data;
}

export async function getConversationTimeline(conversationId: string): Promise<{ events: any[]; count: number }> {
  const { data } = await client.get<{ events: any[]; count: number }>(`/api/ai/conversations/${conversationId}/timeline`);
  return data;
}

export async function generateReply(conversationId: string): Promise<{ suggestion: { body: string; intent: string; model: string }; messageCount: number; freeAiMessagesRemaining?: number | null }> {
  const { data } = await client.post<{ suggestion: { body: string; intent: string; model: string }; messageCount: number; freeAiMessagesRemaining?: number | null }>(
    `/api/ai/conversations/${conversationId}/reply`
  );
  return data;
}

export async function processDueFollowUps(): Promise<{ success: boolean; processed: number; sent: number; results: any[] }> {
  const { data } = await client.post<{ success: boolean; processed: number; sent: number; results: any[] }>(
    '/api/campaign/follow-up/process-due'
  );
  return data;
}

// ===================== S6: WhatsApp Campaign CRM =====================

export interface CampaignRecord {
  id: string;
  leadId: string;
  status: 'new' | 'sent' | 'replied' | 'interested' | 'meeting' | 'deal' | 'lost';
  sentAt: string | null;
  repliedAt: string | null;
  interestedAt: string | null;
  meetingAt: string | null;
  dealAt: string | null;
  lostAt: string | null;
  followUp1At: string | null;
  followUp2At: string | null;
  followUp1Sent: boolean;
  followUp2Sent: boolean;
  messageCount: number;
  replyCount: number;
  lead: Lead | null;
}

export interface CampaignStats {
  total: number;
  sent: number;
  replied: number;
  interested: number;
  meeting: number;
  deal: number;
  lost: number;
  messagesSent: number;
  repliesReceived: number;
  followUpsPending: number;
  byStatus?: {
    new: number;
    sent: number;
    replied: number;
    interested: number;
    meeting: number;
    deal: number;
    lost: number;
  };
  channels?: ChannelStats;
}

export interface CampaignsResponse {
  success: boolean;
  campaigns: CampaignRecord[];
  count: number;
}

export interface CampaignStatsResponse {
  success: boolean;
  stats: CampaignStats;
}

export interface ChannelStats {
  email: { sent: number; replies: number; delivered?: number; read?: number; failed?: number };
  whatsapp: { sent: number; replies: number; delivered?: number; read?: number; failed?: number };
  sms: { sent: number; replies: number; delivered?: number; read?: number; failed?: number };
}

export interface ChannelStatsResponse {
  success: boolean;
  counts: ChannelStats;
}

export async function getCampaignStats(): Promise<CampaignStatsResponse> {
  const { data } = await client.get<CampaignStatsResponse>('/api/campaign/stats');
  return { success: data?.success ?? true, stats: data?.stats ?? {
    total: 0, sent: 0, replied: 0, interested: 0, meeting: 0, deal: 0, lost: 0,
    messagesSent: 0, repliesReceived: 0, followUpsPending: 0,
    byStatus: { new: 0, sent: 0, replied: 0, interested: 0, meeting: 0, deal: 0, lost: 0 },
    channels: { email: { sent: 0, replies: 0 }, whatsapp: { sent: 0, replies: 0 }, sms: { sent: 0, replies: 0 } },
  } };
}

export async function getChannelStats(): Promise<ChannelStatsResponse> {
  const { data } = await client.get<ChannelStatsResponse>('/api/campaign/channel-stats');
  const defaults = { email: { sent: 0, replies: 0 }, whatsapp: { sent: 0, replies: 0 }, sms: { sent: 0, replies: 0 } };
  return { success: data?.success ?? true, counts: { ...defaults, ...(data?.counts || {}) } };
}

export async function getCampaigns(): Promise<CampaignsResponse> {
  const { data } = await client.get<CampaignsResponse>('/api/campaign/leads');
  return data;
}

export async function updateCampaignStatus(
  leadId: string,
  status: string,
  revenue?: number | null
): Promise<{ success: boolean; campaign: CampaignRecord; handover?: Record<string, unknown> }> {
  const { data } = await client.post('/api/campaign/status', { leadId, status, revenue });
  return data;
}

export async function getHandoverPackage(leadId: string): Promise<{ success: boolean; handover: Record<string, unknown> }> {
  const { data } = await client.get(`/api/campaign/handover/${encodeURIComponent(leadId)}`);
  return data;
}

export interface PerformanceReport {
  workspaceId: string;
  generatedAt: string;
  range: { from: string; to: string; days: number };
  summary: {
    totalLeads: number;
    leadsCreatedInRange: number;
    hot: number;
    warm: number;
    cold: number;
    dealsWon: number;
    dealsLost: number;
    meetings: number;
    revenue: number;
    conversionRate: number;
    replyRate: number;
  };
  pipeline: Record<string, number>;
  channels: Record<string, Record<string, number>>;
  activityInRange: Record<string, number>;
  automations: { enabled: number; runsSucceeded: number; runsFailed: number };
}

export async function getPerformanceReport(days = 30): Promise<{ success: boolean; report: PerformanceReport }> {
  const { data } = await client.get('/api/reports/performance', { params: { days } });
  return data;
}

export async function recordSent(leadId: string, testMode = false): Promise<{ success: boolean; campaign: CampaignRecord }> {
  const { data } = await client.post('/api/campaign/sent', { leadId, testMode });
  return data;
}

export async function recordReply(leadId: string, body?: string, testMode = false): Promise<{ success: boolean; campaign: CampaignRecord }> {
  const { data } = await client.post('/api/campaign/reply', { leadId, body, testMode });
  return data;
}

export async function scheduleFollowUps(leadId: string, days1 = 2, days2 = 5): Promise<{ success: boolean; campaign: CampaignRecord }> {
  const { data } = await client.post('/api/campaign/follow-ups', { leadId, days1, days2 });
  return data;
}

export async function cancelFollowUps(leadId: string): Promise<{ success: boolean; campaign: CampaignRecord }> {
  const { data } = await client.post('/api/campaign/follow-up/cancel', { leadId });
  return data;
}

export async function getOverdueFollowUps(): Promise<{ success: boolean; overdue: CampaignRecord[]; count: number }> {
  const { data } = await client.get('/api/campaign/overdue');
  return data;
}

export async function getCampaignConversations(): Promise<{ success: boolean; conversations: any[]; count: number }> {
  const { data } = await client.get('/api/campaign/conversations');
  return data;
}

export async function getCampaignMessages(conversationId: string): Promise<{ success: boolean; messages: any[]; count: number }> {
  const { data } = await client.get(`/api/campaign/conversations/${conversationId}/messages`);
  return data;
}

// ===================== Test Mode =====================

export interface TestModeInfo {
  active: boolean;
  testNumber: string | null;
  messagesUsed: number;
  messagesLimit: number;
  remaining: number;
}

export async function getTestMode(): Promise<{ success: boolean; testMode: TestModeInfo }> {
  const { data } = await client.get('/api/campaign/test-mode');
  return data;
}

export async function setTestNumber(testNumber: string): Promise<{ success: boolean; testMode: any }> {
  const { data } = await client.post('/api/campaign/test-mode/number', { testNumber });
  return data;
}

export async function sendTestMessage(message: string): Promise<{ success: boolean; remaining: number; sentAt: string; simulated?: boolean; status?: string; messageId?: string }> {
  const { data } = await client.post('/api/campaign/test-mode/send', { message });
  return data;
}

export async function generateAIMessage(params: {
  businessType: string;
  goal: string;
  language: string;
  tone: string;
  length: string;
  writingStyle: string;
}): Promise<{ message: string; model: string; freeAiMessagesRemaining?: number }> {
  const { data } = await client.post('/api/ai/generate-message', params);
  return data;
}

export async function resetTestCounter(): Promise<{ success: boolean; testMode: any }> {
  const { data } = await client.post('/api/campaign/test-mode/reset');
  return data;
}

export async function deactivateTestMode(): Promise<{ success: boolean; testMode: any }> {
  const { data } = await client.post('/api/campaign/test-mode/deactivate');
  return data;
}

// ===================== Preview & Trust Mode =====================

export interface PreviewSettings {
  whatsappPreview: boolean;
  emailPreview: boolean;
  smsPreview: boolean;
  previewPhone: string;
  previewEmail: string;
}

export async function getPreviewSettings(): Promise<{ success: boolean; settings: PreviewSettings }> {
  const { data } = await client.get('/api/settings/preview');
  return data;
}

export async function updatePreviewSettings(settings: Partial<PreviewSettings>): Promise<{ success: boolean; settings: PreviewSettings }> {
  const { data } = await client.post('/api/settings/preview', settings);
  return data;
}

export interface EmailSettings {
  includeUnsubscribeFooter: boolean;
}

export async function getEmailSettings(): Promise<{ success: boolean; settings: EmailSettings }> {
  const { data } = await client.get('/api/settings/email');
  return { success: data?.success ?? true, settings: data?.settings ?? { includeUnsubscribeFooter: false } };
}

export async function updateEmailSettings(settings: Partial<EmailSettings>): Promise<{ success: boolean; settings: EmailSettings }> {
  const { data } = await client.post('/api/settings/email', settings);
  return data;
}

export interface AiKnowledgeStatus {
  status: 'complete' | 'partial' | 'missing';
  level: 'complete' | 'partial' | 'missing';
  label: string;
  icon: string;
  message: string;
  criticalFilled?: number;
  supportingFilled?: number;
}

export interface AiAgentSettings {
  businessName: string;
  companyDescription: string;
  products: string;
  services: string;
  pricing: string;
  features: string;
  offers: string;
  promotions: string;
  faqs: string;
  objectionHandling: string;
  salesTone: string;
  writingStyle: string;
  languages: string[];
  callToAction: string;
  companyPolicies: string;
  appointmentInstructions: string;
  supportInfo: string;
  emailAutoReplyEnabled: boolean;
  whatsappAutoReplyEnabled: boolean;
  humanTakeoverKeywords: string[];
}

export async function getAiAgentSettings(): Promise<{ success: boolean; settings: AiAgentSettings; knowledgeStatus?: AiKnowledgeStatus }> {
  const { data } = await client.get('/api/settings/ai-agent');
  return {
    success: data?.success ?? true,
    settings: data?.settings ?? DEFAULT_AI_AGENT_SETTINGS,
    knowledgeStatus: data?.knowledgeStatus,
  };
}

export const DEFAULT_AI_AGENT_SETTINGS: AiAgentSettings = {
  businessName: '',
  companyDescription: '',
  products: '',
  services: '',
  pricing: '',
  features: '',
  offers: '',
  promotions: '',
  faqs: '',
  objectionHandling: '',
  salesTone: 'professional and friendly',
  writingStyle: 'concise, clear, and helpful',
  languages: ['English'],
  callToAction: '',
  companyPolicies: '',
  appointmentInstructions: '',
  supportInfo: '',
  emailAutoReplyEnabled: true,
  whatsappAutoReplyEnabled: true,
  humanTakeoverKeywords: ['human', 'agent', 'call me', 'speak to someone', 'representative'],
};

export async function updateAiAgentSettings(settings: Partial<AiAgentSettings>): Promise<{ success: boolean; settings: AiAgentSettings; knowledgeStatus?: AiKnowledgeStatus }> {
  const { data } = await client.post('/api/settings/ai-agent', settings);
  return data;
}

export interface CampaignSendResult {
  success: boolean;
  total: number;
  sent: number;
  failed: number;
  previewSent: boolean;
  previewResult: { sent: boolean; messageId?: string; conversationId?: string; reason?: string } | null;
  previewError: string | null;
  results: Array<{ leadId: string; name: string; status: string; messageId?: string; recipientEmail?: string; deliveryVerified?: boolean | null; error?: string }>;
}

export async function sendCampaignWithPreview(payload: {
  channel: 'whatsapp' | 'email' | 'sms';
  leads: Array<{ id: string; contactId?: string; source?: string; phone?: string; email?: string; name: string; city?: string; niche?: string }>;
  message: string;
  subject?: string;
  previewMode: boolean;
  imageUrl?: string;
}): Promise<CampaignSendResult> {
  const { data } = await client.post('/api/campaign/send-with-preview', payload, { timeout: 180000 });
  return data;
}

export async function simulateReply(conversationId: string, body: string): Promise<{
  success: boolean;
  inbound: { id: string; body: string };
  reply: { id: string; body: string; intent: string; model: string };
}> {
  const { data } = await client.post(`/api/ai/conversations/${conversationId}/simulate-reply`, { body });
  return data;
}

export async function autoReply(conversationId: string): Promise<{
  success: boolean;
  message: { id: string; body: string; intent: string; model: string };
  sent: boolean;
  conversationId: string;
  freeAiMessagesRemaining?: number | null;
}> {
  const { data } = await client.post(`/api/ai/conversations/${conversationId}/auto-reply`);
  return data;
}

export interface ConversationAiSettings {
  autoReplyEnabled: boolean | null;
  humanTakeover: boolean;
  needsHuman?: boolean;
}

export async function getConversationSettings(conversationId: string): Promise<{
  success: boolean;
  conversationId: string;
  channel: string;
  status: string;
  settings: ConversationAiSettings;
}> {
  const { data } = await client.get(`/api/ai/conversations/${conversationId}/settings`);
  return data;
}

export async function updateConversationSettings(
  conversationId: string,
  settings: Partial<{ autoReplyEnabled: boolean; humanTakeover: boolean; status: string }>
): Promise<{
  success: boolean;
  conversationId: string;
  status: string;
  settings: ConversationAiSettings;
}> {
  const { data } = await client.post(`/api/ai/conversations/${conversationId}/settings`, settings);
  return data;
}

export async function takeOverConversation(conversationId: string): Promise<{
  success: boolean;
  conversationId: string;
  status: string;
  settings: ConversationAiSettings;
}> {
  const { data } = await client.post(`/api/ai/conversations/${conversationId}/takeover`);
  return data;
}

export async function resumeAiConversation(conversationId: string): Promise<{
  success: boolean;
  conversationId: string;
  status: string;
  settings: ConversationAiSettings;
}> {
  const { data } = await client.post(`/api/ai/conversations/${conversationId}/resume-ai`);
  return data;
}

export interface UserProfile {
  id: string;
  fullName: string;
  businessName: string;
  email: string;
  whatsappNumber?: string;
  emailVerified: boolean;
  createdAt: string;
}

export async function getUserProfile(): Promise<UserProfile> {
  const { data } = await client.get<UserProfile>('/api/auth/me');
  return data;
}

// ===================== PayPal / Subscription =====================

export interface SubscriptionStatus {
  success: boolean;
  status: string;
  plan: string | null;
  expiresAt: string | null;
}

export async function getSubscriptionStatus(): Promise<SubscriptionStatus> {
  const { data } = await client.get<SubscriptionStatus>('/api/paypal/subscription-status');
  return data;
}

export async function getPayPalPlans(): Promise<{ success: boolean; plans: any[] }> {
  const { data } = await client.get<{ success: boolean; plans: any[] }>('/api/paypal/plans');
  return data;
}

export async function createPayPalSubscription(planKey: string): Promise<{ success: boolean; subscriptionId: string; approvalUrl: string }> {
  const { data } = await client.post<{ success: boolean; subscriptionId: string; approvalUrl: string }>('/api/paypal/create-subscription', { planKey });
  return data;
}

export async function cancelPayPalSubscription(): Promise<{ success: boolean; message: string }> {
  const { data } = await client.post<{ success: boolean; message: string }>('/api/paypal/cancel-subscription');
  return data;
}

// ===================== OpenAI Key Management =====================

export interface OpenAiStatus {
  success: boolean;
  enabled: boolean;
  source: string;
  freeMessagesRemaining: number;
  freeMessagesTotal: number;
  freeMessagesUsed?: number;
  unlimited?: boolean;
  masterConfigured: boolean;
}

export async function getOpenAiStatus(): Promise<OpenAiStatus> {
  const { data } = await client.get<OpenAiStatus>('/api/openai/status');
  return data;
}

export async function saveOpenAiKey(apiKey: string): Promise<{ success: boolean; message: string }> {
  const { data } = await client.post<{ success: boolean; message: string }>('/api/openai/key', { apiKey });
  return data;
}

export async function deleteOpenAiKey(): Promise<{ success: boolean; message: string }> {
  const { data } = await client.delete<{ success: boolean; message: string }>('/api/openai/key');
  return data;
}

export async function testOpenAiKey(apiKey?: string): Promise<{ success: boolean; valid: boolean; error?: string }> {
  const { data } = await client.post<{ success: boolean; valid: boolean; error?: string }>('/api/openai/test', apiKey ? { apiKey } : {});
  return data;
}

// ===================== Sender Email Management =====================

export async function getSenderEmail(): Promise<{ senderEmail: string | null }> {
  const { data } = await client.get('/api/auth/me/sender-email');
  return data;
}

export async function setSenderEmail(email: string | null): Promise<{ message: string; senderEmail: string | null }> {
  const { data } = await client.put('/api/auth/me/sender-email', { senderEmail: email });
  return data;
}

export async function uploadImage(imageBase64: string, name?: string): Promise<{ success: boolean; url: string; filename: string; mimeType: string }> {
  const { data } = await client.post('/api/upload-image', { image: imageBase64, name });
  return data;
}

export async function autonomousDecision(input: { message: string; lead?: any; conversation?: any; execute?: boolean }): Promise<any> {
  const { data } = await client.post('/api/ai/autonomous', input);
  return data;
}

/* ---------- Automation Engine ---------- */

export interface AutomationRecord {
  id: string;
  workspaceId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  triggerType: string;
  triggerConfig?: Record<string, unknown>;
  conditions?: Array<Record<string, unknown>>;
  actions: Array<{ type: string; config?: Record<string, unknown> }>;
  color?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AutomationStats {
  totalAutomations: number;
  enabledAutomations: number;
  runsTotal: number;
  runsRunning: number;
  runsSucceeded: number;
  runsFailed: number;
}

export async function listAutomations(): Promise<{ success: boolean; automations: AutomationRecord[] }> {
  const { data } = await client.get('/api/automations');
  return { success: data?.success ?? true, automations: data?.automations || [] };
}

export async function getAutomationStats(): Promise<{ success: boolean; stats: AutomationStats }> {
  const { data } = await client.get('/api/automations/stats');
  return {
    success: data?.success ?? true,
    stats: data?.stats || {
      totalAutomations: 0,
      enabledAutomations: 0,
      runsTotal: 0,
      runsRunning: 0,
      runsSucceeded: 0,
      runsFailed: 0,
    },
  };
}

export async function listAutomationRuns(limit = 50): Promise<{ success: boolean; runs: any[] }> {
  const { data } = await client.get('/api/automations/runs', { params: { limit } });
  return { success: data?.success ?? true, runs: data?.runs || [] };
}

export async function listAutomationLogs(params?: { runId?: string; limit?: number }): Promise<{ success: boolean; logs: any[] }> {
  const { data } = await client.get('/api/automations/logs', { params });
  return { success: data?.success ?? true, logs: data?.logs || [] };
}

export async function createAutomation(body: Partial<AutomationRecord>): Promise<{ success: boolean; automation: AutomationRecord }> {
  const { data } = await client.post('/api/automations', body);
  return data;
}

export async function updateAutomation(id: string, body: Partial<AutomationRecord>): Promise<{ success: boolean; automation: AutomationRecord }> {
  const { data } = await client.put(`/api/automations/${id}`, body);
  return data;
}

export async function deleteAutomation(id: string): Promise<{ success: boolean }> {
  const { data } = await client.delete(`/api/automations/${id}`);
  return data;
}

export async function enableAutomation(id: string): Promise<{ success: boolean; automation: AutomationRecord }> {
  const { data } = await client.post(`/api/automations/${id}/enable`);
  return data;
}

export async function disableAutomation(id: string): Promise<{ success: boolean; automation: AutomationRecord }> {
  const { data } = await client.post(`/api/automations/${id}/disable`);
  return data;
}

export async function runAutomationNow(id: string, context?: Record<string, unknown>): Promise<{ success: boolean; run: any }> {
  const { data } = await client.post(`/api/automations/${id}/run`, context || {});
  return data;
}

/* ---------- Enterprise Dashboard ---------- */

export interface DashboardCard {
  key: string;
  label: string;
  value: number;
  href: string;
  group?: string;
  accent?: string;
}

export interface DashboardMetricsResponse {
  success: boolean;
  workspaceId: string;
  generatedAt: string;
  cards: DashboardCard[];
  metrics: Record<string, number>;
  pipeline: Record<string, number>;
  channels: ChannelStats;
  automations: {
    totalAutomations: number;
    enabledAutomations: number;
    runsTotal: number;
    runsRunning: number;
    runsSucceeded: number;
    runsFailed: number;
  };
  history?: Array<{ date: string; messagesSent: number; replies: number; leadsCreated: number; statusChanges: number }>;
}

export async function getDashboardMetrics(): Promise<DashboardMetricsResponse> {
  const { data } = await client.get<DashboardMetricsResponse>('/api/dashboard/metrics');
  return data;
}

export async function getDashboardDrilldown(metric: string, limit = 100): Promise<{ success: boolean; metric: string; count: number; items: Array<{ id: string; name?: string; href?: string }> }> {
  const { data } = await client.get('/api/dashboard/drilldown', { params: { metric, limit } });
  return data;
}

export interface StartCampaignInput {
  name?: string;
  businessType: string;
  location: string;
  country?: string;
  language?: string;
  goal?: string;
  channels?: string[];
  autoSend?: boolean;
  limit?: number;
}

export interface StartCampaignReport {
  campaign: Record<string, unknown>;
  steps: Array<{ step: string; status: string; count?: number; hot?: number; qualified?: number; attempted?: number; found?: number; error?: string; note?: string; leads?: number }>;
  leadsScraped: number;
  leadsSaved: number;
  emailsDiscovered?: number;
  qualified: number;
  hot: number;
  followUpsScheduled: number;
  draftsGenerated?: number;
  automationsFired: number;
  errors: string[];
}

export async function startCampaign(input: StartCampaignInput): Promise<{ success: boolean; message?: string; report: StartCampaignReport; error?: string }> {
  const { data } = await client.post('/api/campaign/start', input, { timeout: 180000 });
  return data;
}

/* ---------- AI Quotes & Invoicing ---------- */

export type SalesDocType = 'quote' | 'invoice';

export interface SalesLineItem {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  amount?: number;
  unit?: string;
}

export interface SalesDocument {
  id: string;
  docType: SalesDocType;
  number: string;
  status: string;
  leadId?: string | null;
  customer: Record<string, any>;
  company: Record<string, any>;
  lineItems: SalesLineItem[];
  currency: string;
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  taxPct: number;
  taxAmount: number;
  shipping: number;
  total: number;
  amountPaid?: number;
  paidAt?: string | null;
  notes?: string;
  terms?: string;
  paymentTerms?: string;
  template: string;
  validUntil?: string | null;
  dueDate?: string | null;
  quoteId?: string | null;
  pdfPath?: string | null;
  aiPrompt?: string | null;
  meta?: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
  sentAt?: string | null;
}

export async function getQuoteStats() {
  const { data } = await client.get('/api/quotes/stats');
  return data;
}

export async function getQuoteTemplates() {
  const { data } = await client.get('/api/quotes/templates');
  return data;
}

export async function getQuoteBillingProfile() {
  const { data } = await client.get('/api/quotes/billing-profile');
  return data;
}

export async function updateQuoteBillingProfile(body: Record<string, unknown>) {
  const { data } = await client.put('/api/quotes/billing-profile', body);
  return data;
}

export async function listQuoteLeads() {
  const { data } = await client.get('/api/quotes/leads-options');
  return data;
}

export async function listSalesDocuments(params?: {
  docType?: string; status?: string; q?: string; leadId?: string; limit?: number; offset?: number;
}) {
  const { data } = await client.get('/api/quotes', { params });
  return data as { success: boolean; items: SalesDocument[]; total: number };
}

export async function getSalesDocument(id: string) {
  const { data } = await client.get(`/api/quotes/${id}`);
  return data as { success: boolean; document: SalesDocument; events: any[] };
}

export async function createSalesDocument(body: Partial<SalesDocument> & { docType?: SalesDocType }) {
  const { data } = await client.post('/api/quotes', body);
  return data as { success: boolean; document: SalesDocument };
}

export async function aiGenerateSalesDocument(body: {
  prompt: string;
  docType?: SalesDocType;
  leadId?: string;
  template?: string;
  conversationId?: string;
}) {
  const { data } = await client.post('/api/quotes/ai-generate', body, { timeout: 90000 });
  return data as { success: boolean; document: SalesDocument };
}

export async function aiFromLeadSalesDocument(body: {
  leadId: string;
  docType?: SalesDocType;
  prompt?: string;
  template?: string;
  autoMode?: boolean;
}) {
  const { data } = await client.post('/api/quotes/ai-from-lead', body, { timeout: 120000 });
  return data as {
    success: boolean;
    document: SalesDocument;
    primaryChannel?: string;
    messageCount?: number;
    fromConversation?: boolean;
    autoSent?: boolean;
    sendResult?: any;
  };
}

export async function aiFromConversationSalesDocument(body: {
  conversationId: string;
  docType?: SalesDocType;
  prompt?: string;
  template?: string;
  autoMode?: boolean;
}) {
  const { data } = await client.post('/api/quotes/ai-from-conversation', body, { timeout: 120000 });
  return data as {
    success: boolean;
    document: SalesDocument;
    primaryChannel?: string;
    messageCount?: number;
    fromConversation?: boolean;
    autoSent?: boolean;
    sendResult?: any;
  };
}

export async function updateSalesDocument(id: string, body: Partial<SalesDocument>) {
  const { data } = await client.patch(`/api/quotes/${id}`, body);
  return data as { success: boolean; document: SalesDocument };
}

export async function regenerateSalesDocument(
  id: string,
  instruction: string,
  opts?: { replaceCustomer?: boolean },
) {
  const { data } = await client.post(
    `/api/quotes/${id}/regenerate`,
    { instruction, replaceCustomer: Boolean(opts?.replaceCustomer) },
    { timeout: 90000 },
  );
  return data as { success: boolean; document: SalesDocument };
}

export async function setSalesDocumentStatus(id: string, status: string) {
  const { data } = await client.post(`/api/quotes/${id}/status`, { status });
  return data as { success: boolean; document: SalesDocument };
}

export async function convertQuoteToInvoice(id: string, body?: { conversationId?: string }) {
  const { data } = await client.post(`/api/quotes/${id}/convert`, body || {});
  return data as { success: boolean; quote: SalesDocument; invoice: SalesDocument };
}

export async function duplicateSalesDocument(id: string) {
  const { data } = await client.post(`/api/quotes/${id}/duplicate`);
  return data as { success: boolean; document: SalesDocument };
}

export async function shareSalesDocument(id: string) {
  const { data } = await client.post(`/api/quotes/${id}/share`);
  return data as { success: boolean; shareUrl: string; apiUrl: string; token: string; document: SalesDocument };
}

export async function recordSalesPayment(id: string, body?: { amount?: number; method?: string; note?: string }) {
  const { data } = await client.post(`/api/quotes/${id}/payment`, body || {});
  return data as { success: boolean; document: SalesDocument; payment: any };
}

export async function saveQuoteCustomer(id: string, customer?: Record<string, unknown>) {
  const { data } = await client.post(`/api/quotes/${id}/customer`, { customer, autoSave: true });
  return data as { success: boolean; lead: any; contact: any; document: SalesDocument };
}

export async function createQuoteCustomer(body: { customer: Record<string, unknown>; documentId?: string }) {
  const { data } = await client.post('/api/quotes/customers', body);
  return data;
}

export async function deleteSalesDocument(id: string) {
  const { data } = await client.delete(`/api/quotes/${id}`);
  return data;
}

export async function sendSalesDocument(id: string, body: {
  channel: 'email' | 'whatsapp' | 'sms';
  subject?: string;
  body?: string;
  conversationId?: string;
}) {
  const { data } = await client.post(`/api/quotes/${id}/send`, body, { timeout: 60000 });
  return data;
}

export function salesDocumentPdfUrl(id: string) {
  return `/api/quotes/${id}/pdf`;
}

export async function getPublicSalesDocument(token: string) {
  const { data } = await client.get(`/api/public/quotes/${token}`);
  return data as { success: boolean; document: SalesDocument };
}

/* ==================== Channel Brain Configuration (per-channel independent AI brains) ==================== */

export type ChannelType = 'whatsapp' | 'email' | 'sms';

export interface ChannelBrainConfig {
  aiEnabled: boolean;

  // Business Knowledge
  businessName: string;
  companyDescription: string;
  products: string;
  services: string;
  pricing: string;
  features: string;
  offers: string;
  promotions: string;

  // FAQs
  faqs: string;

  // System Prompt
  systemPrompt: string;

  // Tone
  tone: string;
  writingStyle: string;

  // Reply Rules
  replyRules: string;
  humanTakeoverKeywords: string[];

  // Follow-up Strategy
  followUpEnabled: boolean;
  followUpDelay: number;
  maxFollowUps: number;
  followUpMessage: string;

  // Campaign Instructions
  campaignInstructions: string;

  // Conversation Memory Settings
  maxMemoryMessages: number;
  memoryExpiryDays: number;
}

export interface ChannelBrainResponse {
  success: boolean;
  channel: ChannelType;
  config: ChannelBrainConfig;
}

/**
 * Get the brain configuration for a specific channel.
 */
export async function getChannelBrainConfig(channel: ChannelType): Promise<ChannelBrainResponse> {
  const { data } = await client.get<ChannelBrainResponse>(`/api/channel-brains/${channel}`);
  return data;
}

/**
 * Update the brain configuration for a specific channel.
 */
export async function updateChannelBrainConfig(
  channel: ChannelType,
  config: Partial<ChannelBrainConfig>
): Promise<ChannelBrainResponse> {
  const { data } = await client.post<ChannelBrainResponse>(`/api/channel-brains/${channel}`, config);
  return data;
}

export default client;
