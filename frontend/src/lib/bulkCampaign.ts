/**
 * Shared bulk campaign transfer from Lead Page / Contacts Page → CRM pages.
 */

import type { Lead } from './apiClient';

export type BulkCampaignChannel = 'email' | 'whatsapp' | 'sms' | 'contacts';
export type BulkCampaignSource = 'leads' | 'contacts';

export interface BulkCampaignPayload {
  channel: BulkCampaignChannel;
  source?: BulkCampaignSource;
  leads: Lead[];
  timestamp?: number;
  createdAt?: number;
}

const STORAGE_KEY = 'bulkCampaign';

export function readBulkCampaign(): BulkCampaignPayload | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw) as BulkCampaignPayload;
    if (!payload || !Array.isArray(payload.leads)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function writeBulkCampaign(payload: BulkCampaignPayload): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...payload,
    timestamp: payload.timestamp || Date.now(),
  }));
}

export function clearBulkCampaign(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function getTransferredLeadsForChannel(channel: BulkCampaignChannel): Lead[] {
  const payload = readBulkCampaign();
  if (!payload || payload.channel !== channel || !Array.isArray(payload.leads)) {
    return [];
  }
  return payload.leads;
}

export function hasTransferredLeads(channel: BulkCampaignChannel): boolean {
  return getTransferredLeadsForChannel(channel).length > 0;
}

export function buildInitialSelection(leads: Lead[]): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  leads.forEach((lead) => {
    if (lead?.id) next[lead.id] = true;
  });
  return next;
}

export function isContactsSource(channel: BulkCampaignChannel): boolean {
  const payload = readBulkCampaign();
  return Boolean(payload && payload.channel === channel && payload.source === 'contacts');
}

export function isLeadsSource(channel: BulkCampaignChannel): boolean {
  const payload = readBulkCampaign();
  return Boolean(payload && payload.channel === channel && payload.source === 'leads');
}
