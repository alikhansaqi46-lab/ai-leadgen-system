const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
app.use(cors({
  origin: [FRONTEND_URL, "http://localhost:3000", "https://ai-leadgen-system-1.onrender.com"],
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Routes with error logging
try {
  app.use('/api/leads', require('./routes/leads'));
  console.log('✅ leads routes loaded');
} catch (err) {
  console.error('❌ Failed to load leads routes:', err);
}

// Note: /api/scrape is defined inline below (SerpAPI route)

// WhatsApp Meta Cloud API routes
try {
  app.use('/api/whatsapp', require('./routes/whatsapp'));
  console.log('✅ WhatsApp Meta API routes loaded');
} catch (err) {
  console.error('❌ Failed to load WhatsApp routes:', err);
}

// Improved email extraction function
async function extractEmailFromPage(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(data);

    // 1. Check mailto: links
    let email = "";
    $('a[href^="mailto:"]').each((i, el) => {
      const mailto = $(el).attr('href');
      const match = mailto.match(/mailto:([^?]+)/);
      if (match && match[1]) {
        email = match[1];
        return false;
      }
    });

    if (email) return email;

    // 2. Check for email patterns in text
    const text = $('body').text();
    const emailMatches = text.match(/[a-zA-Z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
    if (emailMatches && emailMatches.length > 0) {
      // Filter out common false positives
      const validEmails = emailMatches.filter(e =>
        !e.includes('example.com') &&
        !e.includes('domain.com') &&
        !e.includes('email.com') &&
        !e.includes('test.com')
      );
      if (validEmails.length > 0) {
        return validEmails[0];
      }
    }

    return "";
  } catch (err) {
    return "";
  }
}

// Check contact/about pages for emails
async function extractEmail(website) {
  if (!website || website === "N/A") return "N/A";

  try {
    // Ensure URL has protocol
    let baseUrl = website;
    if (!baseUrl.startsWith('http')) {
      baseUrl = 'https://' + baseUrl;
    }

    // 1. Try homepage first
    let email = await extractEmailFromPage(baseUrl);
    if (email) return email;

    // 2. Try common contact pages
    const contactPaths = ['/contact', '/contact-us', '/about', '/about-us'];
    for (const path of contactPaths) {
      try {
        const contactUrl = baseUrl.replace(/\/$/, '') + path;
        email = await extractEmailFromPage(contactUrl);
        if (email) return email;
      } catch {
        continue;
      }
    }

    return "N/A";
  } catch (err) {
    return "N/A";
  }
}

// Delay function
function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// Process leads in batches with limited concurrency
async function processBatch(leads, batchSize = 5) {
  const results = [];
  for (let i = 0; i < leads.length; i += batchSize) {
    const batch = leads.slice(i, i + batchSize);
    const batchPromises = batch.map(async (lead) => {
      try {
        if (lead.website && lead.website !== "N/A") {
          lead.email = await extractEmail(lead.website);
          console.log(`✉️  ${lead.name}: ${lead.email}`);
        } else {
          lead.email = "N/A";
        }
      } catch (err) {
        console.error(`Email extraction failed for ${lead.name}:`, err.message);
        lead.email = "N/A";
      }
      return lead;
    });

    const processed = await Promise.allSettled(batchPromises);
    results.push(...processed.map(p => p.status === 'fulfilled' ? p.value : p.reason));

    // Small delay between batches to be nice to servers
    if (i + batchSize < leads.length) {
      await delay(500);
    }
  }
  return results;
}

// SerpAPI scrape route - STRICT fix for duplicates and over-fetching
app.get("/api/scrape", async (req, res) => {
  const { keyword, location } = req.query;

  console.log("📨 [GET /api/scrape] hit — keyword:", keyword, "location:", location);

  if (!keyword || !location) {
    console.log("❌ Missing keyword or location");
    return res.status(400).json({ error: "Missing keyword or location params" });
  }

  try {
    const API_KEY = "613bdd47bbd9ae7aedeece3b692e0d57cd1ca4f215c769c805688d515022f761"

    console.log("🔍 Searching via SerpAPI:", keyword, location);

    // Parse location: "street, area, city, country" or "area, city, country" or "city, country"
    const locationParts = location.toLowerCase().split(',').map(p => p.trim()).filter(p => p);

    // CORRECT PARSING:
    // - country = last part
    // - city = second-to-last part
    // - area = first or second part (if more than 2 parts)
    const countryName = locationParts[locationParts.length - 1] || '';
    const cityName = locationParts[locationParts.length - 2] || locationParts[0] || '';
    const areaName = locationParts.length > 2 ? locationParts[0] : '';

    // Check if it's a specific area search (has area that's different from city)
    const isAreaSpecificSearch = areaName && areaName !== cityName;

    // DEBUG LOG
    console.log({ country: countryName, city: cityName, area: areaName, parts: locationParts });

    const allResults = [];

    // INCREASED PAGINATION: Fetch up to 5 pages for more results
    for (let i = 0; i < 5; i++) {
      const start = i * 20;

      try {
        const response = await axios.get("https://serpapi.com/search.json", {
          params: {
            engine: "google_maps",
            q: `${keyword} in ${location}`,
            type: "search",
            num: 20,
            start: start,
            api_key: API_KEY
          }
        });

        const results = response.data.local_results || [];
        console.log(`📄 Page ${i + 1}: ${results.length} results`);

        // If no results on this page, stop pagination
        if (results.length === 0) {
          console.log(`✋ No more results on page ${i + 1}, stopping pagination`);
          break;
        }

        for (const place of results) {
          // BALANCED FILTER: Accept all results from API
          // The search query already filters by location
          // We only skip if completely invalid data

          // Extract GPS coordinates if available
          const lat = place.gps_coordinates?.latitude || place.latitude || null;
          const lng = place.gps_coordinates?.longitude || place.longitude || null;

          const lead = {
            name: place.title || "",
            address: place.address || "",
            phone: place.phone || place.formatted_phone_number || "N/A",
            website: place.website || place.link || "N/A",
            place_id: place.place_id || place.data_id || "",
            location: location,
            niche: keyword,
            email: "N/A",
            lat: lat,
            lng: lng,
            _areaMatch: false,  // Will be set after processing
            _distance: null     // Will be calculated after processing
          };

          allResults.push(lead);
        }

      } catch (err) {
        console.error(`⚠️ Error on page ${i + 1}:`, err.message);
      }
    }

    console.log(`📊 Total from API: ${allResults.length} leads`);

    // ===== DISTANCE-BASED FILTERING (PRIMARY) =====
    // Haversine distance calculation
    const getDistance = (lat1, lon1, lat2, lon2) => {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    };

    // Find center point from first result with coordinates
    let centerLat = null;
    let centerLng = null;
    for (const lead of allResults) {
      if (lead.lat && lead.lng) {
        centerLat = lead.lat;
        centerLng = lead.lng;
        console.log(`📍 Center point: ${lead.name} at (${centerLat}, ${centerLng})`);
        break;
      }
    }

    // Score and filter results
    const scoredResults = [];

    for (const lead of allResults) {
      const addressLower = lead.address.toLowerCase();

      // BALANCED AREA MATCHING
      const areaLower = areaName.toLowerCase();
      const hasExactMatch = addressLower.includes(areaLower);
      const hasPartialMatch = areaName.split(/[-\s]+/).filter(w => w.length > 2).some(word =>
        addressLower.includes(word.toLowerCase())
      );
      // Check if address contains city name
      const hasCityMatch = addressLower.includes(cityName);

      let score = 0;
      let distance = null;

      // PRIMARY: Distance-based scoring (if coords available)
      if (centerLat && centerLng && lead.lat && lead.lng) {
        distance = getDistance(centerLat, centerLng, lead.lat, lead.lng);
        lead._distance = distance;

        if (distance <= 5) {
          // 0-5 km = HIGH priority
          score = 90 - distance;
        } else if (distance <= 8) {
          // 5-8 km = Medium priority
          score = 75 - (distance - 5) * 5;
        } else if (distance <= 15) {
          // 8-15 km = Lower priority but acceptable (same city area)
          score = 50 - (distance - 8) * 2;
        } else {
          // Beyond 15km = Low score but still include
          score = 25;
        }
      }
      // SECONDARY: Text-based matching
      else if (hasExactMatch) {
        score = 85;
      } else if (hasPartialMatch) {
        score = 70;
      } else if (hasCityMatch) {
        score = 60;
      } else {
        // Include all other results with base score
        score = 40;
      }

      // Log only high-scoring leads to reduce noise
      if (score >= 70) {
        console.log(`✅ High score (${score.toFixed(0)}): ${lead.name} ${distance ? `(${distance.toFixed(1)}km)` : ''}`);
      }

      scoredResults.push({ ...lead, _score: score });
    }

    // Sort by score (highest first)
    scoredResults.sort((a, b) => b._score - a._score);

    console.log(`📊 After distance filtering: ${scoredResults.length} leads`);

    // STRICT DEDUPLICATION - by place_id, name+address, phone, and website
    const seen = new Set();
    const seenPhones = new Set();
    const seenWebsites = new Set();
    const seenNames = new Set(); // For fuzzy name matching
    const unique = [];

    scoredResults.forEach(lead => {
      const nameKey = lead.name.toLowerCase().trim();
      const addressKey = lead.address.toLowerCase().trim();
      const key = `${nameKey}-${addressKey}`;
      const phoneKey = lead.phone !== "N/A" ? lead.phone : null;
      const websiteKey = lead.website !== "N/A" ? lead.website : null;
      const placeKey = lead.place_id;

      // Normalize name for fuzzy matching (remove common suffixes)
      const normalizedName = nameKey
        .replace(/\s+(clinic|hospital|center|centre|care|services|dental|medical|surgery)\s*$/i, '')
        .replace(/[^a-z0-9]/g, ''); // Remove special chars

      // Check all possible duplicate keys
      let isDuplicate = false;
      let dupReason = '';

      // Same place_id
      if (placeKey && seen.has(placeKey)) {
        dupReason = 'place_id';
        isDuplicate = true;
      }

      // Same name+address
      if (!isDuplicate && seen.has(key)) {
        dupReason = 'name+address';
        isDuplicate = true;
      }

      // Same phone (if exists)
      if (!isDuplicate && phoneKey && seenPhones.has(phoneKey)) {
        dupReason = 'phone';
        isDuplicate = true;
      }

      // Same website (if exists and not generic)
      if (!isDuplicate && websiteKey && websiteKey !== 'N/A' && !websiteKey.includes('facebook.com')) {
        if (seenWebsites.has(websiteKey)) {
          dupReason = 'website';
          isDuplicate = true;
        }
      }

      // REMOVED: Aggressive fuzzy name matching
      // Different branches of same chain (Starbucks, Guardian, etc.) are VALID leads
      // Only remove exact duplicates (same place_id, phone, or website)

      if (isDuplicate) {
        console.log(`🗑️ Duplicate (${dupReason}): ${lead.name}`);
      } else {
        seen.add(key);
        if (placeKey) seen.add(placeKey);
        if (phoneKey) seenPhones.add(phoneKey);
        if (websiteKey) seenWebsites.add(websiteKey);
        seenNames.add(normalizedName);
        unique.push(lead);
      }
    });

    console.log("Final leads count:", unique.length);

    // BALANCED LIMITS: Return more leads for better coverage
    // Area search: 40 leads | City search: 60 leads
    const maxLeads = isAreaSpecificSearch ? 40 : 60;
    const finalLeads = unique.slice(0, maxLeads);
    console.log(`✅ RETURNING ${finalLeads.length} leads (max: ${maxLeads})`);
    console.log(`📊 Flow: ${allResults.length} fetched → ${scoredResults.length} scored → ${unique.length} unique → ${finalLeads.length} final`);

    // Extract emails
    const processedLeads = await processBatch(finalLeads, 5);
    console.log(`✅ Processed ${processedLeads.length} leads with emails`);

    // Auto-save to database
    try {
      const { db } = require('./config/firebase');
      if (db && processedLeads.length > 0) {
        const batch = db.batch();

        for (const lead of processedLeads) {
          const docRef = db.collection('leads').doc();
          batch.set(docRef, {
            ...lead,
            id: docRef.id,
            createdAt: new Date().toISOString(),
            source: 'scraped'
          });
        }

        await batch.commit();
        console.log(`💾 Auto-saved ${processedLeads.length} leads`);
      }
    } catch (saveErr) {
      console.error('⚠️ Auto-save failed:', saveErr.message);
    }

    return res.json(processedLeads);

  } catch (error) {
    console.error("❌ ERROR:", error.message);
    return res.status(500).json({ error: "Scraping failed", details: error.message });
  }
});

// ==================== EMAIL SENDING SYSTEM ====================
const nodemailer = require('nodemailer');

// Check if email is configured
const isEmailConfigured = process.env.EMAIL_USER && process.env.EMAIL_PASS;

// Create transporter only if configured
let transporter = null;
if (isEmailConfigured) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
  console.log('📧 Email system configured for:', process.env.EMAIL_USER);
} else {
  console.log('⚠️ Email not configured. Set EMAIL_USER and EMAIL_PASS to enable email sending.');
}

// Send email to a lead with custom message
const sendEmail = async (lead, customMessage, customSubject, campaignData) => {
  // Check if email is configured
  if (!isEmailConfigured || !transporter) {
    throw new Error('Email not configured. Set EMAIL_USER and EMAIL_PASS environment variables.');
  }

  const { email, name, city, niche } = lead;

  if (!email || email === 'N/A' || !email.includes('@')) {
    throw new Error('Invalid email address');
  }

  const businessName = name || 'there';
  const businessCity = city || '';
  const businessNiche = niche || 'business';
  const companyName = campaignData?.companyName || 'our company';
  const productService = campaignData?.productService || 'our services';
  const offer = campaignData?.offer || 'help you grow';

  // Use custom message if provided, otherwise use default
  let messageText = customMessage || `Hi ${businessName},

I noticed your ${businessNiche} in ${businessCity} and wanted to reach out.

I help businesses like yours get more customers using ${productService}.

${offer ? `Currently offering: ${offer}` : ''}

Would you be open to a quick chat?

Best regards from ${companyName}`;

  let messageHtml = customMessage
    ? `<p>${customMessage.replace(/\n/g, '</p><p>')}</p>`
    : `<p>Hi ${businessName},</p>

<p>I noticed your ${businessNiche} in ${businessCity} and wanted to reach out.</p>

<p>I help businesses like yours get more customers using ${productService}.</p>

${offer ? `<p><strong>Currently offering:</strong> ${offer}</p>` : ''}

<p>Would you be open to a quick chat?</p>

<p>Best regards from ${companyName}</p>`;

  const subject = customSubject || `Quick question about ${businessName}`;

  const mailOptions = {
    from: `"${companyName}" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: subject,
    text: messageText,
    html: messageHtml
  };

  const result = await transporter.sendMail(mailOptions);
  console.log(`✅ Email sent to ${email}: ${result.messageId}`);
  return result;
};

// Email sending endpoint
app.post('/api/send-email', async (req, res) => {
  try {
    const { lead, message, subject, campaign } = req.body;

    if (!lead || !lead.email) {
      return res.status(400).json({ error: 'Lead email is required' });
    }

    // Check if email credentials are configured
    if (!isEmailConfigured) {
      return res.status(503).json({
        error: 'Email not configured',
        message: 'Please set EMAIL_USER and EMAIL_PASS environment variables in .env file'
      });
    }

    const result = await sendEmail(lead, message, subject, campaign);

    res.json({
      success: true,
      message: `Email sent to ${lead.email}`,
      messageId: result.messageId
    });
  } catch (error) {
    console.error('❌ Email send failed:', error.message);
    res.status(500).json({
      error: 'Failed to send email',
      message: error.message
    });
  }
});

// ==================== WHATSAPP BUSINESS API ====================

// Check WhatsApp API configuration
const WHATSAPP_PROVIDER = process.env.WHATSAPP_PROVIDER || 'twilio'; // 'twilio' or 'meta'

// Twilio configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // Format: whatsapp:+1234567890

// Meta Cloud API configuration
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Check if WhatsApp is configured
const isWhatsAppConfigured = () => {
  if (WHATSAPP_PROVIDER === 'twilio') {
    return TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_NUMBER;
  } else if (WHATSAPP_PROVIDER === 'meta') {
    return WHATSAPP_TOKEN && PHONE_NUMBER_ID;
  }
  return false;
};

// Log configuration status
if (isWhatsAppConfigured()) {
  console.log(`✅ WhatsApp API configured (${WHATSAPP_PROVIDER})`);
} else {
  console.log('⚠️ WhatsApp API not configured. Set provider-specific env vars to enable WhatsApp sending.');
  console.log('   Twilio: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER');
  console.log('   Meta: WHATSAPP_TOKEN, PHONE_NUMBER_ID');
}

// Send WhatsApp message via Twilio
const sendWhatsAppTwilio = async (phone, message) => {
  const cleanPhone = phone.replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 6) {
    throw new Error('Invalid phone number');
  }

  const formattedPhone = `whatsapp:+${cleanPhone}`;

  // Twilio API request using Basic Auth
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  const params = new URLSearchParams();
  params.append('From', TWILIO_WHATSAPP_NUMBER);
  params.append('To', formattedPhone);
  params.append('Body', message);

  try {
    const response = await axios.post(url, params.toString(), {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    return {
      success: true,
      messageId: response.data.sid,
      status: response.data.status
    };
  } catch (error) {
    // Check if number is not on WhatsApp
    if (error.response?.data?.code === 63016 || error.response?.data?.more_info?.includes('not a valid')) {
      throw new Error('Phone number not on WhatsApp or invalid');
    }
    throw new Error(error.response?.data?.message || error.message);
  }
};

// Send WhatsApp message via Meta Cloud API
const sendWhatsAppMeta = async (phone, message) => {
  const cleanPhone = phone.replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 6) {
    throw new Error('Invalid phone number');
  }

  const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

  try {
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: { body: message }
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      success: true,
      messageId: response.data.messages?.[0]?.id,
      status: 'sent'
    };
  } catch (error) {
    // Handle Meta API specific errors
    const errorData = error.response?.data?.error;
    if (errorData) {
      if (errorData.code === 131026) {
        throw new Error('Phone number not on WhatsApp');
      }
      throw new Error(errorData.message || 'Meta API error');
    }
    throw new Error(error.message);
  }
};

// Universal WhatsApp send function
const sendWhatsAppMessage = async (phone, message, testMode = false) => {
  if (testMode) {
    console.log(`🧪 TEST MODE: Would send to ${phone}:`, message.substring(0, 50) + '...');
    return {
      success: true,
      messageId: 'test-' + Date.now(),
      status: 'test',
      testMode: true
    };
  }

  if (!isWhatsAppConfigured()) {
    throw new Error('WhatsApp API not configured');
  }

  if (WHATSAPP_PROVIDER === 'twilio') {
    return await sendWhatsAppTwilio(phone, message);
  } else if (WHATSAPP_PROVIDER === 'meta') {
    return await sendWhatsAppMeta(phone, message);
  } else {
    throw new Error(`Unknown WhatsApp provider: ${WHATSAPP_PROVIDER}`);
  }
};

// WhatsApp sending endpoint
app.post('/api/send-whatsapp', async (req, res) => {
  try {
    const { phone, message, testMode = false } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Check if WhatsApp is configured
    if (!isWhatsAppConfigured() && !testMode) {
      return res.status(503).json({
        error: 'WhatsApp not configured',
        message: `Please set ${WHATSAPP_PROVIDER === 'twilio' ? 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER' : 'WHATSAPP_TOKEN, PHONE_NUMBER_ID'} environment variables`,
        provider: WHATSAPP_PROVIDER
      });
    }

    const result = await sendWhatsAppMessage(phone, message, testMode);

    res.json({
      success: true,
      message: testMode ? 'Test: Message would be sent' : `WhatsApp message sent to ${phone}`,
      messageId: result.messageId,
      status: result.status,
      testMode: result.testMode || false
    });

  } catch (error) {
    console.error('❌ WhatsApp send failed:', error.message);

    // Determine if it's a "not on WhatsApp" error
    const notOnWhatsApp = error.message.includes('not on WhatsApp') || error.message.includes('not a valid');

    res.status(500).json({
      error: 'Failed to send WhatsApp message',
      message: error.message,
      notOnWhatsApp: notOnWhatsApp
    });
  }
});

// Bulk WhatsApp status endpoint (for frontend polling)
app.get('/api/whatsapp-status', (req, res) => {
  res.json({
    configured: isWhatsAppConfigured(),
    provider: WHATSAPP_PROVIDER,
    testMode: process.env.WHATSAPP_TEST_MODE === 'true'
  });
});

// Root health check for Render port detection
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'AI LeadGen API is running', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Serve React frontend build (monorepo deployment)
const buildPath = path.join(__dirname, '../frontend/build');
app.use(express.static(buildPath));

// Catch-all: serve React's index.html for non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(buildPath, 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('GLOBAL ERROR:', err);
  console.error('Stack:', err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    stack: err.stack
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
