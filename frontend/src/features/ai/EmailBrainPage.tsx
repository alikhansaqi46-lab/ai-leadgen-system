import { useEffect, useState } from 'react';
import PageHeader from '../common/PageHeader';
import {
  getChannelBrainConfig,
  updateChannelBrainConfig,
  ChannelBrainConfig,
  ChannelType,
} from '../../lib/apiClient';

const CHANNEL: ChannelType = 'email';
const CHANNEL_LABEL = 'Email';
const CHANNEL_ICON = '@';

const DEFAULT_CONFIG: ChannelBrainConfig = {
  aiEnabled: true,
  businessName: '',
  companyDescription: '',
  products: '',
  services: '',
  pricing: '',
  features: '',
  offers: '',
  promotions: '',
  faqs: '',
  systemPrompt: '',
  tone: 'professional and friendly',
  writingStyle: 'concise, clear, and helpful',
  replyRules: '',
  humanTakeoverKeywords: ['human', 'agent', 'call me', 'speak to someone', 'representative'],
  followUpEnabled: true,
  followUpDelay: 60,
  maxFollowUps: 3,
  followUpMessage: '',
  campaignInstructions: '',
  maxMemoryMessages: 50,
  memoryExpiryDays: 30,
};

export default function EmailBrainPage() {
  const [config, setConfig] = useState<ChannelBrainConfig>({ ...DEFAULT_CONFIG });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      setLoading(true);
      const res = await getChannelBrainConfig(CHANNEL);
      if (res.success && res.config) {
        setConfig({ ...DEFAULT_CONFIG, ...res.config });
      }
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to load ${CHANNEL_LABEL} Brain configuration.` });
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    try {
      setSaving(true);
      setMessage(null);
      const res = await updateChannelBrainConfig(CHANNEL, config);
      if (res.success) {
        setConfig({ ...DEFAULT_CONFIG, ...res.config });
        setMessage({ type: 'success', text: `${CHANNEL_LABEL} Brain configuration saved successfully.` });
      } else {
        setMessage({ type: 'error', text: 'Failed to save configuration.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to save configuration.' });
    } finally {
      setSaving(false);
    }
  }

  function updateField<K extends keyof ChannelBrainConfig>(key: K, value: ChannelBrainConfig[K]) {
    setConfig(prev => ({ ...prev, [key]: value }));
  }

  if (loading) {
    return (
      <div className="lf-page">
        <PageHeader title={`${CHANNEL_LABEL} Brain`} subtitle={`Loading ${CHANNEL_LABEL} AI Brain configuration…`} />
        <div className="lf-card lf-skeleton" style={{ height: 600 }} />
      </div>
    );
  }

  return (
    <div className="lf-page">
      <PageHeader
        title={`${CHANNEL_ICON} ${CHANNEL_LABEL} Brain`}
        subtitle={`Configure the ${CHANNEL_LABEL} AI Brain — independent from other channels`}
        actions={
          <button
            className="lf-btn lf-btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save Configuration'}
          </button>
        }
      />

      <div className="lf-note" style={{ marginBottom: 20 }}>
        This {CHANNEL_LABEL} Brain is completely independent. It has its own knowledge, prompts, tone, 
        and memory — it never reads from or shares data with other channel brains.
      </div>

      {message && (
        <div className={`lf-alert ${message.type === 'success' ? 'lf-alert-success' : 'lf-alert-error'}`} style={{ marginBottom: 16 }}>
          {message.text}
        </div>
      )}

      {/* AI Enable/Disable */}
      <div className="lf-card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16 }}>AI Enable/Disable</h3>
        <label className="lf-checkbox-row" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={config.aiEnabled}
            onChange={(e) => updateField('aiEnabled', e.target.checked)}
          />
          <span>Enable AI for {CHANNEL_LABEL} channel</span>
        </label>
        <p style={{ fontSize: 12, color: 'var(--lf-muted)', margin: '8px 0 0 0' }}>
          When disabled, {CHANNEL_LABEL} messages will not be automatically replied to by the AI.
        </p>
      </div>

      {/* Business Knowledge */}
      <div className="lf-card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16 }}>Business Knowledge</h3>
        <div className="lf-deflist">
          <div className="lf-field">
            <label>Business Name</label>
            <input
              className="lf-input"
              value={config.businessName}
              onChange={(e) => updateField('businessName', e.target.value)}
              placeholder="Your business name"
            />
          </div>
          <div className="lf-field">
            <label>Company Description</label>
            <textarea
              className="lf-input"
              rows={3}
              value={config.companyDescription}
              onChange={(e) => updateField('companyDescription', e.target.value)}
              placeholder="Describe what your business does"
            />
          </div>
          <div className="lf-field">
            <label>Products</label>
            <textarea
              className="lf-input"
              rows={3}
              value={config.products}
              onChange={(e) => updateField('products', e.target.value)}
              placeholder="List your products"
            />
          </div>
          <div className="lf-field">
            <label>Services</label>
            <textarea
              className="lf-input"
              rows={3}
              value={config.services}
              onChange={(e) => updateField('services', e.target.value)}
              placeholder="List your services"
            />
          </div>
          <div className="lf-field">
            <label>Pricing</label>
            <textarea
              className="lf-input"
              rows={3}
              value={config.pricing}
              onChange={(e) => updateField('pricing', e.target.value)}
              placeholder="Describe your pricing structure"
            />
          </div>
          <div className="lf-field">
            <label>Features</label>
            <textarea
              className="lf-input"
              rows={2}
              value={config.features}
              onChange={(e) => updateField('features', e.target.value)}
              placeholder="Key features of your products/services"
            />
          </div>
          <div className="lf-field">
            <label>Offers</label>
            <textarea
              className="lf-input"
              rows={2}
              value={config.offers}
              onChange={(e) => updateField('offers', e.target.value)}
              placeholder="Current offers or deals"
            />
          </div>
          <div className="lf-field">
            <label>Promotions</label>
            <textarea
              className="lf-input"
              rows={2}
              value={config.promotions}
              onChange={(e) => updateField('promotions', e.target.value)}
              placeholder="Active promotions"
            />
          </div>
        </div>
      </div>

      {/* FAQs */}
      <div className="lf-card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16 }}>FAQs</h3>
        <div className="lf-field">
          <label>Frequently Asked Questions</label>
          <textarea
            className="lf-input"
            rows={5}
            value={config.faqs}
            onChange={(e) => updateField('faqs', e.target.value)}
            placeholder="List common questions and answers your customers ask"
          />
        </div>
      </div>

      {/* System Prompt */}
      <div className="lf-card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16 }}>System Prompt</h3>
        <div className="lf-field">
          <label>Custom System Prompt</label>
          <textarea
            className="lf-input"
            rows={6}
            value={config.systemPrompt}
            onChange={(e) => updateField('systemPrompt', e.target.value)}
            placeholder={`Override the default system prompt for the ${CHANNEL_LABEL} AI brain. Leave empty to use the default.`}
          />
          <p style={{ fontSize: 12, color: 'var(--lf-muted)', margin: '4px 0 0 0' }}>
            This prompt is unique to the {CHANNEL_LABEL} channel. Other channels will not use it.
          </p>
        </div>
      </div>

      {/* Tone */}
      <div className="lf-card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16 }}>Tone</h3>
        <div className="lf-deflist">
          <div className="lf-field">
            <label>Sales Tone</label>
            <input
              className="lf-input"
              value={config.tone}
              onChange={(e) => updateField('tone', e.target.value)}
              placeholder="e.g., professional and friendly"
            />
          </div>
          <div className="lf-field">
            <label>Writing Style</label>
            <input
              className="lf-input"
              value={config.writingStyle}
              onChange={(e) => updateField('writingStyle', e.target.value)}
              placeholder="e.g., concise, clear, and helpful"
            />
          </div>
        </div>
      </div>

      {/* Reply Rules */}
      <div className="lf-card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16 }}>Reply Rules</h3>
        <div className="lf-deflist">
          <div className="lf-field">
            <label>Custom Reply Rules</label>
            <textarea
              className="lf-input"
              rows={4}
              value={config.replyRules}
              onChange={(e) => updateField('replyRules', e.target.value)}
              placeholder="Define specific rules for how the AI should reply on this channel"
            />
          </div>
          <div className="lf-field">
            <label>Human Takeover Keywords</label>
            <input
              className="lf-input"
              value={config.humanTakeoverKeywords.join(', ')}
              onChange={(e) => updateField('humanTakeoverKeywords', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
              placeholder="Comma-separated keywords that trigger human takeover"
            />
            <p style={{ fontSize: 12, color: 'var(--lf-muted)', margin: '4px 0 0 0' }}>
              When a customer uses any of these words, the conversation will be flagged for human takeover.
            </p>
          </div>
        </div>
      </div>

      {/* Follow-up Strategy */}
      <div className="lf-card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16 }}>Follow-up Strategy</h3>
        <div className="lf-deflist">
          <label className="lf-checkbox-row" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={config.followUpEnabled}
              onChange={(e) => updateField('followUpEnabled', e.target.checked)}
            />
            <span>Enable automatic follow-ups</span>
          </label>
          <div className="lf-field">
            <label>Follow-up Delay (minutes)</label>
            <input
              className="lf-input"
              type="number"
              min={1}
              value={config.followUpDelay}
              onChange={(e) => updateField('followUpDelay', parseInt(e.target.value) || 60)}
            />
          </div>
          <div className="lf-field">
            <label>Max Follow-ups</label>
            <input
              className="lf-input"
              type="number"
              min={0}
              max={10}
              value={config.maxFollowUps}
              onChange={(e) => updateField('maxFollowUps', parseInt(e.target.value) || 3)}
            />
          </div>
          <div className="lf-field">
            <label>Follow-up Message Template</label>
            <textarea
              className="lf-input"
              rows={3}
              value={config.followUpMessage}
              onChange={(e) => updateField('followUpMessage', e.target.value)}
              placeholder="Template for follow-up messages. Use {name} for customer name."
            />
          </div>
        </div>
      </div>

      {/* Campaign Instructions */}
      <div className="lf-card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16 }}>Campaign Instructions</h3>
        <div className="lf-field">
          <label>Instructions for Campaign Mode</label>
          <textarea
            className="lf-input"
            rows={4}
            value={config.campaignInstructions}
            onChange={(e) => updateField('campaignInstructions', e.target.value)}
            placeholder="Special instructions for how the AI should behave during campaigns"
          />
        </div>
      </div>

      {/* Conversation Memory Settings */}
      <div className="lf-card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16 }}>Conversation Memory Settings</h3>
        <div className="lf-deflist">
          <div className="lf-field">
            <label>Max Memory Messages</label>
            <input
              className="lf-input"
              type="number"
              min={5}
              max={500}
              value={config.maxMemoryMessages}
              onChange={(e) => updateField('maxMemoryMessages', parseInt(e.target.value) || 50)}
            />
            <p style={{ fontSize: 12, color: 'var(--lf-muted)', margin: '4px 0 0 0' }}>
              Maximum number of past messages the AI will remember per conversation.
            </p>
          </div>
          <div className="lf-field">
            <label>Memory Expiry (days)</label>
            <input
              className="lf-input"
              type="number"
              min={1}
              max={365}
              value={config.memoryExpiryDays}
              onChange={(e) => updateField('memoryExpiryDays', parseInt(e.target.value) || 30)}
            />
            <p style={{ fontSize: 12, color: 'var(--lf-muted)', margin: '4px 0 0 0' }}>
              Conversations older than this will be archived and not used for AI context.
            </p>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
        <button
          className="lf-btn lf-btn-primary"
          onClick={handleSave}
          disabled={saving}
          style={{ minWidth: 180 }}
        >
          {saving ? 'Saving…' : `Save ${CHANNEL_LABEL} Brain Configuration`}
        </button>
      </div>
    </div>
  );
}