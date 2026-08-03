/**
 * SMS Service — Twilio REST API wrapper.
 *
 * Uses axios (already a project dependency) to avoid adding the twilio SDK.
 * All credentials are read from integrationStorage per workspace.
 *
 * Usage:
 *   const { sendSms, isSmsConfigured } = require('./smsService');
 *   const result = await sendSms({ to, body, workspaceId });
 */

const axios = require('axios');
const integrationStorage = require('../utils/integrationStorage');

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

function getSmsCredentials(workspaceId = 'default') {
  const creds = integrationStorage.getCredentials(workspaceId, 'sms');
  if (!creds) return null;
  return {
    accountSid: creds.accountSid || null,
    authToken: creds.authToken || null,
    phoneNumber: creds.phoneNumber || null,
  };
}

function isSmsConfigured(workspaceId = 'default') {
  const c = getSmsCredentials(workspaceId);
  return !!(c && c.accountSid && c.authToken && c.phoneNumber);
}

/**
 * Send a single SMS via Twilio.
 *
 * @param {Object} params
 * @param {string} params.to — E.164 phone number (e.g. +1234567890)
 * @param {string} params.body — Message text (max 1600 chars for Twilio)
 * @param {string} params.workspaceId — Workspace scope
 * @param {string} [params.statusCallback] — Optional webhook URL for delivery updates
 * @param {boolean} [params.testMode] — If true, return mock response without calling Twilio
 * @param {string} [params.mediaUrl] — Optional public URL for MMS image
 */
async function sendSms({ to, body, workspaceId = 'default', statusCallback, testMode = false, mediaUrl }) {
  if (testMode) {
    return {
      success: true,
      messageId: `test-sms-${Date.now()}`,
      status: 'test',
      testMode: true,
    };
  }

  const creds = getSmsCredentials(workspaceId);
  if (!creds || !creds.accountSid || !creds.authToken || !creds.phoneNumber) {
    throw new Error('SMS not configured. Connect SMS in Settings.');
  }

  const url = `${TWILIO_API_BASE}/Accounts/${creds.accountSid}/Messages.json`;

  const form = new URLSearchParams();
  form.append('From', creds.phoneNumber);
  form.append('To', to);
  form.append('Body', body);
  if (statusCallback) {
    form.append('StatusCallback', statusCallback);
  }
  if (mediaUrl) {
    form.append('MediaUrl', mediaUrl);
  }

  try {
    const res = await axios.post(url, form.toString(), {
      auth: { username: creds.accountSid, password: creds.authToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = res.data;
    return {
      success: true,
      messageId: data.sid,
      status: data.status,
      price: data.price ? parseFloat(data.price) : null,
      priceUnit: data.price_unit || 'USD',
      uri: data.uri || null,
      dateCreated: data.date_created || null,
    };
  } catch (err) {
    const twilioErr = err.response?.data;
    const message = twilioErr?.message || err.message;
    const code = twilioErr?.code || err.response?.status;
    throw new Error(`Twilio SMS failed (${code}): ${message}`);
  }
}

module.exports = { getSmsCredentials, isSmsConfigured, sendSms };
