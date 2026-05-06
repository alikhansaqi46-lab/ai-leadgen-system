/**
 * WhatsApp Meta Cloud API Service
 * Production-ready service for sending WhatsApp messages via Meta Graph API
 * Supports: text messages, templates, media, and status tracking
 */

const axios = require('axios');

// Graph API version
const GRAPH_API_VERSION = 'v18.0';
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Send a WhatsApp text message via Meta Cloud API
 */
async function sendTextMessage({ token, phoneNumberId, to, message, testMode = false }) {
  if (testMode) {
    console.log(`🧪 TEST MODE: Would send text to ${to}: ${message.substring(0, 60)}...`);
    return {
      success: true,
      messageId: `test-${Date.now()}`,
      status: 'test',
      testMode: true
    };
  }

  const cleanPhone = to.replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 6) {
    throw new Error('Invalid phone number');
  }

  const url = `${BASE_URL}/${phoneNumberId}/messages`;

  try {
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: { body: message }
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    return {
      success: true,
      messageId: response.data.messages?.[0]?.id,
      status: 'sent',
      contact: response.data.contacts?.[0]
    };
  } catch (error) {
    const errorData = error.response?.data?.error;
    if (errorData) {
      // Meta API specific error codes
      if (errorData.code === 131026) {
        throw new Error('Phone number not registered on WhatsApp');
      }
      if (errorData.code === 132000) {
        throw new Error('Template does not exist or is not approved');
      }
      if (errorData.code === 130429) {
        throw new Error('Rate limit exceeded. Please wait before sending more messages.');
      }
      if (errorData.code === 190) {
        throw new Error('Invalid access token. Please check your WHATSAPP_TOKEN.');
      }
      throw new Error(errorData.message || `Meta API Error: ${errorData.code}`);
    }
    throw new Error(error.message || 'Failed to send WhatsApp message');
  }
}

/**
 * Send a WhatsApp template message via Meta Cloud API
 * Templates must be pre-approved in Meta Business Manager
 */
async function sendTemplateMessage({ token, phoneNumberId, to, templateName, languageCode = 'en_US', templateParams = [], testMode = false }) {
  if (testMode) {
    console.log(`🧪 TEST MODE: Would send template "${templateName}" to ${to}`);
    return {
      success: true,
      messageId: `test-${Date.now()}`,
      status: 'test',
      testMode: true
    };
  }

  const cleanPhone = to.replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 6) {
    throw new Error('Invalid phone number');
  }

  const url = `${BASE_URL}/${phoneNumberId}/messages`;

  // Build template body with parameters if provided
  const templateBody = {
    name: templateName,
    language: {
      code: languageCode
    }
  };

  if (templateParams && templateParams.length > 0) {
    templateBody.components = [{
      type: 'body',
      parameters: templateParams.map(param => ({
        type: 'text',
        text: param
      }))
    }];
  }

  try {
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'template',
      template: templateBody
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    return {
      success: true,
      messageId: response.data.messages?.[0]?.id,
      status: 'sent',
      contact: response.data.contacts?.[0]
    };
  } catch (error) {
    const errorData = error.response?.data?.error;
    if (errorData) {
      if (errorData.code === 132000) {
        throw new Error(`Template "${templateName}" not found or not approved. Please create it in Meta Business Manager.`);
      }
      if (errorData.code === 131026) {
        throw new Error('Phone number not registered on WhatsApp');
      }
      if (errorData.code === 130429) {
        throw new Error('Rate limit exceeded. Please wait before sending more messages.');
      }
      throw new Error(errorData.message || `Meta API Error: ${errorData.code}`);
    }
    throw new Error(error.message || 'Failed to send WhatsApp template');
  }
}

/**
 * Get WhatsApp Business Account info and templates
 */
async function getBusinessInfo(token, phoneNumberId) {
  try {
    const url = `${BASE_URL}/${phoneNumberId}?fields=id,display_phone_number,quality_rating,verified_name`;
    const response = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 10000
    });
    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    const errorData = error.response?.data?.error;
    throw new Error(errorData?.message || error.message || 'Failed to get business info');
  }
}

/**
 * Get all approved message templates for a WhatsApp Business Account
 */
async function getMessageTemplates(token, wabaId) {
  try {
    const url = `${BASE_URL}/${wabaId}/message_templates`;
    const response = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 10000
    });
    return {
      success: true,
      templates: response.data.data || []
    };
  } catch (error) {
    const errorData = error.response?.data?.error;
    throw new Error(errorData?.message || error.message || 'Failed to get message templates');
  }
}

/**
 * Validate Meta API credentials
 */
async function validateCredentials(token, phoneNumberId) {
  try {
    const url = `${BASE_URL}/${phoneNumberId}?fields=id,display_phone_number`;
    await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 10000
    });
    return { valid: true };
  } catch (error) {
    const errorData = error.response?.data?.error;
    return {
      valid: false,
      error: errorData?.message || error.message || 'Invalid credentials'
    };
  }
}

/**
 * Send a reply to an incoming WhatsApp message
 * Uses the sender's phone number (from webhook payload)
 */
async function sendReply({ token, phoneNumberId, to, message, replyToMessageId = null }) {
  const cleanPhone = to.replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 6) {
    throw new Error('Invalid phone number for reply');
  }

  const url = `${BASE_URL}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'text',
    text: { body: message }
  };

  // Add context if replying to a specific message
  if (replyToMessageId) {
    payload.context = {
      message_id: replyToMessageId
    };
  }

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    return {
      success: true,
      messageId: response.data.messages?.[0]?.id,
      status: 'sent',
      contact: response.data.contacts?.[0]
    };
  } catch (error) {
    const errorData = error.response?.data?.error;
    console.error('❌ sendReply error:', errorData || error.message);
    if (errorData) {
      if (errorData.code === 131026) {
        throw new Error('Phone number not registered on WhatsApp');
      }
      if (errorData.code === 190) {
        throw new Error('Invalid access token');
      }
      throw new Error(errorData.message || `Meta API Error: ${errorData.code}`);
    }
    throw new Error(error.message || 'Failed to send reply');
  }
}

/**
 * Format phone number for WhatsApp API (remove non-digits, ensure country code)
 */
function formatPhoneNumber(phone) {
  const cleaned = phone.replace(/\D/g, '');
  // Ensure it starts with country code (add 1 if US number without country code)
  if (cleaned.length === 10) {
    return '1' + cleaned;
  }
  return cleaned;
}

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  sendReply,
  getBusinessInfo,
  getMessageTemplates,
  validateCredentials,
  formatPhoneNumber
};
