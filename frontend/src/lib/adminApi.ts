import { client } from './apiClient';

export async function getAdminOverview() {
  const { data } = await client.get('/api/admin/overview');
  return data;
}

export async function getAdminExecutiveDashboard() {
  const { data } = await client.get('/api/admin/metrics/executive');
  return data;
}

export async function getAdminUsers(params?: { q?: string; status?: string }) {
  const { data } = await client.get('/api/admin/users', { params });
  return data;
}

export async function getAdminUser(id: string) {
  const { data } = await client.get(`/api/admin/users/${id}`);
  return data;
}

export async function suspendAdminUser(id: string, reason?: string) {
  const { data } = await client.post(`/api/admin/users/${id}/suspend`, { reason });
  return data;
}

export async function activateAdminUser(id: string) {
  const { data } = await client.post(`/api/admin/users/${id}/activate`);
  return data;
}

export async function deleteAdminUser(id: string) {
  const { data } = await client.delete(`/api/admin/users/${id}`);
  return data;
}

export async function extendAdminUser(id: string, days = 30, plan?: string) {
  const { data } = await client.post(`/api/admin/users/${id}/extend`, { days, plan });
  return data;
}

export async function resetAdminAiQuota(id: string, amount?: number) {
  const { data } = await client.post(`/api/admin/users/${id}/reset-ai-quota`, { amount });
  return data;
}

export async function resetAdminPassword(id: string, newPassword: string) {
  const { data } = await client.post(`/api/admin/users/${id}/reset-password`, { newPassword });
  return data;
}

export async function patchAdminUser(id: string, body: Record<string, unknown>) {
  const { data } = await client.patch(`/api/admin/users/${id}`, body);
  return data;
}

export async function getAdminHealth() {
  const { data } = await client.get('/api/admin/health');
  return data;
}

export async function getAdminExpiry() {
  const { data } = await client.get('/api/admin/expiry');
  return data;
}

export async function upsertAdminExpiry(body: Record<string, unknown>) {
  const { data } = await client.post('/api/admin/expiry', body);
  return data;
}

export async function deleteAdminExpiry(id: string) {
  const { data } = await client.delete(`/api/admin/expiry/${id}`);
  return data;
}

export async function getAdminNotifications() {
  const { data } = await client.get('/api/admin/notifications');
  return data;
}

export async function refreshAdminNotifications() {
  const { data } = await client.post('/api/admin/notifications/refresh');
  return data;
}

export async function ackAdminNotification(id: string) {
  const { data } = await client.post(`/api/admin/notifications/${id}/ack`);
  return data;
}

export async function getAdminActivity() {
  const { data } = await client.get('/api/admin/activity');
  return data;
}

export async function getAdminAudit(limit = 100) {
  const { data } = await client.get('/api/admin/audit', { params: { limit } });
  return data;
}

export async function getAdminErrors(limit = 100) {
  const { data } = await client.get('/api/admin/errors', { params: { limit } });
  return data;
}

export async function getAdminAuthEvents(limit = 100) {
  const { data } = await client.get('/api/admin/auth-events', { params: { limit } });
  return data;
}

export async function getAdminPayments(limit = 100) {
  const { data } = await client.get('/api/admin/payments', { params: { limit } });
  return data;
}

export async function getAdminSettings() {
  const { data } = await client.get('/api/admin/settings');
  return data;
}

export async function setAdminMaintenance(enabled: boolean, message?: string) {
  const { data } = await client.post('/api/admin/maintenance', { enabled, message });
  return data;
}

export async function setAdminSecurity(body: Record<string, unknown>) {
  const { data } = await client.post('/api/admin/settings/security', body);
  return data;
}

export async function clearAdminCache() {
  const { data } = await client.post('/api/admin/cache/clear');
  return data;
}

export async function restartAdminQueue() {
  const { data } = await client.post('/api/admin/queue/restart');
  return data;
}

export async function createAdminBackup(pgDump = false) {
  const { data } = await client.post('/api/admin/backup', { pgDump });
  return data;
}

export async function listAdminBackups() {
  const { data } = await client.get('/api/admin/backups');
  return data;
}

export async function restoreAdminBackup(file: string) {
  const { data } = await client.post('/api/admin/backup/restore', { file });
  return data;
}

export async function getAdminOpenAiUsage() {
  const { data } = await client.get('/api/admin/openai-usage');
  return data;
}

export type IntelFilters = {
  q?: string;
  industry?: string;
  country?: string;
  workspace?: string;
  channel?: string;
  status?: string;
  pinned?: string | boolean;
  showArchived?: string | boolean;
  showIgnored?: string | boolean;
  showTest?: string | boolean;
  minRevenue?: string | number;
  minConversion?: string | number;
  minScore?: string | number;
  minReplyRate?: string | number;
  minAppointments?: string | number;
  minLeadQuality?: string | number;
  dateFrom?: string;
  dateTo?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
  limit?: number;
};

export async function getAdminIntelligence(params?: IntelFilters) {
  const { data } = await client.get('/api/admin/intelligence', { params });
  return data;
}

export async function scanAdminIntelligence() {
  const { data } = await client.post('/api/admin/intelligence/scan');
  return data;
}

export async function getAdminCampaignIntelligence(id: string) {
  const { data } = await client.get(`/api/admin/intelligence/campaign/${id}`);
  return data;
}

export async function getAdminCampaignLibrary(params?: IntelFilters) {
  const { data } = await client.get('/api/admin/intelligence/library', { params });
  return data;
}

export async function duplicateAdminLibraryItem(id: string, body?: { name?: string; adaptNotes?: string }) {
  const { data } = await client.post(`/api/admin/intelligence/library/${id}/duplicate`, body || {});
  return data;
}

export async function intelligenceEventAction(id: string, action: string, body?: { confirm?: boolean }) {
  const { data } = await client.post(`/api/admin/intelligence/events/${id}/${action}`, body || {});
  return data;
}

export async function intelligenceLibraryAction(id: string, action: string, body?: { confirm?: boolean }) {
  const { data } = await client.post(`/api/admin/intelligence/library/${id}/${action}`, body || {});
  return data;
}

export async function createIntelligenceLaunchDraft(libraryId: string, body?: {
  channel?: string;
  targetWorkspaceId?: string;
  name?: string;
  subject?: string;
  body?: string;
  settings?: Record<string, unknown>;
}) {
  const { data } = await client.post(`/api/admin/intelligence/library/${libraryId}/launch-draft`, body || {});
  return data;
}

export async function updateIntelligenceLaunchDraft(id: string, body: Record<string, unknown>) {
  const { data } = await client.patch(`/api/admin/intelligence/launch-draft/${id}`, body);
  return data;
}

export async function launchIntelligenceDraft(id: string) {
  const { data } = await client.post(`/api/admin/intelligence/launch-draft/${id}/launch`);
  return data;
}

export async function getIntelligenceWorkspaces() {
  const { data } = await client.get('/api/admin/intelligence/workspaces');
  return data;
}

export async function deleteIntelligenceTestData(confirm = false) {
  const { data } = await client.post('/api/admin/intelligence/test-data/delete', { confirm });
  return data;
}

export async function getIntelligenceFacets() {
  const { data } = await client.get('/api/admin/intelligence/facets');
  return data;
}

export async function recomputeIntelligenceScores(limit?: number) {
  const { data } = await client.post('/api/admin/intelligence/scores/recompute', { limit });
  return data;
}

export async function bulkIntelligenceEventAction(ids: string[], action: string, confirm = false) {
  const { data } = await client.post('/api/admin/intelligence/events/bulk', {
    ids, action, confirm: confirm || undefined,
  });
  return data;
}

export async function bulkIntelligenceLibraryAction(ids: string[], action: string, confirm = false) {
  const { data } = await client.post('/api/admin/intelligence/library/bulk', {
    ids, action, confirm: confirm || undefined,
  });
  return data;
}

export async function listIntelligenceLaunchDrafts(params?: { status?: string; limit?: number }) {
  const { data } = await client.get('/api/admin/intelligence/launch-drafts', { params });
  return data;
}

export async function getIntelligenceLaunchOutcomes(id: string) {
  const { data } = await client.get(`/api/admin/intelligence/launch-draft/${id}/outcomes`);
  return data;
}

export async function cleanupNonOwnerUsers(confirm = false) {
  const { data } = await client.post('/api/admin/users/cleanup-non-owner', { confirm });
  return data;
}

export async function createAdminTestError(message?: string) {
  const { data } = await client.post('/api/admin/errors/test', { message });
  return data;
}
