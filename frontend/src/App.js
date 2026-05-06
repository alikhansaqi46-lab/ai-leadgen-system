import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import './index.css';

const API_BASE = "http://localhost:5001";
const API_URL = process.env.REACT_APP_API_URL || '';

// Complete Implementation - April 2025

function App() {
  const [leads, setLeads] = useState([]);
  const [status, setStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [scraping, setScraping] = useState(false);

  // Row selection state
  const [selectedLeads, setSelectedLeads] = useState(new Set());
  const [showColumnDropdown, setShowColumnDropdown] = useState(false);

  // Message template state - load from campaign if available
  const [messageTemplate, setMessageTemplate] = useState(() => {
    const savedCampaign = localStorage.getItem('leadgen_campaign');
    if (savedCampaign) {
      const campaign = JSON.parse(savedCampaign);
      return campaign.messageTemplate || "Hi {name}, I found your {niche} business and I can help you get more customers. Are you interested?";
    }
    return "Hi {name}, I found your {niche} business and I can help you get more customers. Are you interested?";
  });
  const [showMessageEditor, setShowMessageEditor] = useState(false);

  // Auto Sender System state (Phase 4)
  const [autoSendMode, setAutoSendMode] = useState(false);
  const [sendQueue, setSendQueue] = useState([]);
  const [sendProgress, setSendProgress] = useState({ current: 0, total: 0, status: 'idle' }); // idle, sending, completed, failed
  const [sendDelay, setSendDelay] = useState(1500); // milliseconds (1-3 seconds default 1.5s)
  const [sendStatusMap, setSendStatusMap] = useState(new Map()); // leadId -> 'pending' | 'sending' | 'sent' | 'failed'

  // WhatsApp Meta Cloud API state (Production)
  const [whatsAppTestMode, setWhatsAppTestMode] = useState(() => {
    return localStorage.getItem('leadgen_whatsapp_test_mode') === 'true';
  });
  const [whatsAppApiConfigured, setWhatsAppApiConfigured] = useState(false);
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);
  const [whatsAppFailedLeads, setWhatsAppFailedLeads] = useState([]);

  // WhatsApp Credentials (Client-ready for SaaS)
  const [showWhatsAppConfig, setShowWhatsAppConfig] = useState(false);
  const [whatsAppToken, setWhatsAppToken] = useState(() => localStorage.getItem('leadgen_whatsapp_token') || '');
  const [whatsAppPhoneId, setWhatsAppPhoneId] = useState(() => localStorage.getItem('leadgen_whatsapp_phone_id') || '');
  const [whatsAppWabaId, setWhatsAppWabaId] = useState(() => localStorage.getItem('leadgen_whatsapp_waba_id') || '');
  const [savingCredentials, setSavingCredentials] = useState(false);

  // WhatsApp Template Mode
  const [useTemplateMode, setUseTemplateMode] = useState(() => {
    return localStorage.getItem('leadgen_whatsapp_template_mode') === 'true';
  });
  const [templateName, setTemplateName] = useState(() => localStorage.getItem('leadgen_whatsapp_template_name') || 'hello_world');
  const [templateLanguage, setTemplateLanguage] = useState('en_US');

  // Column visibility state
  const [visibleColumns, setVisibleColumns] = useState({
    name: true,
    phone: true,
    email: true,
    address: true,
    website: true,
    location: true,
    niche: true,
    action: true
  });

  const [scrapeForm, setScrapeForm] = useState({
    query: '',
    country: '',
    city: '',
    area: '',
    street: '',
    maxResults: 20
  });

  // Campaign Settings State (Phase 4 - Campaign Panel)
  const [campaign, setCampaign] = useState(() => {
    // Load from localStorage on init
    const saved = localStorage.getItem('leadgen_campaign');
    return saved ? JSON.parse(saved) : {
      name: '',
      companyName: '',
      productService: '',
      targetAudience: '',
      country: '',
      city: '',
      offer: '',
      messageTemplate: 'Hi {name}, I found your {niche} in {city}. I help businesses like yours get more customers. Are you interested?'
    };
  });
  const [showCampaignPanel, setShowCampaignPanel] = useState(false);
  const [campaignSaved, setCampaignSaved] = useState(false);

  // AI Message Generation State
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiGenCount, setAiGenCount] = useState(() => {
    // Load generation count from session
    const saved = sessionStorage.getItem('leadgen_ai_count');
    return saved ? parseInt(saved, 10) : 0;
  });
  const [aiAutoTriggered, setAiAutoTriggered] = useState(false);

  // AI Auto Reply Bot State (Phase 5)
  const [showReplyPanel, setShowReplyPanel] = useState(false);
  const [incomingMessage, setIncomingMessage] = useState('');
  const [aiReply, setAiReply] = useState('');
  const [autoReplyMode, setAutoReplyMode] = useState(() => {
    return localStorage.getItem('leadgen_auto_reply') === 'true';
  });
  const [replyGenCount, setReplyGenCount] = useState(() => {
    const saved = sessionStorage.getItem('leadgen_reply_count');
    return saved ? parseInt(saved, 10) : 0;
  });
  const [replyGenerating, setReplyGenerating] = useState(false);

  // Email sending state
  const [sendingEmail, setSendingEmail] = useState(false);

  const countries = [...new Set(leads.map(l => l.country))];
  const niches = [...new Set(leads.map(l => l.niche))];

  // ==================== HELPER FUNCTIONS ====================

  // Generate WhatsApp link from phone number
  const getWhatsAppLink = (phone) => {
    if (!phone || phone === 'Not Available') return null;
    // Remove all non-numeric characters except +
    const cleanPhone = phone.replace(/[^0-9+]/g, '');
    if (!cleanPhone) return null;
    return `https://wa.me/${cleanPhone}`;
  };

  // Get clean website URL (filter out Google Maps URLs)
  const getCleanWebsite = (website) => {
    if (!website || website === 'Not Available') return null;
    // Filter out Google Maps URLs
    if (website.includes('google.com/maps') || website.includes('maps.google')) {
      return null;
    }
    // Ensure URL starts with http
    if (!website.startsWith('http')) {
      return `https://${website}`;
    }
    return website;
  };

  // Format phone for display
  const formatPhone = (phone) => {
    if (!phone || phone === 'Not Available') return null;
    return phone;
  };

  // Get Google Maps link for address
  const getMapsLink = (address) => {
    if (!address || address === 'Not Available') return null;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  };

  // ==================== SELECTION FUNCTIONS ====================

  // Toggle selection of a single lead
  const toggleLeadSelection = (leadId) => {
    setSelectedLeads(prev => {
      const newSet = new Set(prev);
      if (newSet.has(leadId)) {
        newSet.delete(leadId);
      } else {
        newSet.add(leadId);
      }
      return newSet;
    });
  };

  // Select/deselect all leads
  const toggleSelectAll = () => {
    if (selectedLeads.size === leads.length) {
      setSelectedLeads(new Set());
    } else {
      setSelectedLeads(new Set(leads.map(l => l.id)));
    }
  };

  // Toggle column visibility
  const toggleColumn = (column) => {
    setVisibleColumns(prev => ({
      ...prev,
      [column]: !prev[column]
    }));
  };

  // ==================== CAMPAIGN FUNCTIONS ====================

  // Save campaign to localStorage
  const saveCampaign = () => {
    localStorage.setItem('leadgen_campaign', JSON.stringify(campaign));
    setCampaignSaved(true);
    setTimeout(() => setCampaignSaved(false), 2000);

    // Also update scrape form with campaign data
    setScrapeForm(prev => ({
      ...prev,
      query: campaign.targetAudience || prev.query,
      country: campaign.country || prev.country,
      city: campaign.city || prev.city
    }));

    // Update message template
    setMessageTemplate(campaign.messageTemplate);

    console.log('💾 Campaign saved:', campaign.name);
  };

  // Load campaign to form
  const loadCampaign = () => {
    const saved = localStorage.getItem('leadgen_campaign');
    if (saved) {
      const loaded = JSON.parse(saved);
      setCampaign(loaded);
      setMessageTemplate(loaded.messageTemplate);
      console.log('📂 Campaign loaded:', loaded.name);
      return true;
    }
    return false;
  };

  // Apply campaign to message with all variables
  const applyCampaignToMessage = (lead) => {
    let message = campaign.messageTemplate || messageTemplate;

    // Replace all variables
    message = message
      .replace(/{name}/g, lead.name || 'there')
      .replace(/{city}/g, lead.city || campaign.city || '')
      .replace(/{niche}/g, lead.niche || campaign.targetAudience || 'business')
      .replace(/{company}/g, campaign.companyName || 'our company')
      .replace(/{product}/g, campaign.productService || 'our services')
      .replace(/{offer}/g, campaign.offer || 'help you grow');

    return message;
  };

  // ==================== AI MESSAGE GENERATION ====================

  // Generate AI message using OpenAI-style API
  const generateAIMessage = async (isAuto = false) => {
    // Check if we have required fields
    if (!campaign.targetAudience || !campaign.companyName) {
      if (!isAuto) {
        setStatus({ type: 'error', message: 'Please fill Target Audience and Company Name first' });
        setTimeout(() => setStatus(null), 3000);
      }
      return false;
    }

    // Check generation limit (max 3 per session)
    if (aiGenCount >= 3) {
      if (!isAuto) {
        setStatus({ type: 'error', message: 'AI generation limit reached (max 3 per session). Use fallback templates.' });
        setTimeout(() => setStatus(null), 3000);
      }
      return false;
    }

    setAiGenerating(true);
    setStatus({ type: 'loading', message: '🤖 Generating AI message...' });

    try {
      // Build the prompt
      const prompt = `Write a short WhatsApp outreach message for a ${campaign.targetAudience} business in ${campaign.city || 'their area'}.

Company: ${campaign.companyName}
Product/Service: ${campaign.productService || 'helping businesses grow'}
Target: ${campaign.targetAudience}
Location: ${campaign.city || 'local area'}
Offer: ${campaign.offer || 'a special offer'}

Requirements:
- Keep it 2-3 lines maximum
- Friendly and professional tone
- Mention the offer
- Include placeholders: {name} for business name, {niche} for business type, {city} for location
- End with a question to encourage reply
- No emojis unless appropriate

Example format: "Hi {name}, I found your {niche} in {city}. [Message about offer]. Interested?"`;

      // Try to call OpenAI API (fallback if no API key configured)
      let generatedMessage = null;

      // Check if OpenAI API key is available (you'd need to add OPENAI_API_KEY to env)
      const apiKey = process.env.REACT_APP_OPENAI_API_KEY;

      if (apiKey) {
        try {
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: 'gpt-3.5-turbo',
              messages: [
                {
                  role: 'system',
                  content: 'You are a sales copywriter. Write short, high-converting WhatsApp outreach messages.'
                },
                {
                  role: 'user',
                  content: prompt
                }
              ],
              max_tokens: 150,
              temperature: 0.7
            })
          });

          if (response.ok) {
            const data = await response.json();
            generatedMessage = data.choices?.[0]?.message?.content?.trim();
          }
        } catch (apiError) {
          console.warn('OpenAI API call failed:', apiError.message);
        }
      }

      // If no API response, use fallback templates based on niche
      if (!generatedMessage) {
        generatedMessage = getFallbackTemplate(campaign.targetAudience, campaign.companyName, campaign.productService, campaign.offer);
        console.log('🔄 Using fallback template (no API key or API failed)');
      }

      // Clean up the message
      generatedMessage = generatedMessage
        .replace(/^["']|["']$/g, '') // Remove surrounding quotes
        .replace(/\n+/g, ' ') // Replace newlines with spaces
        .trim();

      // Ensure it has required placeholders
      if (!generatedMessage.includes('{name}')) {
        generatedMessage = `Hi {name}, ${generatedMessage}`;
      }

      // Update campaign and message template
      setCampaign(prev => ({ ...prev, messageTemplate: generatedMessage }));
      setMessageTemplate(generatedMessage);

      // Increment generation count
      const newCount = aiGenCount + 1;
      setAiGenCount(newCount);
      sessionStorage.setItem('leadgen_ai_count', newCount.toString());

      setStatus({
        type: 'success',
        message: `✅ AI message generated! (${newCount}/3 used)`
      });
      setTimeout(() => setStatus(null), 3000);

      return true;

    } catch (error) {
      console.error('AI generation failed:', error);

      // Use fallback on error
      const fallback = getFallbackTemplate(campaign.targetAudience, campaign.companyName, campaign.productService, campaign.offer);
      setCampaign(prev => ({ ...prev, messageTemplate: fallback }));
      setMessageTemplate(fallback);

      if (!isAuto) {
        setStatus({ type: 'error', message: 'AI generation failed. Using fallback template.' });
        setTimeout(() => setStatus(null), 3000);
      }
      return false;
    } finally {
      setAiGenerating(false);
    }
  };

  // Fallback templates by niche
  const getFallbackTemplate = (niche, company, product, offer) => {
    const nicheLower = niche?.toLowerCase() || 'business';

    const templates = {
      dental: `Hi {name}, I found your dental clinic in {city}. I'm from ${company || 'a dental supply company'}. We provide ${product || 'quality dental equipment'} with ${offer || 'special pricing for clinics'}. Would you be open to a quick chat about upgrading your supplies?`,

      gym: `Hi {name}, I came across your gym in {city}. I'm with ${company || 'a fitness solutions company'}. We help gyms like yours ${product || 'attract more members'} with ${offer || 'proven marketing strategies'}. Interested in learning more?`,

      restaurant: `Hi {name}, I noticed your restaurant in {city}. I'm from ${company || 'a restaurant marketing agency'}. We help restaurants ${product || 'get more customers'} through ${offer || 'our reservation platform'}. Would you like to hear how it works?`,

      salon: `Hi {name}, I found your salon in {city}. I'm with ${company || 'a beauty supply company'}. We offer ${product || 'premium salon products'} with ${offer || 'exclusive wholesale pricing'}. Interested in our catalog?`,

      clinic: `Hi {name}, I came across your clinic in {city}. I'm from ${company || 'a healthcare solutions provider'}. We help clinics ${product || 'streamline operations'} with ${offer || 'our management software'}. Open to a quick demo?`,

      hotel: `Hi {name}, I found your hotel in {city}. I'm with ${company || 'a hospitality services company'}. We help hotels ${product || 'increase bookings'} through ${offer || 'our booking platform'}. Would you like to see how?`,

      shop: `Hi {name}, I noticed your shop in {city}. I'm from ${company || 'a retail solutions company'}. We help stores ${product || 'attract more customers'} with ${offer || 'our point-of-sale system'}. Interested in learning more?`,

      default: `Hi {name}, I found your ${nicheLower} business in {city}. I'm with ${company || 'our company'}. We help businesses like yours ${product || 'grow and succeed'} with ${offer || 'our proven solutions'}. Would you be open to a quick chat?`
    };

    // Find matching template
    for (const key of Object.keys(templates)) {
      if (nicheLower.includes(key)) {
        return templates[key];
      }
    }

    return templates.default;
  };

  // Auto-generate message when campaign is filled
  useEffect(() => {
    const shouldAutoGenerate =
      campaign.targetAudience &&
      campaign.companyName &&
      campaign.productService &&
      campaign.city &&
      !aiAutoTriggered &&
      campaign.messageTemplate === 'Hi {name}, I found your {niche} in {city}. I help businesses like yours get more customers. Are you interested?';

    if (shouldAutoGenerate) {
      setAiAutoTriggered(true);
      // Small delay to let user see the filled form
      setTimeout(() => {
        generateAIMessage(true);
      }, 1000);
    }
  }, [campaign.targetAudience, campaign.companyName, campaign.productService, campaign.city]);

  // ==================== AI AUTO REPLY BOT (Phase 5) ====================

  // Generate AI reply to customer message
  const generateAIReply = useCallback(async (customerMessage, quickReplyType = null) => {
    // Check generation limit (max 5 per session)
    if (replyGenCount >= 5) {
      setStatus({ type: 'error', message: 'Reply generation limit reached (max 5 per session)' });
      setTimeout(() => setStatus(null), 3000);
      return null;
    }

    // Check if we have campaign data
    if (!campaign.companyName) {
      setStatus({ type: 'error', message: 'Please fill Campaign Settings first (Company Name required)' });
      setTimeout(() => setStatus(null), 3000);
      return null;
    }

    setReplyGenerating(true);
    setStatus({ type: 'loading', message: '🤖 Generating reply...' });

    try {
      // Enhance message with context if quick reply type provided
      let enhancedMessage = customerMessage;
      if (quickReplyType) {
        const quickReplies = {
          'interested': `${customerMessage} (Customer seems interested in our offer)`,
          'not_interested': `${customerMessage} (Customer is not interested, try to overcome objection)`,
          'price': `${customerMessage} (Customer is asking about pricing)`,
          'more_info': `${customerMessage} (Customer wants more information)`
        };
        enhancedMessage = quickReplies[quickReplyType] || customerMessage;
      }

      // Build the prompt
      const prompt = `You are a sales assistant for ${campaign.companyName}.

Our product/service: ${campaign.productService || 'helping businesses grow'}
Target audience: ${campaign.targetAudience || 'businesses'}
Location: ${campaign.city || 'local area'}
Offer: ${campaign.offer || 'quality services'}

A customer replied: "${enhancedMessage}"

Respond professionally and try to convert them into a client. Keep reply short (2-4 lines max), friendly, and persuasive. Address their specific question or concern.

Reply:`;

      let generatedReply = null;

      // Try OpenAI API if key available
      const apiKey = process.env.REACT_APP_OPENAI_API_KEY;

      if (apiKey) {
        try {
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: 'gpt-3.5-turbo',
              messages: [
                {
                  role: 'system',
                  content: 'You are a professional sales assistant. Write short, friendly, persuasive replies.'
                },
                {
                  role: 'user',
                  content: prompt
                }
              ],
              max_tokens: 120,
              temperature: 0.8
            })
          });

          if (response.ok) {
            const data = await response.json();
            generatedReply = data.choices?.[0]?.message?.content?.trim();
          }
        } catch (apiError) {
          console.warn('OpenAI API call failed:', apiError.message);
        }
      }

      // Fallback if no API or API failed
      if (!generatedReply) {
        generatedReply = getReplyFallback(customerMessage, quickReplyType, campaign);
        console.log('🔄 Using reply fallback template');
      }

      // Clean up the reply
      generatedReply = generatedReply
        .replace(/^["']|["']$/g, '')
        .trim();

      // Update state
      setAiReply(generatedReply);

      // Increment generation count
      const newCount = replyGenCount + 1;
      setReplyGenCount(newCount);
      sessionStorage.setItem('leadgen_reply_count', newCount.toString());

      setStatus({
        type: 'success',
        message: `✅ Reply generated! (${newCount}/5 used)`
      });
      setTimeout(() => setStatus(null), 3000);

      return generatedReply;

    } catch (error) {
      console.error('Reply generation failed:', error);
      const fallback = getReplyFallback(customerMessage, quickReplyType, campaign);
      setAiReply(fallback);

      setStatus({ type: 'error', message: 'AI failed. Using fallback reply.' });
      setTimeout(() => setStatus(null), 3000);
      return fallback;
    } finally {
      setReplyGenerating(false);
    }
  }, [replyGenCount, campaign]);

  // Fallback replies when AI fails
  const getReplyFallback = (message, quickType, campaignData) => {
    const company = campaignData.companyName || 'our company';
    const product = campaignData.productService || 'our services';
    const offer = campaignData.offer || 'help you';

    // Check for common patterns in customer message
    const msgLower = message.toLowerCase();

    // Price related
    if (quickType === 'price' || msgLower.includes('price') || msgLower.includes('cost') || msgLower.includes('how much')) {
      return `Thanks for asking! Our pricing depends on your specific needs. I'd love to discuss what would work best for you. Can we schedule a quick call?`;
    }

    // Not interested
    if (quickType === 'not_interested' || msgLower.includes('not interested') || msgLower.includes('no thanks')) {
      return `I understand! Quick question - what would make this interesting for you? I'm happy to adjust our offer to fit your needs.`;
    }

    // More info
    if (quickType === 'more_info' || msgLower.includes('more info') || msgLower.includes('tell me more')) {
      return `Happy to share more! ${product} helps businesses like yours ${offer}. What specific aspect would you like to know about?`;
    }

    // Interested
    if (quickType === 'interested' || msgLower.includes('interested') || msgLower.includes('yes') || msgLower.includes('sounds good')) {
      return `That's great! I'd love to show you how ${company} can help. When would be a good time for a quick 10-minute call?`;
    }

    // Generic fallback
    return `Thanks for your message! I'd be happy to help. Can you tell me a bit more about what you're looking for so I can give you the best answer?`;
  };

  // Handle quick reply button click
  const handleQuickReply = (type) => {
    const exampleMessages = {
      'interested': 'Yes, I am interested. Tell me more.',
      'not_interested': 'Sorry, not interested.',
      'price': 'How much does it cost?',
      'more_info': 'Can you give me more details?'
    };

    const example = exampleMessages[type];
    setIncomingMessage(example);
    generateAIReply(example, type);
  };

  // Send reply via WhatsApp (semi-auto)
  const sendReplyViaWhatsApp = (phone) => {
    if (!aiReply || !phone) {
      setStatus({ type: 'error', message: 'No reply generated or no phone number' });
      setTimeout(() => setStatus(null), 2000);
      return;
    }

    const clean = phone.replace(/\D/g, '');
    const waUrl = `https://wa.me/${clean}?text=${encodeURIComponent(aiReply)}`;
    window.open(waUrl, '_blank');

    setStatus({ type: 'success', message: 'WhatsApp opened with reply!' });
    setTimeout(() => setStatus(null), 2000);
  };

  // Copy reply to clipboard
  const copyReply = () => {
    if (!aiReply) return;
    navigator.clipboard.writeText(aiReply);
    setStatus({ type: 'success', message: 'Reply copied to clipboard!' });
    setTimeout(() => setStatus(null), 2000);
  };

  // Toggle auto reply mode
  const toggleAutoReplyMode = () => {
    const newMode = !autoReplyMode;
    setAutoReplyMode(newMode);
    localStorage.setItem('leadgen_auto_reply', newMode.toString());
  };

  // Auto-generate reply when typing stops (if auto mode on)
  useEffect(() => {
    if (!autoReplyMode || !incomingMessage.trim() || replyGenerating) return;

    const timer = setTimeout(() => {
      if (incomingMessage.trim().length > 10) {
        generateAIReply(incomingMessage);
      }
    }, 1500); // 1.5s delay after typing stops

    return () => clearTimeout(timer);
  }, [incomingMessage, autoReplyMode, replyGenerating, generateAIReply]);

  // ==================== BULK ACTIONS ====================

  // Delete selected leads - ONE CLICK ONLY
  const handleBulkDelete = async () => {
    if (selectedLeads.size === 0) {
      setStatus({ type: 'error', message: 'No leads selected' });
      return;
    }

    if (!window.confirm(`Delete ${selectedLeads.size} selected leads?`)) {
      return;
    }

    const idsToDelete = Array.from(selectedLeads);
    console.log('🗑️ Deleting leads:', idsToDelete.length);

    // IMMEDIATELY update local state - this removes ALL selected leads at once
    setLeads(prev => prev.filter(lead => !idsToDelete.includes(lead.id)));
    setSelectedLeads(new Set());

    // Delete from database in background (don't block UI)
    const savedIds = idsToDelete.filter(id => !String(id).startsWith('scraped_'));
    if (savedIds.length > 0) {
      axios.post(`${API_BASE}/api/leads/bulk-delete`, { ids: savedIds })
        .then(() => console.log(`✅ Deleted ${savedIds.length} from DB`))
        .catch(err => console.error('❌ Delete error:', err.message));
    }

    setStatus({ type: 'success', message: `Deleted ${idsToDelete.length} leads` });
    setTimeout(() => setStatus(null), 2000);
  };

  // Export selected leads
  const handleExportSelected = () => {
    if (selectedLeads.size === 0) {
      setStatus({ type: 'error', message: 'No leads selected for export' });
      return;
    }

    const selectedData = leads.filter(l => selectedLeads.has(l.id));

    const csv = [
      ['Name', 'Phone', 'WhatsApp', 'Email', 'Website', 'Full Address', 'City', 'Area', 'Country', 'Niche', 'Rating', 'Reviews'],
      ...selectedData.map(l => [
        l.name,
        l.phone || 'Not Available',
        l.whatsapp || 'Not Available',
        l.email || 'Not Available',
        l.website || 'Not Available',
        l.address || 'Not Available',
        l.city || '',
        l.area || '',
        l.country || 'Unknown',
        l.niche || 'General',
        l.rating || '',
        l.reviews || ''
      ])
    ];

    const csvContent =
      'data:text/csv;charset=utf-8,' +
      csv.map(e => e.map(field => `"${String(field).replace(/"/g, '""')}"`).join(',')).join('\n');

    const link = document.createElement('a');
    link.href = encodeURI(csvContent);
    link.download = `selected_leads_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();

    setStatus({ type: 'success', message: `Exported ${selectedLeads.size} leads` });
    setTimeout(() => setStatus(null), 2000);
  };

  // Create WhatsApp URL with campaign message
  const createWhatsAppUrl = (phone, lead) => {
    const clean = phone.replace(/\D/g, '');
    const personalizedMessage = applyCampaignToMessage(lead);
    return `https://wa.me/${clean}?text=${encodeURIComponent(personalizedMessage)}`;
  };

  // Generate AI message for a lead using campaign data
  const generateMessage = (lead) => {
    const name = lead.name || 'there';
    const niche = lead.niche || campaign.targetAudience || 'business';
    const city = lead.city || campaign.city || 'your area';
    const company = campaign.companyName || 'our company';
    const product = campaign.productService || 'our services';
    const offer = campaign.offer || 'help you grow';

    const templates = [
      `Hi ${name}, I came across your ${niche} business in ${city}. I'm with ${company}. We help businesses like yours ${product} with ${offer}. Would you be open to a quick chat?`,
      `Hello ${name}, I noticed your ${niche.toLowerCase()} business in ${city}. ${company} specializes in helping ${niche.toLowerCase()} businesses ${product}. Currently offering ${offer}. Interested in learning more?`,
      `Hi ${name}, I found your ${niche} business in ${city} and thought I'd reach out. ${company} helps local businesses ${product} through ${offer}. Would you be interested in a brief call?`
    ];

    // Pick a random template or use the first one
    const template = templates[0];
    return template;
  };

  // Send email via backend with campaign message
  const handleSendEmail = async () => {
    console.log('📧 handleSendEmail called');

    if (selectedLeads.size === 0) {
      console.log('❌ No leads selected');
      setStatus({ type: 'error', message: 'No leads selected' });
      return;
    }

    const selectedData = leads.filter(l => selectedLeads.has(l.id));
    console.log(`📊 Selected ${selectedData.length} leads`);

    const leadsWithEmail = selectedData.filter(l => l.email && l.email !== 'N/A' && l.email !== 'Not Available' && l.email !== 'Not found');
    console.log(`📧 Leads with email: ${leadsWithEmail.length}`, leadsWithEmail.map(l => ({ id: l.id, email: l.email, name: l.name })));

    if (leadsWithEmail.length === 0) {
      console.log('❌ No selected leads have valid email addresses');
      setStatus({ type: 'error', message: 'No selected leads have valid email addresses' });
      return;
    }

    setSendingEmail(true);
    setStatus({ type: 'loading', message: `Sending emails to ${leadsWithEmail.length} lead(s)...` });
    console.log(`🚀 Starting email send to ${leadsWithEmail.length} leads (max 5)`);

    let successCount = 0;
    let failCount = 0;
    let notConfiguredCount = 0;

    for (const lead of leadsWithEmail.slice(0, 5)) { // Max 5 at a time
      try {
        // Generate personalized message using campaign template
        const personalizedMessage = applyCampaignToMessage(lead);
        const subject = `Quick question about ${lead.name || 'your business'}`;

        console.log(`📨 Sending to ${lead.email} (${lead.name})...`);
        console.log(`   Subject: ${subject}`);
        console.log(`   API endpoint: ${API_BASE}/api/send-email`);

        const response = await axios.post(`${API_BASE}/api/send-email`, {
          lead: {
            email: lead.email,
            name: lead.name,
            city: lead.city,
            niche: lead.niche
          },
          message: personalizedMessage,
          subject: subject,
          campaign: {
            companyName: campaign.companyName,
            productService: campaign.productService,
            offer: campaign.offer
          }
        });

        console.log(`📥 Response for ${lead.email}:`, response.data);

        if (response.data.success) {
          successCount++;
          console.log(`✅ Email sent successfully to ${lead.email}`);
        } else if (response.data.error === 'Email not configured' || response.status === 503) {
          notConfiguredCount++;
          failCount++;
          console.error(`⚠️ Email not configured (backend)`);
        } else {
          failCount++;
          console.error(`❌ Failed to send to ${lead.email}:`, response.data.error || response.data.message);
        }
      } catch (err) {
        failCount++;
        console.error(`❌ Exception sending to ${lead.email}:`, err.message);
        console.error(`   Error details:`, err.response?.data || err);

        // Check if it's a "not configured" error
        if (err.response?.status === 503 || err.response?.data?.error === 'Email not configured') {
          notConfiguredCount++;
          console.error(`⚠️ Email service not configured on backend`);
        }
      }
    }

    setSendingEmail(false);

    // Determine final message
    let finalMessage = '';
    let statusType = 'success';

    if (notConfiguredCount > 0) {
      finalMessage = 'Email not configured. Please set EMAIL_USER and EMAIL_PASS in backend .env file';
      statusType = 'error';
    } else if (successCount === 0 && failCount > 0) {
      finalMessage = `Failed to send all ${failCount} emails. Check console for details.`;
      statusType = 'error';
    } else if (successCount > 0 && failCount > 0) {
      finalMessage = `Sent ${successCount} emails, ${failCount} failed`;
      statusType = 'success';
    } else {
      finalMessage = `Successfully sent ${successCount} email(s)!`;
      statusType = 'success';
    }

    console.log(`📧 Email send complete: ${finalMessage}`);
    setStatus({ type: statusType, message: finalMessage });
    setTimeout(() => setStatus(null), 6000);
  };

  // ==================== WHATSAPP META CLOUD API (Production) ====================

  // Check WhatsApp API configuration on mount
  useEffect(() => {
    const checkWhatsAppStatus = async () => {
      try {
        const response = await axios.get(`${API_BASE}/api/whatsapp/status`);
        setWhatsAppApiConfigured(response.data.configured);
        console.log('📱 WhatsApp Meta API status:', response.data.configured ? 'Configured' : 'Not configured');
      } catch (err) {
        console.log('⚠️ WhatsApp status check failed:', err.message);
        setWhatsAppApiConfigured(false);
      }
    };
    checkWhatsAppStatus();
  }, []);

  // Toggle test mode
  const toggleWhatsAppTestMode = () => {
    const newMode = !whatsAppTestMode;
    setWhatsAppTestMode(newMode);
    localStorage.setItem('leadgen_whatsapp_test_mode', newMode.toString());
    setStatus({
      type: 'info',
      message: newMode ? '🧪 Test Mode ON: Messages logged but not sent' : '🔴 Live Mode ON: Messages will be sent for real'
    });
    setTimeout(() => setStatus(null), 3000);
  };

  // Toggle template mode
  const toggleTemplateMode = () => {
    const newMode = !useTemplateMode;
    setUseTemplateMode(newMode);
    localStorage.setItem('leadgen_whatsapp_template_mode', newMode.toString());
    setStatus({
      type: 'info',
      message: newMode ? '📋 Template Mode ON: Using approved WhatsApp templates' : '💬 Text Mode ON: Using free-form messages (24h session only)'
    });
    setTimeout(() => setStatus(null), 3000);
  };

  // Save WhatsApp credentials to backend
  const saveWhatsAppCredentials = async () => {
    if (!whatsAppToken || !whatsAppPhoneId) {
      setStatus({ type: 'error', message: 'Token and Phone Number ID are required' });
      return;
    }

    setSavingCredentials(true);
    try {
      await axios.post(`${API_BASE}/api/whatsapp/credentials`, {
        token: whatsAppToken,
        phoneNumberId: whatsAppPhoneId,
        wabaId: whatsAppWabaId || null
      });

      // Save to localStorage for persistence
      localStorage.setItem('leadgen_whatsapp_token', whatsAppToken);
      localStorage.setItem('leadgen_whatsapp_phone_id', whatsAppPhoneId);
      if (whatsAppWabaId) localStorage.setItem('leadgen_whatsapp_waba_id', whatsAppWabaId);

      setWhatsAppApiConfigured(true);
      setStatus({ type: 'success', message: '✅ WhatsApp credentials saved and validated!' });
      setTimeout(() => setStatus(null), 3000);
    } catch (error) {
      console.error('❌ Save credentials failed:', error.response?.data || error.message);
      setStatus({
        type: 'error',
        message: error.response?.data?.message || 'Failed to save credentials'
      });
    } finally {
      setSavingCredentials(false);
    }
  };

  // Bulk WhatsApp messaging via Meta Cloud API
  const handleBulkWhatsApp = async () => {
    console.log('📱 handleBulkWhatsApp called');

    if (selectedLeads.size === 0) {
      setStatus({ type: 'error', message: 'No leads selected' });
      return;
    }

    const selectedData = leads.filter(l => selectedLeads.has(l.id));
    const leadsWithPhone = selectedData.filter(l => l.phone && l.phone !== 'N/A' && l.phone !== 'Not Available');

    if (leadsWithPhone.length === 0) {
      setStatus({ type: 'error', message: 'No selected leads have phone numbers' });
      return;
    }

    // Safety limit: max 50 messages per batch
    const MAX_BATCH_SIZE = 50;
    if (leadsWithPhone.length > MAX_BATCH_SIZE) {
      setStatus({
        type: 'error',
        message: `Too many leads selected (${leadsWithPhone.length}). Maximum is ${MAX_BATCH_SIZE} per batch.`
      });
      return;
    }

    // Check if API is configured (warn but allow test mode)
    if (!whatsAppApiConfigured && !whatsAppTestMode) {
      setShowWhatsAppConfig(true);
      setStatus({
        type: 'error',
        message: 'WhatsApp API not configured. Please add your Meta API credentials.'
      });
      return;
    }

    setSendingWhatsApp(true);
    setWhatsAppFailedLeads([]);

    // Initialize status map
    const statusMap = new Map();
    leadsWithPhone.forEach(lead => statusMap.set(lead.id, 'pending'));
    setSendStatusMap(statusMap);

    setSendProgress({
      current: 0,
      total: leadsWithPhone.length,
      status: 'sending'
    });

    setStatus({
      type: 'loading',
      message: `${whatsAppTestMode ? '🧪 TEST MODE: ' : ''}Sending WhatsApp to ${leadsWithPhone.length} lead(s)...`
    });

    try {
      // Prepare leads for bulk API
      const leadsPayload = leadsWithPhone.map(lead => ({
        id: lead.id,
        name: lead.name,
        phone: lead.phone,
        city: lead.city,
        niche: lead.niche
      }));

      // Personalize message template
      const personalizedMessage = messageTemplate
        .replace(/{name}/g, '{name}')
        .replace(/{city}/g, '{city}')
        .replace(/{niche}/g, '{niche}');

      const response = await axios.post(`${API_BASE}/api/whatsapp/send-bulk`, {
        leads: leadsPayload,
        message: personalizedMessage,
        useTemplate: useTemplateMode,
        templateName: useTemplateMode ? templateName : null,
        templateParams: [],
        languageCode: templateLanguage,
        testMode: whatsAppTestMode,
        delayMs: sendDelay
      });

      const { sent, failed, results } = response.data;

      // Update status map from results
      const newStatusMap = new Map();
      results.forEach(r => {
        newStatusMap.set(r.leadId, r.status === 'sent' ? 'sent' : 'failed');
      });
      setSendStatusMap(newStatusMap);

      // Track failed leads for retry
      const failedLeads = leadsWithPhone.filter((lead, idx) =>
        results[idx]?.status === 'failed'
      ).map((lead, idx) => {
        const result = results.find(r => r.leadId === lead.id);
        return { ...lead, error: result?.error || 'Unknown error' };
      });
      setWhatsAppFailedLeads(failedLeads);

      setSendProgress(prev => ({ ...prev, status: 'completed', current: leadsWithPhone.length }));

      let finalMessage = '';
      let statusType = 'success';

      if (whatsAppTestMode) {
        finalMessage = `🧪 TEST: ${sent} would be sent, ${failed} failed`;
      } else if (sent === 0 && failed > 0) {
        finalMessage = `❌ All ${failed} messages failed. Check console for details.`;
        statusType = 'error';
      } else if (sent > 0 && failed > 0) {
        finalMessage = `✅ ${sent} sent, ${failed} failed. Click "Retry Failed" to retry.`;
      } else {
        finalMessage = `✅ Successfully sent ${sent} WhatsApp message(s)!`;
      }

      setStatus({ type: statusType, message: finalMessage });

    } catch (error) {
      console.error('❌ Bulk WhatsApp send failed:', error.response?.data || error.message);
      setStatus({
        type: 'error',
        message: error.response?.data?.message || 'Failed to send WhatsApp messages'
      });

      // Mark all as failed
      const failMap = new Map();
      leadsWithPhone.forEach(lead => failMap.set(lead.id, 'failed'));
      setSendStatusMap(failMap);
      setWhatsAppFailedLeads(leadsWithPhone);
    } finally {
      setSendingWhatsApp(false);
      setTimeout(() => setStatus(null), 6000);
    }
  };

  // Retry failed WhatsApp messages
  const handleRetryFailedWhatsApp = async () => {
    if (whatsAppFailedLeads.length === 0) {
      setStatus({ type: 'error', message: 'No failed messages to retry' });
      return;
    }

    console.log(`🔄 Retrying ${whatsAppFailedLeads.length} failed WhatsApp messages...`);

    setSendingWhatsApp(true);
    const failedLeadsList = [...whatsAppFailedLeads];
    setWhatsAppFailedLeads([]);

    try {
      const leadsPayload = failedLeadsList.map(lead => ({
        id: lead.id,
        name: lead.name,
        phone: lead.phone,
        city: lead.city,
        niche: lead.niche
      }));

      const response = await axios.post(`${API_BASE}/api/whatsapp/send-bulk`, {
        leads: leadsPayload,
        message: messageTemplate,
        useTemplate: useTemplateMode,
        templateName: useTemplateMode ? templateName : null,
        languageCode: templateLanguage,
        testMode: whatsAppTestMode,
        delayMs: sendDelay
      });

      const { sent, failed } = response.data;

      const finalMessage = failed > 0
        ? `✅ ${sent} retried successfully, ${failed} still failed`
        : `✅ All ${sent} messages sent successfully on retry!`;

      setStatus({ type: 'success', message: finalMessage });

      // Update statuses
      const newStatusMap = new Map(sendStatusMap);
      response.data.results.forEach(r => {
        newStatusMap.set(r.leadId, r.status === 'sent' ? 'sent' : 'failed');
      });
      setSendStatusMap(newStatusMap);

    } catch (error) {
      setStatus({ type: 'error', message: 'Retry failed: ' + (error.response?.data?.message || error.message) });
    } finally {
      setSendingWhatsApp(false);
      setTimeout(() => setStatus(null), 4000);
    }
  };

  // ==================== AUTO SENDER SYSTEM (Phase 4) ====================

  // Start auto sending process - opens WhatsApp windows with delay
  const startAutoSend = async () => {
    if (selectedLeads.size === 0) {
      setStatus({ type: 'error', message: 'No leads selected' });
      return;
    }

    const selectedData = leads.filter(l => selectedLeads.has(l.id));
    const leadsWithPhone = selectedData.filter(l => l.phone && l.phone !== 'N/A' && l.phone !== 'Not Available');

    if (leadsWithPhone.length === 0) {
      setStatus({ type: 'error', message: 'No selected leads have phone numbers' });
      return;
    }

    // Initialize queue and progress
    const queue = leadsWithPhone.map((lead, index) => ({ ...lead, queueIndex: index }));
    setSendQueue(queue);
    setSendProgress({ current: 0, total: queue.length, status: 'sending' });

    // Initialize all as pending
    const statusMap = new Map();
    queue.forEach(lead => statusMap.set(lead.id, 'pending'));
    setSendStatusMap(statusMap);

    // Track opened count locally for accurate final message
    let openedCount = 0;
    let failedCount = 0;

    // Process each lead with delay - using forEach with setTimeout for proper phone isolation
    queue.forEach((lead, index) => {
      setTimeout(() => {
        try {
          // Validate phone number
          const cleanPhone = lead.phone.replace(/\D/g, '');
          if (!cleanPhone || cleanPhone.length < 6) {
            throw new Error(`Invalid phone number for ${lead.name}`);
          }

          // Get personalized message for this lead
          const personalizedMessage = applyCampaignToMessage(lead);

          // Create WhatsApp URL with THIS lead's phone number
          const url = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(personalizedMessage)}`;

          // Update progress
          setSendProgress(prev => ({ ...prev, current: index + 1 }));

          // Mark as opening
          setSendStatusMap(prev => new Map(prev).set(lead.id, 'opening'));

          // Try to open window - must be inside user click handler context
          const newWindow = window.open(url, '_blank');

          // Check if window opened successfully
          if (!newWindow || newWindow.closed || typeof newWindow.closed === 'undefined') {
            console.warn(`⚠️ Popup may have been blocked for ${lead.name}`);
          }

          // Mark as opened
          setSendStatusMap(prev => new Map(prev).set(lead.id, 'opened'));
          openedCount++;
          console.log(`✅ WhatsApp opened for ${lead.name} (${index + 1}/${queue.length}) - Phone: ${cleanPhone}`);

        } catch (error) {
          // Mark as failed
          console.error(`❌ Failed to open WhatsApp for ${lead.name}:`, error.message);
          setSendStatusMap(prev => new Map(prev).set(lead.id, 'failed'));
          failedCount++;
        }

        // Check if this is the last one
        if (index === queue.length - 1) {
          setTimeout(() => {
            setSendProgress(prev => ({ ...prev, status: 'completed', current: queue.length }));
            setStatus({
              type: openedCount > 0 ? 'success' : 'error',
              message: `Completed: ${openedCount} WhatsApp windows opened, ${failedCount} failed. Note: You must manually send each message.`
            });
            setTimeout(() => setStatus(null), 8000);
          }, 500);
        }
      }, index * sendDelay);
    });
  };

  // Reset auto send state
  const resetAutoSend = () => {
    setSendQueue([]);
    setSendProgress({ current: 0, total: 0, status: 'idle' });
    setSendStatusMap(new Map());
  };

  // Get status color for lead
  const getSendStatusColor = (leadId) => {
    const status = sendStatusMap.get(leadId);
    if (status === 'sent') return '#22c55e'; // green (sent via API)
    if (status === 'sending') return '#3b82f6'; // blue (currently sending)
    if (status === 'opened') return '#22c55e'; // green (legacy: WhatsApp opened)
    if (status === 'opening') return '#3b82f6'; // blue (legacy: currently opening)
    if (status === 'failed') return '#ef4444'; // red
    if (status === 'pending') return '#f59e0b'; // orange
    return 'transparent';
  };

  // Get status label for lead
  const getSendStatusLabel = (leadId) => {
    const status = sendStatusMap.get(leadId);
    if (status === 'sent') return 'Sent ✅';
    if (status === 'sending') return 'Sending... ⏳';
    if (status === 'opened') return 'WhatsApp Opened';
    if (status === 'opening') return 'Opening...';
    if (status === 'failed') return 'Failed ❌';
    if (status === 'pending') return 'Pending ⏳';
    return '';
  };

  const fetchLeads = async (forceFresh = false) => {
    if (forceFresh) setRefreshing(true);
    try {
      const cacheBuster = forceFresh ? `?_t=${Date.now()}` : '';
      const url = `${API_BASE}/api/leads${cacheBuster}`;
      console.log("📡 Fetching leads from:", url);

      const res = await axios.get(url, {
        headers: forceFresh ? { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } : {}
      });

      console.log("📊 Leads received:", res.data.leads?.length || 0);
      setLeads(res.data.leads || []);

      if (forceFresh) {
        setStatus({ type: 'success', message: `Refreshed! ${res.data.leads?.length || 0} leads loaded` });
        setTimeout(() => setStatus(null), 2000);
      }
    } catch (err) {
      console.error("❌ Failed to fetch leads:", err.message);
      setStatus({ type: 'error', message: 'Failed to fetch leads' });
    } finally {
      if (forceFresh) setRefreshing(false);
    }
  };

  // ✅ SMART LOCATION COMBINE
  const buildLocation = () => {
    return [
      scrapeForm.street,
      scrapeForm.area,
      scrapeForm.city,
      scrapeForm.country
    ].filter(Boolean).join(', ');
  };

  const handleScrape = async (e) => {
    e.preventDefault();

    const keyword = scrapeForm.query;
    const country = scrapeForm.country;
    const city = scrapeForm.city;

    if (!keyword || !country || !city) {
      alert("Please fill all required fields");
      return;
    }

    setScraping(true);
    setStatus({ type: 'info', message: '🔍 Scraping in progress... This may take a minute while we search and extract emails.' });

    try {
      // Use full location including area/street for accurate filtering
      const location = buildLocation();

      console.log("FINAL REQUEST:", {
        keyword,
        location,
        hasArea: !!(scrapeForm.area || scrapeForm.street)
      });

      const res = await fetch("http://localhost:5001/api/scrape", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          keyword: keyword,
          location: location
        })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        setScraping(false);
        setStatus({ type: 'error', message: errorData.error || `API error: ${res.status}` });
        return;
      }

      const data = await res.json();
      console.log("📥 Scraped leads:", data.length);

      // Immediately display scraped leads
      setLeads(data);
      console.log("✅ Leads displayed:", data.length);

      // Then fetch all leads from database (including auto-saved ones and previous leads)
      setTimeout(async () => {
        await fetchLeads(true);
      }, 1000);

      setScraping(false);
      setStatus({ type: 'success', message: `✅ Scraped ${data.length} leads! Auto-saved to database.` });
      setTimeout(() => setStatus(null), 5000);

    } catch (err) {
      console.error(err);
      setScraping(false);
      setStatus({ type: 'error', message: err.message || 'Scraping failed' });
    }
  };

  const handleDelete = async (id, isScraped = false) => {
    console.log('Deleting lead:', id, 'isScraped:', isScraped);
    
    if (isScraped || String(id).startsWith('scraped_')) {
      // Just remove from local state (scraped leads not in DB yet)
      console.log('Removing scraped lead from state:', id);
      setLeads(prev => prev.filter(lead => lead.id !== id));
    } else {
      // Call API to delete from database
      console.log('Deleting saved lead from DB:', id);
      await axios.delete(`${API_BASE}/api/leads/${id}`);
      fetchLeads();
    }
  };
const handleExport = () => {
  const csv = [
    ['Name', 'Phone', 'WhatsApp', 'Email', 'Website', 'Full Address', 'City', 'Area', 'Country', 'Niche', 'Rating', 'Reviews'],
    ...leads.map(l => [
      l.name,
      l.phone || 'Not Available',
      l.whatsapp || 'Not Available',
      l.email || 'Not Available',
      l.website || 'Not Available',
      l.address || 'Not Available',
      l.city || '',
      l.area || '',
      l.country || 'Unknown',
      l.niche || 'General',
      l.rating || '',
      l.reviews || ''
    ])
  ];

  const csvContent =
    'data:text/csv;charset=utf-8,' +
    csv.map(e => e.map(field => `"${String(field).replace(/"/g, '""')}"`).join(',')).join('\n');

  const link = document.createElement('a');
  link.href = encodeURI(csvContent);
  link.download = `leads_${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
};
  // Fetch leads on page load
  useEffect(() => {
    console.log("🚀 Page loaded, fetching leads...");
    fetchLeads();
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showColumnDropdown && !e.target.closest('.column-control')) {
        setShowColumnDropdown(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showColumnDropdown]);

  return (
    <div className="app">
      {/* Grid Overlay */}
      <div className="grid-overlay" />

      {/* HERO */}
      <div className="hero">
        <h1>AI Lead Generator</h1>
        <p>Scrape & manage business leads from Google Maps</p>
      </div>

      <div className="container">

      {/* STATS */}
      <div className="stats">
        <div className="stat-card">
          <h3>Total Leads</h3>
          <p>{leads.length}</p>
        </div>
        <div className="stat-card">
          <h3>Countries</h3>
          <p>{countries.length}</p>
        </div>
        <div className="stat-card">
          <h3>Niches</h3>
          <p>{niches.length}</p>
        </div>
      </div>

      {/* STATUS */}
      {status && (
        <div className={`status ${status.type}`}>
          {status.message}
        </div>
      )}

      {/* CAMPAIGN SETTINGS PANEL */}
      <div className="card" style={{ border: '2px solid rgba(99, 102, 241, 0.5)' }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '20px',
          cursor: 'pointer'
        }} onClick={() => setShowCampaignPanel(!showCampaignPanel)}>
          <h2 style={{
            color: 'white',
            fontSize: '22px',
            fontWeight: '600',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            margin: 0
          }}>
            <span>📋</span> Campaign Settings
            {campaign.name && (
              <span style={{
                fontSize: '14px',
                fontWeight: '400',
                color: 'rgba(255,255,255,0.7)',
                marginLeft: '10px'
              }}>
                ({campaign.name})
              </span>
            )}
          </h2>
          <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '20px' }}>
            {showCampaignPanel ? '▲' : '▼'}
          </span>
        </div>

        {showCampaignPanel && (
          <div className="form-grid">
            {/* Campaign Name */}
            <div className="form-field">
              <label>Campaign Name *</label>
              <input
                type="text"
                placeholder="e.g. Dental Outreach Q2"
                value={campaign.name}
                onChange={(e) => setCampaign({ ...campaign, name: e.target.value })}
              />
            </div>

            {/* Company Name */}
            <div className="form-field">
              <label>Your Company Name</label>
              <input
                type="text"
                placeholder="e.g. Smile Dental Supplies"
                value={campaign.companyName}
                onChange={(e) => setCampaign({ ...campaign, companyName: e.target.value })}
              />
            </div>

            {/* Product/Service */}
            <div className="form-field">
              <label>Product / Service</label>
              <input
                type="text"
                placeholder="e.g. Dental Equipment, Marketing Services"
                value={campaign.productService}
                onChange={(e) => setCampaign({ ...campaign, productService: e.target.value })}
              />
            </div>

            {/* Target Audience */}
            <div className="form-field">
              <label>Target Audience</label>
              <input
                type="text"
                placeholder="e.g. Dental Clinics, Gyms, Restaurants"
                value={campaign.targetAudience}
                onChange={(e) => setCampaign({ ...campaign, targetAudience: e.target.value })}
              />
            </div>

            {/* Country */}
            <div className="form-field">
              <label>Target Country</label>
              <input
                type="text"
                placeholder="e.g. Malaysia"
                value={campaign.country}
                onChange={(e) => setCampaign({ ...campaign, country: e.target.value })}
              />
            </div>

            {/* City */}
            <div className="form-field">
              <label>Target City / Area</label>
              <input
                type="text"
                placeholder="e.g. Kuala Lumpur"
                value={campaign.city}
                onChange={(e) => setCampaign({ ...campaign, city: e.target.value })}
              />
            </div>

            {/* Offer / Pitch */}
            <div className="form-field form-field-full">
              <label>Offer / Pitch (Short)</label>
              <input
                type="text"
                placeholder="e.g. 20% off first order, Free consultation"
                value={campaign.offer}
                onChange={(e) => setCampaign({ ...campaign, offer: e.target.value })}
              />
            </div>

            {/* Message Template */}
            <div className="form-field form-field-full">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <label>Message Template (with variables)</label>
                {/* AI Generate Button */}
                <button
                  type="button"
                  onClick={() => generateAIMessage(false)}
                  disabled={aiGenerating || aiGenCount >= 3 || !campaign.targetAudience || !campaign.companyName}
                  className="btn btn-auto"
                  style={{
                    padding: '6px 12px',
                    fontSize: '12px',
                    opacity: (aiGenerating || aiGenCount >= 3 || !campaign.targetAudience || !campaign.companyName) ? 0.5 : 1,
                    cursor: (aiGenerating || aiGenCount >= 3 || !campaign.targetAudience || !campaign.companyName) ? 'not-allowed' : 'pointer'
                  }}
                >
                  {aiGenerating ? '⏳ Generating...' : `🤖 Generate AI Message ${aiGenCount > 0 ? `(${aiGenCount}/3)` : ''}`}
                </button>
              </div>
              <textarea
                rows="4"
                placeholder="Hi {name}, I found your {niche} in {city}. I can help you with {offer}. Interested?"
                value={campaign.messageTemplate}
                onChange={(e) => setCampaign({ ...campaign, messageTemplate: e.target.value })}
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: '8px',
                  border: '1px solid rgba(99, 102, 241, 0.3)',
                  background: 'rgba(15, 23, 42, 0.8)',
                  color: '#e2e8f0',
                  fontSize: '14px',
                  resize: 'vertical'
                }}
              />
              <p style={{
                fontSize: '12px',
                color: 'rgba(255,255,255,0.5)',
                marginTop: '8px'
              }}>
                Variables: {'{name}'} = Business, {'{city}'} = Location, {'{niche}'} = Type,
                {'{company}'} = Your company, {'{product}'} = Product, {'{offer}'} = Your offer
                {aiGenCount >= 3 && <span style={{ color: '#ef4444', marginLeft: '10px' }}>⚠️ AI limit reached (3/3)</span>}
              </p>
            </div>

            {/* Save Button */}
            <div className="form-field form-field-full" style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <button
                type="button"
                onClick={saveCampaign}
                className="btn btn-scrape"
                style={{ padding: '12px 24px', fontSize: '14px' }}
              >
                {campaignSaved ? '✅ Saved!' : '💾 Save Campaign'}
              </button>
              <button
                type="button"
                onClick={loadCampaign}
                className="btn btn-secondary"
                style={{ padding: '12px 24px', fontSize: '14px' }}
              >
                📂 Load Last Campaign
              </button>
              <button
                type="button"
                onClick={() => {
                  setCampaign({
                    name: '',
                    companyName: '',
                    productService: '',
                    targetAudience: '',
                    country: '',
                    city: '',
                    offer: '',
                    messageTemplate: 'Hi {name}, I found your {niche} in {city}. I can help you get more customers. Are you interested?'
                  });
                }}
                className="btn btn-secondary"
                style={{ padding: '12px 24px', fontSize: '14px' }}
              >
                🔄 Clear
              </button>
            </div>
          </div>
        )}
      </div>

      {/* AI REPLY ASSISTANT PANEL (Phase 5) */}
      <div className="card" style={{ border: '2px solid rgba(16, 185, 129, 0.5)', marginBottom: '20px' }}>
        {/* Toggle Button */}
        <button
          type="button"
          onClick={() => setShowReplyPanel(!showReplyPanel)}
          className="btn btn-auto-active"
          style={{
            width: '100%',
            marginBottom: showReplyPanel ? '20px' : '0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <span>🤖 AI Reply Assistant {replyGenCount > 0 && `(${replyGenCount}/5)`}</span>
          <span>{showReplyPanel ? '▼' : '▶'}</span>
        </button>

        {showReplyPanel && (
          <div>
            {/* Header with Auto Mode Toggle */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '20px',
              padding: '15px',
              background: 'rgba(15, 23, 42, 0.8)',
              borderRadius: '8px'
            }}>
              <div>
                <h4 style={{ margin: '0 0 5px 0', color: '#e2e8f0' }}>AI Reply Bot</h4>
                <p style={{ margin: 0, fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
                  Paste customer message and get AI-generated replies
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
                  Auto Mode
                </span>
                <button
                  onClick={toggleAutoReplyMode}
                  style={{
                    width: '44px',
                    height: '24px',
                    borderRadius: '12px',
                    border: 'none',
                    background: autoReplyMode ? 'linear-gradient(135deg, #10b981 0%, #34d399 100%)' : 'rgba(99, 102, 241, 0.3)',
                    position: 'relative',
                    cursor: 'pointer',
                    transition: 'all 0.3s ease'
                  }}
                >
                  <span style={{
                    position: 'absolute',
                    top: '2px',
                    left: autoReplyMode ? '22px' : '2px',
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    background: 'white',
                    transition: 'all 0.3s ease'
                  }} />
                </button>
              </div>
            </div>

            {/* Quick Reply Buttons */}
            <div style={{ marginBottom: '20px' }}>
              <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginBottom: '10px' }}>
                Quick Replies:
              </p>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => handleQuickReply('interested')}
                  disabled={replyGenCount >= 5}
                  className="btn btn-secondary"
                  style={{ fontSize: '12px', padding: '8px 14px' }}
                >
                  ✅ Interested
                </button>
                <button
                  onClick={() => handleQuickReply('not_interested')}
                  disabled={replyGenCount >= 5}
                  className="btn btn-secondary"
                  style={{ fontSize: '12px', padding: '8px 14px' }}
                >
                  ❌ Not Interested
                </button>
                <button
                  onClick={() => handleQuickReply('price')}
                  disabled={replyGenCount >= 5}
                  className="btn btn-secondary"
                  style={{ fontSize: '12px', padding: '8px 14px' }}
                >
                  💰 Price?
                </button>
                <button
                  onClick={() => handleQuickReply('more_info')}
                  disabled={replyGenCount >= 5}
                  className="btn btn-secondary"
                  style={{ fontSize: '12px', padding: '8px 14px' }}
                >
                  📋 More Info
                </button>
              </div>
            </div>

            {/* Input: Customer Message */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginBottom: '8px', display: 'block' }}>
                Customer Message:
              </label>
              <textarea
                rows="3"
                placeholder="Paste the customer's reply here..."
                value={incomingMessage}
                onChange={(e) => setIncomingMessage(e.target.value)}
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: '8px',
                  border: '1px solid rgba(99, 102, 241, 0.3)',
                  background: 'rgba(15, 23, 42, 0.8)',
                  color: '#e2e8f0',
                  fontSize: '14px',
                  resize: 'vertical'
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' }}>
                <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', margin: 0 }}>
                  {autoReplyMode && 'Auto-generate on: type and pause to generate'}
                </p>
                <button
                  onClick={() => generateAIReply(incomingMessage)}
                  disabled={!incomingMessage.trim() || replyGenerating || replyGenCount >= 5}
                  className="btn btn-scrape"
                  style={{ fontSize: '13px', padding: '8px 20px' }}
                >
                  {replyGenerating ? '⏳ Generating...' : '🤖 Generate Reply'}
                </button>
              </div>
              {replyGenCount >= 5 && (
                <p style={{ color: '#ef4444', fontSize: '12px', marginTop: '8px' }}>
                  ⚠️ Reply limit reached (5/5). Refresh to reset.
                </p>
              )}
            </div>

            {/* Output: AI Reply */}
            {aiReply && (
              <div style={{
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: '8px',
                padding: '15px',
                marginBottom: '15px'
              }}>
                <label style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginBottom: '8px', display: 'block' }}>
                  AI Generated Reply:
                </label>
                <div style={{
                  background: 'rgba(15, 23, 42, 0.8)',
                  padding: '12px',
                  borderRadius: '6px',
                  fontSize: '14px',
                  color: '#e2e8f0',
                  lineHeight: '1.5',
                  marginBottom: '12px',
                  whiteSpace: 'pre-wrap'
                }}>
                  {aiReply}
                </div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <button
                    onClick={copyReply}
                    className="btn btn-secondary"
                    style={{ fontSize: '12px', padding: '8px 16px' }}
                  >
                    📋 Copy Reply
                  </button>
                  {selectedLeads.size === 1 && (
                    <button
                      onClick={() => {
                        const leadId = Array.from(selectedLeads)[0];
                        const lead = leads.find(l => l.id === leadId);
                        if (lead?.phone) {
                          sendReplyViaWhatsApp(lead.phone);
                        } else {
                          setStatus({ type: 'error', message: 'Selected lead has no phone number' });
                          setTimeout(() => setStatus(null), 2000);
                        }
                      }}
                      className="btn btn-scrape"
                      style={{ fontSize: '12px', padding: '8px 16px' }}
                    >
                      💬 Send via WhatsApp
                    </button>
                  )}
                  <button
                    onClick={() => setAiReply('')}
                    className="btn btn-secondary"
                    style={{ fontSize: '12px', padding: '8px 16px' }}
                  >
                    🗑 Clear
                  </button>
                </div>
                {selectedLeads.size === 1 && (
                  <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '8px', marginBottom: 0 }}>
                    💡 Select exactly 1 lead to enable "Send via WhatsApp"
                  </p>
                )}
              </div>
            )}

            {/* Instructions */}
            <div style={{
              background: 'rgba(99, 102, 241, 0.1)',
              borderRadius: '6px',
              padding: '12px',
              fontSize: '12px',
              color: 'rgba(255,255,255,0.6)'
            }}>
              <strong style={{ color: 'rgba(255,255,255,0.9)' }}>How to use:</strong>
              <ol style={{ margin: '8px 0 0 0', paddingLeft: '18px' }}>
                <li>Fill Campaign Settings first (Company Name, Product, Offer)</li>
                <li>Paste customer message or click Quick Reply buttons</li>
                <li>Click "Generate Reply" or enable Auto Mode</li>
                <li>Copy reply or send via WhatsApp</li>
              </ol>
            </div>
          </div>
        )}
      </div>

      {/* FORM */}
      <div className="card">
        <h2 style={{ 
          marginBottom: '28px', 
          color: 'white', 
          fontSize: '22px', 
          fontWeight: '600',
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          <span>🔍</span> Search Leads
        </h2>
        <form onSubmit={handleScrape} className="form-grid">

          {/* Keyword - Full Width */}
          <div className="form-field form-field-full">
            <label>Business Type / Keyword *</label>
            <input
              type="text"
              placeholder="e.g. restaurant, dentist, gym"
              value={scrapeForm.query}
              onChange={(e) => setScrapeForm({ ...scrapeForm, query: e.target.value })}
              required
            />
          </div>

          {/* Location Fields - Grid */}
          <div className="form-field">
            <label>Country</label>
            <input
              type="text"
              placeholder="e.g. Malaysia"
              value={scrapeForm.country}
              onChange={(e) => setScrapeForm({ ...scrapeForm, country: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label>City</label>
            <input
              type="text"
              placeholder="e.g. Kuala Lumpur"
              value={scrapeForm.city}
              onChange={(e) => setScrapeForm({ ...scrapeForm, city: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label>Area / Town</label>
            <input
              type="text"
              placeholder="e.g. Petaling Jaya"
              value={scrapeForm.area}
              onChange={(e) => setScrapeForm({ ...scrapeForm, area: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label>Street / Address</label>
            <input
              type="text"
              placeholder="e.g. Jalan SS21/37"
              value={scrapeForm.street}
              onChange={(e) => setScrapeForm({ ...scrapeForm, street: e.target.value })}
            />
          </div>

          {/* Preview Combined Location */}
          <div className="form-field form-field-full location-preview">
            <label>Combined Location</label>
            <div className="preview-box">
              {buildLocation() || 'Enter location details above...'}
            </div>
          </div>

          {/* Submit Button */}
          <div className="form-field form-field-full">
            <button 
              type="submit" 
              className="btn btn-scrape" 
              style={{ width: '100%' }}
              disabled={scraping}
            >
              {scraping ? (
                <>
                  <span className="spinner" />
                  Scraping...
                </>
              ) : (
                <>
                  <span className="btn-icon">🔍</span>
                  Scrape Leads
                </>
              )}
            </button>
          </div>

        </form>
      </div>
      {/* TABLE */}
      <div className="card">
        {/* Header with title and controls */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          marginBottom: '20px',
          flexWrap: 'wrap',
          gap: '16px'
        }}>
          <h2 style={{ 
            color: 'white', 
            fontSize: '22px', 
            fontWeight: '600',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            margin: 0
          }}>
            <span>📋</span> Leads ({leads.length})
          </h2>
          <div className="btn-group">
            <button 
              onClick={() => fetchLeads(true)} 
              disabled={refreshing}
              className="btn btn-refresh"
            >
              <span className="btn-icon">{refreshing ? '⏳' : '⟳'}</span>
              {refreshing ? 'Loading...' : 'Refresh'}
            </button>
            <button onClick={handleExport} className="btn btn-export">
              <span className="btn-icon">⬇</span>
              Export All
            </button>
          </div>
        </div>

        {/* Bulk Actions Bar */}
        {leads.length > 0 && (
          <div className="bulk-actions-bar">
            <div className="selection-info">
              <strong>{selectedLeads.size}</strong> of <strong>{leads.length}</strong> selected
            </div>
            <button
              onClick={handleBulkDelete}
              className="btn btn-delete"
              disabled={selectedLeads.size === 0}
              style={{ opacity: selectedLeads.size === 0 ? 0.5 : 1 }}
            >
              <span className="btn-icon">🗑</span>
              Delete Selected ({selectedLeads.size})
            </button>
            <button
              onClick={handleExportSelected}
              className="btn btn-export"
              disabled={selectedLeads.size === 0}
              style={{ opacity: selectedLeads.size === 0 ? 0.5 : 1 }}
            >
              <span className="btn-icon">📤</span>
              Export Selected ({selectedLeads.size})
            </button>
            <button
              onClick={handleBulkWhatsApp}
              className="btn btn-whatsapp"
              disabled={selectedLeads.size === 0 || sendingWhatsApp}
              style={{ opacity: (selectedLeads.size === 0 || sendingWhatsApp) ? 0.5 : 1 }}
              title={(() => {
                if (selectedLeads.size === 0) return 'Select leads first';
                const selectedData = leads.filter(l => selectedLeads.has(l.id));
                const leadsWithPhone = selectedData.filter(l => l.phone && l.phone !== 'N/A' && l.phone !== 'Not Available');
                if (leadsWithPhone.length === 0) return 'Selected leads have no phone numbers';
                return `${whatsAppTestMode ? '🧪 TEST MODE: ' : ''}Send WhatsApp to ${leadsWithPhone.length} lead(s) via Business API`;
              })()}
            >
              <span className="btn-icon">{sendingWhatsApp ? '⏳' : (whatsAppTestMode ? '🧪' : '💬')}</span>
              {sendingWhatsApp ? 'Sending WhatsApp...' : `Send WhatsApp (Auto) (${(() => {
                if (selectedLeads.size === 0) return 0;
                const selectedData = leads.filter(l => selectedLeads.has(l.id));
                const leadsWithPhone = selectedData.filter(l => l.phone && l.phone !== 'N/A' && l.phone !== 'Not Available');
                return leadsWithPhone.length;
              })()})`}
            </button>
            <button
              onClick={handleSendEmail}
              className="btn btn-email"
              disabled={selectedLeads.size === 0 || sendingEmail}
              style={{ opacity: (selectedLeads.size === 0 || sendingEmail) ? 0.5 : 1 }}
              title={(() => {
                if (selectedLeads.size === 0) return 'Select leads first';
                const selectedData = leads.filter(l => selectedLeads.has(l.id));
                const leadsWithEmail = selectedData.filter(l => l.email && l.email !== 'N/A' && l.email !== 'Not Available' && l.email !== 'Not found');
                if (leadsWithEmail.length === 0) return 'Selected leads have no valid email addresses';
                return `Send email to ${leadsWithEmail.length} lead(s)`;
              })()}
            >
              <span className="btn-icon">{sendingEmail ? '⏳' : '✉️'}</span>
              {sendingEmail ? 'Sending...' : `Send Email (${(() => {
                if (selectedLeads.size === 0) return 0;
                const selectedData = leads.filter(l => selectedLeads.has(l.id));
                const leadsWithEmail = selectedData.filter(l => l.email && l.email !== 'N/A' && l.email !== 'Not Available' && l.email !== 'Not found');
                return leadsWithEmail.length;
              })()})`}
            </button>

            {/* WhatsApp Test Mode Toggle */}
            {selectedLeads.size > 0 && (
              <button
                onClick={toggleWhatsAppTestMode}
                className={`btn ${whatsAppTestMode ? 'btn-auto-active' : 'btn-auto'}`}
                style={{ marginLeft: '10px' }}
                title={whatsAppTestMode ? '🧪 Test Mode: Messages logged but not sent' : '🔴 Live Mode: Messages will be sent for real'}
              >
                <span className="btn-icon">{whatsAppTestMode ? '🧪' : '🔴'}</span>
                {whatsAppTestMode ? 'Test Mode ON' : 'Live Mode ON'}
              </button>
            )}

            {/* Retry Failed WhatsApp */}
            {whatsAppFailedLeads.length > 0 && (
              <button
                onClick={handleRetryFailedWhatsApp}
                className="btn btn-secondary"
                disabled={sendingWhatsApp}
                style={{ marginLeft: '10px', opacity: sendingWhatsApp ? 0.5 : 1 }}
                title={`Retry ${whatsAppFailedLeads.length} failed message(s)`}
              >
                <span className="btn-icon">🔄</span>
                Retry Failed ({whatsAppFailedLeads.length})
              </button>
            )}

            {/* WhatsApp Config Button */}
            <button
              onClick={() => setShowWhatsAppConfig(!showWhatsAppConfig)}
              className={`btn ${whatsAppApiConfigured ? 'btn-auto-active' : 'btn-secondary'}`}
              style={{ marginLeft: '10px' }}
              title="Configure WhatsApp Meta API credentials"
            >
              <span className="btn-icon">⚙️</span>
              {whatsAppApiConfigured ? 'WhatsApp API ✅' : 'Setup WhatsApp API'}
            </button>

            {/* Template Mode Toggle */}
            {selectedLeads.size > 0 && (
              <button
                onClick={toggleTemplateMode}
                className={`btn ${useTemplateMode ? 'btn-auto-active' : 'btn-auto'}`}
                style={{ marginLeft: '10px' }}
                title={useTemplateMode ? 'Using approved WhatsApp templates' : 'Using free-form text messages'}
              >
                <span className="btn-icon">{useTemplateMode ? '📋' : '💬'}</span>
                {useTemplateMode ? 'Template Mode' : 'Text Mode'}
              </button>
            )}

            {/* Message Editor Toggle */}
            {selectedLeads.size > 0 && (
              <button
                onClick={() => setShowMessageEditor(!showMessageEditor)}
                className="btn btn-secondary"
                style={{ marginLeft: '10px' }}
              >
                <span className="btn-icon">📝</span>
                {showMessageEditor ? 'Hide Message' : 'Edit Message'}
              </button>
            )}

            {/* Column Control Dropdown */}
            <div className="column-control">
              <button 
                className="column-toggle-btn"
                onClick={() => setShowColumnDropdown(!showColumnDropdown)}
              >
                <span>⚙️</span> Columns
              </button>
              {showColumnDropdown && (
                <div className="column-dropdown">
                  <div className="column-option" onClick={() => toggleColumn('name')}>
                    <input 
                      type="checkbox" 
                      checked={visibleColumns.name} 
                      onChange={() => {}}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span>Business Name</span>
                  </div>
                  <div className="column-option" onClick={() => toggleColumn('phone')}>
                    <input
                      type="checkbox"
                      checked={visibleColumns.phone}
                      onChange={() => {}}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span>Phone</span>
                  </div>
                  <div className="column-option" onClick={() => toggleColumn('email')}>
                    <input
                      type="checkbox"
                      checked={visibleColumns.email}
                      onChange={() => {}}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span>Email</span>
                  </div>
                  <div className="column-option" onClick={() => toggleColumn('address')}>
                    <input 
                      type="checkbox" 
                      checked={visibleColumns.address} 
                      onChange={() => {}}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span>Address</span>
                  </div>
                  <div className="column-option" onClick={() => toggleColumn('website')}>
                    <input 
                      type="checkbox" 
                      checked={visibleColumns.website} 
                      onChange={() => {}}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span>Website</span>
                  </div>
                  <div className="column-option" onClick={() => toggleColumn('location')}>
                    <input 
                      type="checkbox" 
                      checked={visibleColumns.location} 
                      onChange={() => {}}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span>Location</span>
                  </div>
                  <div className="column-option" onClick={() => toggleColumn('niche')}>
                    <input 
                      type="checkbox" 
                      checked={visibleColumns.niche} 
                      onChange={() => {}}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span>Niche</span>
                  </div>
                  <div className="column-option" onClick={() => toggleColumn('action')}>
                    <input 
                      type="checkbox" 
                      checked={visibleColumns.action} 
                      onChange={() => {}}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span>Action</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* WhatsApp Meta API Configuration Panel */}
        {showWhatsAppConfig && (
          <div className="whatsapp-config-panel" style={{
            background: 'rgba(15, 23, 42, 0.95)',
            border: '2px solid rgba(37, 211, 102, 0.4)',
            borderRadius: '12px',
            padding: '20px',
            marginBottom: '20px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <h4 style={{ margin: 0, color: '#25d366' }}>📱 WhatsApp Meta API Configuration</h4>
              <button
                onClick={() => setShowWhatsAppConfig(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#94a3b8',
                  fontSize: '20px',
                  cursor: 'pointer'
                }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginBottom: '15px' }}>
              Enter your Meta WhatsApp Cloud API credentials. These are stored securely on the backend and never exposed to the frontend.
            </p>

            <div style={{ display: 'grid', gap: '12px', marginBottom: '15px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: 'rgba(255,255,255,0.8)', marginBottom: '5px' }}>
                  WhatsApp Access Token *
                </label>
                <input
                  type="password"
                  value={whatsAppToken}
                  onChange={(e) => setWhatsAppToken(e.target.value)}
                  placeholder="EAAxxxxxxxx..."
                  style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: '6px',
                    border: '1px solid rgba(99, 102, 241, 0.3)',
                    background: 'rgba(15, 23, 42, 0.8)',
                    color: '#e2e8f0',
                    fontSize: '14px'
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: 'rgba(255,255,255,0.8)', marginBottom: '5px' }}>
                  Phone Number ID *
                </label>
                <input
                  type="text"
                  value={whatsAppPhoneId}
                  onChange={(e) => setWhatsAppPhoneId(e.target.value)}
                  placeholder="1xxxxxxxxxxxxxx"
                  style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: '6px',
                    border: '1px solid rgba(99, 102, 241, 0.3)',
                    background: 'rgba(15, 23, 42, 0.8)',
                    color: '#e2e8f0',
                    fontSize: '14px'
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: 'rgba(255,255,255,0.8)', marginBottom: '5px' }}>
                  Business Account ID (optional - for templates)
                </label>
                <input
                  type="text"
                  value={whatsAppWabaId}
                  onChange={(e) => setWhatsAppWabaId(e.target.value)}
                  placeholder="1xxxxxxxxxxxxxx"
                  style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: '6px',
                    border: '1px solid rgba(99, 102, 241, 0.3)',
                    background: 'rgba(15, 23, 42, 0.8)',
                    color: '#e2e8f0',
                    fontSize: '14px'
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <button
                onClick={saveWhatsAppCredentials}
                disabled={savingCredentials || !whatsAppToken || !whatsAppPhoneId}
                className="btn btn-scrape"
                style={{
                  opacity: (!whatsAppToken || !whatsAppPhoneId) ? 0.5 : 1,
                  fontSize: '14px',
                  padding: '10px 20px'
                }}
              >
                {savingCredentials ? '⏳ Validating...' : '💾 Save & Validate Credentials'}
              </button>
              <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
                {whatsAppApiConfigured ? '✅ Connected' : '❌ Not configured'}
              </span>
            </div>

            <div style={{
              marginTop: '15px',
              padding: '10px',
              background: 'rgba(37, 211, 102, 0.1)',
              borderRadius: '6px',
              fontSize: '12px',
              color: 'rgba(255,255,255,0.6)'
            }}>
              <strong>How to get credentials:</strong><br/>
              1. Go to <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" style={{ color: '#25d366' }}>Meta Developers</a><br/>
              2. Create a WhatsApp app → Add WhatsApp product<br/>
              3. Copy Access Token and Phone Number ID<br/>
              4. For templates, also add your Business Account ID
            </div>
          </div>
        )}

        {/* Message Editor Panel */}
        {showMessageEditor && selectedLeads.size > 0 && (
          <div className="message-editor-panel" style={{
            background: 'rgba(15, 23, 42, 0.9)',
            border: '1px solid rgba(99, 102, 241, 0.3)',
            borderRadius: '12px',
            padding: '20px',
            marginBottom: '20px'
          }}>
            <h4 style={{ marginBottom: '15px', color: '#e2e8f0' }}>✉️ Message Template</h4>
            <textarea
              value={messageTemplate}
              onChange={(e) => {
                setMessageTemplate(e.target.value);
                // Also update campaign message template
                setCampaign(prev => ({ ...prev, messageTemplate: e.target.value }));
              }}
              style={{
                width: '100%',
                minHeight: '100px',
                padding: '12px',
                borderRadius: '8px',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                background: 'rgba(15, 23, 42, 0.8)',
                color: '#e2e8f0',
                fontSize: '14px',
                resize: 'vertical',
                marginBottom: '15px'
              }}
              placeholder="Enter your message template... Use {name}, {niche}, {city}, {company}, {product}, {offer} as placeholders"
            />
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                onClick={() => {
                  const firstSelected = leads.find(l => selectedLeads.has(l.id));
                  if (firstSelected) {
                    const aiMessage = generateMessage(firstSelected);
                    setMessageTemplate(aiMessage);
                    setCampaign(prev => ({ ...prev, messageTemplate: aiMessage }));
                  }
                }}
                className="btn btn-secondary"
                style={{ fontSize: '13px', padding: '8px 16px' }}
              >
                🤖 Generate AI Message
              </button>
              <button
                onClick={() => {
                  setMessageTemplate(campaign.messageTemplate || "Hi {name}, I found your {niche} in {city}. I can help you get more customers. Are you interested?");
                }}
                className="btn btn-secondary"
                style={{ fontSize: '13px', padding: '8px 16px' }}
              >
                🔄 Load Campaign Template
              </button>
              <button
                onClick={() => {
                  localStorage.setItem('leadgen_campaign', JSON.stringify({ ...campaign, messageTemplate }));
                  setStatus({ type: 'success', message: 'Template saved to campaign!' });
                  setTimeout(() => setStatus(null), 2000);
                }}
                className="btn btn-secondary"
                style={{ fontSize: '13px', padding: '8px 16px' }}
              >
                💾 Save to Campaign
              </button>
            </div>
            <p style={{ marginTop: '10px', fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
              Variables: {'{name}'} = Business, {'{niche}'} = Type, {'{city}'} = Location, {'{company}'} = Your company, {'{product}'} = Product, {'{offer}'} = Offer
            </p>
          </div>
        )}

        {/* Auto Send Progress Panel - Legacy wa.me opener */}
        {autoSendMode && selectedLeads.size > 0 && (
          <div className="auto-send-panel" style={{
            background: 'rgba(15, 23, 42, 0.95)',
            border: '2px solid rgba(99, 102, 241, 0.5)',
            borderRadius: '12px',
            padding: '20px',
            marginBottom: '20px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <h4 style={{ color: '#e2e8f0', margin: 0 }}>🤖 Legacy WhatsApp Opener (wa.me)</h4>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                {/* Delay Control */}
                <label style={{ color: 'rgba(255,255,255,0.7)', fontSize: '13px' }}>
                  Delay:
                  <select
                    value={sendDelay}
                    onChange={(e) => setSendDelay(Number(e.target.value))}
                    disabled={sendProgress.status === 'sending'}
                    style={{
                      marginLeft: '8px',
                      padding: '5px 10px',
                      borderRadius: '6px',
                      border: '1px solid rgba(99, 102, 241, 0.3)',
                      background: 'rgba(15, 23, 42, 0.8)',
                      color: '#e2e8f0',
                      fontSize: '13px'
                    }}
                  >
                    <option value={1000}>1 second</option>
                    <option value={1500}>1.5 seconds</option>
                    <option value={2000}>2 seconds</option>
                    <option value={2500}>2.5 seconds</option>
                    <option value={3000}>3 seconds</option>
                  </select>
                </label>
              </div>
            </div>

            {/* Info Note */}
            <p style={{
              fontSize: '12px',
              color: 'rgba(255,255,255,0.6)',
              marginBottom: '15px',
              padding: '10px',
              background: 'rgba(99, 102, 241, 0.1)',
              borderRadius: '6px'
            }}>
              ⚠️ LEGACY MODE: Opens WhatsApp windows for each lead. You must manually click "Send" in each window. Use "Send WhatsApp (Auto)" button for real API automation.
            </p>

            {/* Progress Bar */}
            {sendProgress.status !== 'idle' && (
              <div style={{ marginBottom: '15px' }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '8px',
                  fontSize: '14px',
                  color: '#e2e8f0'
                }}>
                  <span>
                    {sendProgress.status === 'sending' && '⏳ Opening WhatsApp windows...'}
                    {sendProgress.status === 'completed' && '✅ All windows opened'}
                    {sendProgress.status === 'failed' && '❌ Failed'}
                  </span>
                  <span style={{ fontWeight: 'bold' }}>
                    {sendProgress.current} / {sendProgress.total} opened
                  </span>
                </div>
                <div style={{
                  width: '100%',
                  height: '10px',
                  background: 'rgba(99, 102, 241, 0.2)',
                  borderRadius: '5px',
                  overflow: 'hidden'
                }}>
                  <div style={{
                    width: `${sendProgress.total > 0 ? (sendProgress.current / sendProgress.total) * 100 : 0}%`,
                    height: '100%',
                    background: sendProgress.status === 'completed' ? '#22c55e' : '#6366f1',
                    transition: 'width 0.3s ease',
                    borderRadius: '5px'
                  }} />
                </div>
              </div>
            )}

            {/* Control Buttons */}
            <div style={{ display: 'flex', gap: '10px' }}>
              {sendProgress.status === 'idle' && (
                <button
                  onClick={startAutoSend}
                  className="btn btn-scrape"
                  style={{ padding: '10px 20px', fontSize: '14px' }}
                >
                  ▶️ Open WhatsApp for {selectedLeads.size} leads
                </button>
              )}
              {sendProgress.status === 'sending' && (
                <button
                  disabled
                  className="btn btn-secondary"
                  style={{ padding: '10px 20px', fontSize: '14px', opacity: 0.7 }}
                >
                  ⏳ Opening WhatsApp windows...
                </button>
              )}
              {sendProgress.status === 'completed' && (
                <button
                  onClick={resetAutoSend}
                  className="btn btn-secondary"
                  style={{ padding: '10px 20px', fontSize: '14px' }}
                >
                  🔄 Reset & Send Again
                </button>
              )}
            </div>

            {/* Status Legend */}
            <div style={{
              marginTop: '15px',
              paddingTop: '15px',
              borderTop: '1px solid rgba(255,255,255,0.1)',
              display: 'flex',
              gap: '20px',
              fontSize: '12px',
              color: 'rgba(255,255,255,0.6)'
            }}>
              <span><span style={{ color: '#f59e0b' }}>●</span> Pending</span>
              <span><span style={{ color: '#3b82f6' }}>●</span> Sending</span>
              <span><span style={{ color: '#22c55e' }}>●</span> Sent</span>
              <span><span style={{ color: '#ef4444' }}>●</span> Failed</span>
            </div>
          </div>
        )}

        {console.log("Leads count check:", leads.length)}
        {leads.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'rgba(255,255,255,0.5)' }}>
            <p style={{ fontSize: '16px', marginBottom: '8px' }}>No leads found</p>
            <p style={{ fontSize: '14px' }}>Use the search form above to scrape leads from Google Maps</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>
                    <input 
                      type="checkbox" 
                      className="row-checkbox"
                      checked={selectedLeads.size === leads.length && leads.length > 0}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  {visibleColumns.name && <th>Business</th>}
                  {visibleColumns.phone && <th>Phone</th>}
                  {visibleColumns.email && <th>Email</th>}
                  {visibleColumns.address && <th>Address</th>}
                  {visibleColumns.website && <th>Website</th>}
                  {visibleColumns.location && <th>Location</th>}
                  {visibleColumns.niche && <th>Niche</th>}
                  {visibleColumns.action && <th style={{ textAlign: 'center' }}>Action</th>}
                </tr>
              </thead>
              <tbody>
                {console.log("Rendering leads:", leads)}
                {leads.map((lead, index) => {
                  const isSelected = selectedLeads.has(lead.id);
                  const cleanWebsite = getCleanWebsite(lead.website);
                  const sendStatus = sendStatusMap.get(lead.id);

                  return (
                    <tr
                      key={lead.id || `lead-${index}`}
                      className={isSelected ? 'selected' : ''}
                      style={{
                        borderLeft: sendStatus ? `4px solid ${
                          sendStatus === 'sent' ? '#22c55e' :
                          sendStatus === 'failed' ? '#ef4444' :
                          '#f59e0b'
                        }` : undefined
                      }}
                    >
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {/* Send Status Indicator */}
                          {autoSendMode && sendStatus && (
                            <span
                              style={{
                                width: '8px',
                                height: '8px',
                                borderRadius: '50%',
                                backgroundColor: getSendStatusColor(lead.id),
                                display: 'inline-block'
                              }}
                              title={getSendStatusLabel(lead.id)}
                            />
                          )}
                          <input
                            type="checkbox"
                            className="row-checkbox"
                            checked={isSelected}
                            onChange={() => toggleLeadSelection(lead.id)}
                          />
                        </div>
                      </td>
                      {visibleColumns.name && (
                        <td>
                          <div style={{ fontWeight: 600, color: '#f1f5f9', marginBottom: '4px' }}>
                            {lead.name}
                          </div>
                          {lead.rating && (
                            <div style={{ fontSize: '12px', color: '#fbbf24' }}>
                              ⭐ {lead.rating} {lead.reviews && `(${lead.reviews} reviews)`}
                            </div>
                          )}
                        </td>
                      )}
                      {visibleColumns.phone && (
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {lead.phone && lead.phone !== 'Not Available' ? (
                              <>
                                <a href={`tel:${lead.phone.replace(/\s+/g, '')}`} className="link-phone">
                                  📞 {lead.phone}
                                </a>
                                {getWhatsAppLink(lead.phone) && (
                                  <a
                                    href={getWhatsAppLink(lead.phone)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="link-whatsapp"
                                    style={{ fontSize: '12px' }}
                                  >
                                    💬 WhatsApp
                                  </a>
                                )}
                              </>
                            ) : (
                              <span style={{ color: 'rgba(255,255,255,0.4)' }}>-</span>
                            )}
                          </div>
                        </td>
                      )}
                      {visibleColumns.email && (
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {lead.email ? (
                              <a
                                href={`mailto:${lead.email}?subject=${encodeURIComponent(`Quick question about ${lead.name || 'your business'}`)}&body=${encodeURIComponent(applyCampaignToMessage(lead))}`}
                                className="link-email"
                                title="Click to open email client with campaign message"
                              >
                                {lead.email}
                              </a>
                            ) : (
                              <span style={{ color: 'rgba(255,255,255,0.4)' }}>Not found</span>
                            )}
                          </div>
                        </td>
                      )}
                      {visibleColumns.address && (
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {lead.address && lead.address !== 'Not Available' ? (
                              <span style={{ fontSize: '13px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {lead.address.length > 50 ? lead.address.substring(0, 50) + '...' : lead.address}
                              </span>
                            ) : (
                              <span style={{ color: 'rgba(255,255,255,0.4)' }}>-</span>
                            )}
                          </div>
                        </td>
                      )}
                      {visibleColumns.website && (
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {cleanWebsite ? (
                              <a href={cleanWebsite} target="_blank" rel="noopener noreferrer" className="link-website">
                                Visit
                              </a>
                            ) : (
                              <span style={{ color: 'rgba(255,255,255,0.4)' }}>-</span>
                            )}
                          </div>
                        </td>
                      )}
                      {visibleColumns.location && (
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <span className="badge badge-country">
                              {lead.country || 'Unknown'}
                            </span>
                            {lead.city && (
                              <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>
                                {lead.city}{lead.area && `, ${lead.area}`}
                              </span>
                            )}
                            {lead.address && lead.address !== 'Not Available' ? (
                              <a
                                href={getMapsLink(lead.address)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="link-maps"
                              >
                                📍 {lead.address.substring(0, 40)}{lead.address.length > 40 ? '...' : ''}
                              </a>
                            ) : (
                              <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)' }}>-</span>
                            )}
                          </div>
                        </td>
                      )}
                      {visibleColumns.niche && (
                        <td>
                          <span className="badge">
                            {lead.niche || 'General'}
                          </span>
                          {lead.category && lead.category !== lead.niche && (
                            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
                              {lead.category}
                            </div>
                          )}
                        </td>
                      )}
                      {visibleColumns.action && (
                        <td style={{ textAlign: 'center' }}>
                          <button 
                            onClick={() => handleDelete(lead.id, lead._isScraped)}
                            className="btn btn-delete"
                          >
                            <span className="btn-icon">🗑</span>
                            Delete
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      </div>{/* End container */}
    </div>
  );
}

export default App;