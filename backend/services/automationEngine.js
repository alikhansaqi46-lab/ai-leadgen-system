/**
 * Automation Engine — evaluate conditions and execute real actions.
 *
 * Supported actions (production):
 *   - qualify_leads          → aiProvider.qualifyLeads for workspace leads
 *   - update_campaign_status → campaignStorage.updateStatus
 *   - schedule_followup      → campaignStorage.scheduleFollowUps
 *   - send_whatsapp          → unifiedSend + WhatsApp transport (QR / Meta)
 *   - send_email             → unifiedSend + Gmail/OAuth
 *   - send_sms               → unifiedSend + Twilio
 *   - handle_objection       → AI reply using Settings objectionHandling knowledge
 *   - log_only               → audit log step (no side effects)
 */

const automationStorage = require('../utils/automationStorage');
const leadStorage = require('../utils/leadStorage');
const campaignStorage = require('../utils/campaignStorage');
const scoreStorage = require('../utils/scoreStorage');
const integrationStorage = require('../utils/integrationStorage');
const unifiedSend = require('./unifiedSend');
const aiProvider = require('./aiProvider');
const openAiKeyService = require('./openAiKeyService');
const whatsappTransport = require('./whatsappTransport');
const emailService = require('./emailService');
const { sendSms } = require('./smsService');
const userStorage = require('../utils/userStorage');
const timelineStorage = require('../utils/timelineStorage');
const { mergeAiAgentConfig } = require('../utils/aiAgentConfig');

function personalize(template, lead) {
  const name = (lead?.name || 'there').split(/\s+/)[0];
  const city = lead?.city || lead?.address || '';
  const niche = lead?.niche || lead?.category || 'business';
  return String(template || '')
    .replace(/\{name\}/gi, name)
    .replace(/\{city\}/gi, city)
    .replace(/\{niche\}/gi, niche);
}

function evalCondition(cond, context) {
  const field = cond.field || cond.key;
  const op = (cond.op || cond.operator || 'eq').toLowerCase();
  const expected = cond.value;
  const actual = context[field];

  switch (op) {
    case 'eq':
    case 'equals':
      return String(actual) === String(expected);
    case 'neq':
      return String(actual) !== String(expected);
    case 'gt':
      return Number(actual) > Number(expected);
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    case 'exists':
      return actual !== undefined && actual !== null && actual !== '';
    case 'in':
      return Array.isArray(expected) && expected.map(String).includes(String(actual));
    case 'contains':
    case 'includes':
      return String(actual || '').toLowerCase().includes(String(expected || '').toLowerCase());
    case 'matches':
    case 'regex':
      try {
        return new RegExp(String(expected), 'i').test(String(actual || ''));
      } catch (_) {
        return false;
      }
    default:
      return false;
  }
}

function evalConditions(conditions, context) {
  if (!Array.isArray(conditions) || conditions.length === 0) return { ok: true, details: [] };
  const logic = String(conditions[0]?.logic || conditions._logic || 'and').toLowerCase();
  const details = [];
  let ok = logic === 'or' ? false : true;
  for (const cond of conditions) {
    const passed = evalCondition(cond, context);
    details.push({ condition: cond, ok: passed });
    if (logic === 'or') {
      if (passed) { ok = true; break; }
    } else if (!passed) {
      ok = false;
      break;
    }
  }
  return { ok, details, logic };
}

async function resolveLead(leadId, workspaceId) {
  if (!leadId) throw new Error('leadId is required for this action');
  const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
  const lead = (leads || []).find((l) => l.id === leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  return lead;
}

async function executeAction(action, context, { workspaceId, runId, stepIndex }) {
  const type = action.type || action.action;
  const config = action.config || {};

  await automationStorage.addLog({
    runId,
    stepIndex,
    stepType: 'action',
    message: `Executing action: ${type}`,
    level: 'info',
    payload: { type, config },
  }, { workspaceId });

  switch (type) {
    case 'log_only':
      return { ok: true, detail: config.message || 'log_only' };

    case 'qualify_leads': {
      const userId = context.userId || workspaceId;
      const oaConfig = await openAiKeyService.getOpenAiConfig(userId);
      const leads = await leadStorage.getLeads({ workspaceId, limit: config.limit || 500 });
      if (!leads.length) return { ok: true, detail: 'no_leads' };
      const scored = await aiProvider.qualifyLeads(leads, {}, oaConfig.blocked ? {} : oaConfig);
      await scoreStorage.upsertScores(scored, { workspaceId });
      if (!oaConfig.blocked) {
        await openAiKeyService.consumeFreeMessage(userId, oaConfig.source);
      }
      return { ok: true, detail: `qualified_${scored.length}` };
    }

    case 'update_campaign_status': {
      const leadId = config.leadId || context.leadId;
      const status = config.status;
      if (!leadId || !status) throw new Error('update_campaign_status requires leadId and status');
      await campaignStorage.updateStatus(leadId, status, { workspaceId });
      return { ok: true, detail: `${leadId}->${status}` };
    }

    case 'schedule_followup': {
      const leadId = config.leadId || context.leadId;
      if (!leadId) throw new Error('schedule_followup requires leadId');
      await campaignStorage.scheduleFollowUps(
        leadId,
        { days1: config.waitDays1 || config.days1 || 2, days2: config.waitDays2 || config.days2 || 5 },
        { workspaceId }
      );
      return { ok: true, detail: `followup_scheduled_${leadId}` };
    }

    case 'send_whatsapp': {
      const leadId = config.leadId || context.leadId;
      const lead = await resolveLead(leadId, workspaceId);
      if (!whatsappTransport.isConfigured(workspaceId)) {
        throw new Error('WhatsApp not configured for workspace — set Meta Cloud API credentials in WhatsApp Settings');
      }
      const template = config.body || config.message || context.message
        || 'Hi {name}, following up from LeadFlow AI regarding {niche}.';
      const body = personalize(template, lead);
      const to = lead.whatsapp || lead.phone;
      if (!to) throw new Error('Lead has no WhatsApp/phone number');
      const result = await unifiedSend.send({
        leadId,
        channel: 'whatsapp',
        body,
        providerSend: async () => whatsappTransport.sendText({ workspaceId, to, message: body }),
        metadata: { source: 'automation', automationRunId: runId },
        scheduleFollowUps: config.scheduleFollowUps !== false,
        workspaceId,
      });
      return { ok: true, detail: 'whatsapp_sent', messageId: result.messageId };
    }

    case 'send_email': {
      const leadId = config.leadId || context.leadId;
      const lead = await resolveLead(leadId, workspaceId);
      if (!lead.email || lead.email === 'N/A') throw new Error('Lead has no email');
      const template = config.body || config.message || context.message
        || 'Hi {name},\n\nI wanted to reach out about {niche} opportunities.\n\nBest regards';
      const body = personalize(template, lead);
      const subject = personalize(config.subject || context.subject || `Quick question for ${lead.name || 'you'}`, lead);
      const result = await unifiedSend.send({
        leadId,
        channel: 'email',
        body,
        subject,
        providerSend: async () => emailService.sendEmailToLead(
          { ...lead },
          { message: body, subject, workspaceId }
        ),
        metadata: { source: 'automation', automationRunId: runId },
        scheduleFollowUps: !!config.scheduleFollowUps,
        workspaceId,
      });
      return { ok: true, detail: 'email_sent', messageId: result.messageId };
    }

    case 'delay': {
      const minutes = Number(config.minutes || config.delayMinutes || 0);
      const seconds = Number(config.seconds || config.delaySeconds || 0);
      const fromMs = Number(config.ms || 0);
      const raw = (Number.isFinite(minutes) ? minutes * 60_000 : 0)
        + (Number.isFinite(seconds) ? seconds * 1000 : 0)
        || (Number.isFinite(fromMs) ? fromMs : 0);
      const ms = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      if (ms <= 0) return { ok: true, detail: 'delay_zero' };
      const capped = Math.min(ms, 7 * 24 * 60 * 60 * 1000);
      return {
        ok: true,
        delay: true,
        delayMs: capped,
        resumeAt: new Date(Date.now() + capped).toISOString(),
        detail: `delay_${capped}ms`,
      };
    }

    case 'branch':
    case 'if': {
      const cond = config.condition || config.conditions?.[0] || null;
      const condList = Array.isArray(config.conditions) ? config.conditions : (cond ? [cond] : []);
      const { ok } = evalConditions(condList, context);
      const nextActions = ok
        ? (config.then || config.thenActions || [])
        : (config.else || config.elseActions || []);
      return {
        ok: true,
        branch: true,
        branchTaken: ok ? 'then' : 'else',
        nestedActions: Array.isArray(nextActions) ? nextActions : [],
        detail: ok ? 'branch_then' : 'branch_else',
      };
    }

    case 'send_sms': {
      const leadId = config.leadId || context.leadId;
      const lead = await resolveLead(leadId, workspaceId);
      const to = lead.phone || lead.sms;
      if (!to) throw new Error('Lead has no phone number for SMS');
      const template = config.body || config.message || context.message
        || 'Hi {name}, quick note from LeadFlow AI about {niche}.';
      const body = personalize(template, lead);
      const result = await unifiedSend.send({
        leadId,
        channel: 'sms',
        body,
        providerSend: async () => sendSms({ to, body, workspaceId }),
        metadata: { source: 'automation', automationRunId: runId },
        scheduleFollowUps: false,
        workspaceId,
      });
      return { ok: true, detail: 'sms_sent', messageId: result.messageId };
    }

    case 'handle_objection': {
      const leadId = config.leadId || context.leadId;
      const lead = await resolveLead(leadId, workspaceId);
      const inboundText = String(
        config.inboundText || context.messageText || context.body || context.message || ''
      ).trim();
      if (!inboundText) throw new Error('handle_objection requires inbound message text in context');

      const userId = context.userId || workspaceId;
      const user = await userStorage.findById(userId).catch(() => null);
      const agentConfig = mergeAiAgentConfig(await userStorage.getAiAgentConfig(userId), user);
      if (!String(agentConfig.objectionHandling || '').trim() && !config.fallbackBody) {
        throw new Error('Configure Objection Handling in Settings → AI Agent before using handle_objection');
      }

      const oaConfig = await openAiKeyService.getOpenAiConfig(userId);
      if (oaConfig.blocked && !config.fallbackBody) {
        throw new Error(`AI blocked: ${oaConfig.reason || 'no_key'}`);
      }

      let replyBody = '';
      let model = 'fallback';
      if (!oaConfig.blocked) {
        const reply = await aiProvider.generateReply(
          [{ direction: 'inbound', body: inboundText, channel: context.channel || 'email' }],
          lead,
          {
            workspaceId,
            config: oaConfig,
            agentConfig: {
              ...agentConfig,
              // Bias prompt toward objection playbook when present
              objectionHandling: agentConfig.objectionHandling
                || 'Address price, timing, and trust objections briefly and professionally.',
            },
          }
        );
        replyBody = String(reply?.body || '').trim();
        model = reply?.model || oaConfig.model || 'openai';
        await openAiKeyService.consumeFreeMessage(userId, oaConfig.source).catch(() => null);
      }
      if (!replyBody) {
        replyBody = personalize(
          config.fallbackBody || agentConfig.objectionHandling || 'Happy to clarify — what would help most?',
          lead
        );
        model = 'fallback';
      }

      await timelineStorage.recordEvent({
        leadId,
        type: 'ai_action',
        channel: context.channel || null,
        payload: {
          action: 'handle_objection',
          inboundText: inboundText.slice(0, 500),
          replyPreview: replyBody.slice(0, 500),
          model,
          autoSend: !!config.autoSend,
        },
      }, { workspaceId }).catch(() => null);

      const channel = (config.channel || context.channel || 'email').toLowerCase();
      if (!config.autoSend) {
        return {
          ok: true,
          detail: 'objection_drafted',
          replyBody,
          model,
          sent: false,
        };
      }

      if (channel === 'whatsapp') {
        if (!whatsappTransport.isConfigured(workspaceId)) throw new Error('WhatsApp not connected');
        const to = lead.whatsapp || lead.phone;
        if (!to) throw new Error('Lead has no WhatsApp/phone');
        const result = await unifiedSend.send({
          leadId,
          channel: 'whatsapp',
          body: replyBody,
          providerSend: async () => whatsappTransport.sendText({ workspaceId, to, message: replyBody }),
          metadata: { source: 'automation_objection', automationRunId: runId },
          scheduleFollowUps: false,
          workspaceId,
        });
        return { ok: true, detail: 'objection_sent_whatsapp', messageId: result.messageId, replyBody, model };
      }

      if (channel === 'sms') {
        const to = lead.phone || lead.sms;
        if (!to) throw new Error('Lead has no phone for SMS');
        const result = await unifiedSend.send({
          leadId,
          channel: 'sms',
          body: replyBody,
          providerSend: async () => sendSms({ to, body: replyBody, workspaceId }),
          metadata: { source: 'automation_objection', automationRunId: runId },
          scheduleFollowUps: false,
          workspaceId,
        });
        return { ok: true, detail: 'objection_sent_sms', messageId: result.messageId, replyBody, model };
      }

      // default email
      if (!lead.email || lead.email === 'N/A') throw new Error('Lead has no email');
      const subject = personalize(config.subject || 'Re: your message', lead);
      const result = await unifiedSend.send({
        leadId,
        channel: 'email',
        body: replyBody,
        subject,
        providerSend: async () => emailService.sendEmailToLead(
          { ...lead },
          { message: replyBody, subject, workspaceId }
        ),
        metadata: { source: 'automation_objection', automationRunId: runId },
        scheduleFollowUps: false,
        workspaceId,
      });
      return { ok: true, detail: 'objection_sent_email', messageId: result.messageId, replyBody, model };
    }

    default:
      throw new Error(`Unsupported action type: ${type}`);
  }
}

async function executeActionList(actions, context, { workspaceId, runId, stepOffset = 0 }) {
  const remaining = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const result = await executeAction(action, context, {
      workspaceId,
      runId,
      stepIndex: stepOffset + i + 1,
    });

    if (result.branch) {
      await automationStorage.addLog({
        runId,
        stepIndex: stepOffset + i + 1,
        stepType: 'branch',
        message: `Branch taken: ${result.branchTaken}${Array.isArray(result.nestedActions) && result.nestedActions.length ? '' : ' (empty arm)'}`,
        level: 'info',
        payload: result,
      }, { workspaceId });
      if (Array.isArray(result.nestedActions) && result.nestedActions.length) {
        const nested = await executeActionList(result.nestedActions, context, {
          workspaceId,
          runId,
          stepOffset: stepOffset + i + 1,
        });
        if (nested.paused) {
          remaining.push(...actions.slice(i + 1));
          return { paused: true, resumeAt: nested.resumeAt, remainingActions: [...(nested.remainingActions || []), ...remaining], context: nested.context };
        }
      }
      continue;
    }

    if (result.delay) {
      await automationStorage.addLog({
        runId,
        stepIndex: stepOffset + i + 1,
        stepType: 'delay',
        message: `Delay until ${result.resumeAt}`,
        level: 'info',
        payload: result,
      }, { workspaceId });
      remaining.push(...actions.slice(i + 1));
      return {
        paused: true,
        resumeAt: result.resumeAt,
        remainingActions: remaining,
        context: { ...context, delayMs: result.delayMs },
      };
    }

    await automationStorage.addLog({
      runId,
      stepIndex: stepOffset + i + 1,
      stepType: 'action',
      message: `Action completed: ${action.type || action.action}`,
      level: 'success',
      payload: result,
    }, { workspaceId });
  }
  return { paused: false };
}

async function runAutomation(automationId, context = {}, options = {}) {
  const workspaceId = options.workspaceId || context.workspaceId;
  if (!workspaceId) throw new Error('workspaceId required');

  const automation = await automationStorage.getById(automationId, { workspaceId });
  if (!automation) throw new Error('Automation not found');

  // Resume of a delayed run: execute remaining actions only
  const resumeActions = Array.isArray(context.resumeActions) ? context.resumeActions : null;

  const run = await automationStorage.createRun({
    automationId,
    triggerType: context.triggerType || automation.triggerType || 'manual',
    context,
  }, { workspaceId });

  await automationStorage.updateRun(run.id, { status: 'running', startedAt: new Date().toISOString() }, { workspaceId });
  await automationStorage.addLog({
    runId: run.id,
    stepIndex: 0,
    stepType: 'trigger',
    message: resumeActions
      ? `Resumed after delay (${run.triggerType})`
      : `Run started (${run.triggerType})`,
    level: 'info',
    payload: context,
  }, { workspaceId });

  try {
    if (!resumeActions) {
      const conditions = automation.conditions || [];
      const { ok, details, logic } = evalConditions(conditions, context);
      for (let i = 0; i < details.length; i++) {
        await automationStorage.addLog({
          runId: run.id,
          stepIndex: i + 1,
          stepType: 'condition',
          message: details[i].ok
            ? `Condition passed: ${details[i].condition.field || details[i].condition.key}`
            : `Condition failed: ${details[i].condition.field || details[i].condition.key}`,
          level: details[i].ok ? 'success' : 'warn',
          payload: { ...details[i], logic },
        }, { workspaceId });
      }
      if (!ok) {
        await automationStorage.updateRun(run.id, {
          status: 'succeeded',
          finishedAt: new Date().toISOString(),
          error: 'conditions_not_met',
        }, { workspaceId });
        return automationStorage.getRun
          ? automationStorage.getRun(run.id, { workspaceId })
          : automationStorage.updateRun(run.id, {}, { workspaceId });
      }
    }

    const actions = resumeActions || automation.actions || [];
    const listResult = await executeActionList(actions, context, {
      workspaceId,
      runId: run.id,
      stepOffset: resumeActions ? 0 : (automation.conditions || []).length,
    });

    if (listResult.paused) {
      const waitingCtx = {
        ...context,
        ...listResult.context,
        resumeActions: listResult.remainingActions || [],
        resumeAt: listResult.resumeAt,
        waitingFromRunId: run.id,
        automationId,
      };
      return automationStorage.updateRun(run.id, {
        status: 'waiting',
        finishedAt: null,
        error: null,
        context: waitingCtx,
      }, { workspaceId });
    }

    return automationStorage.updateRun(run.id, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
    }, { workspaceId });
  } catch (err) {
    const prevAttempt = Number((context && context.retryAttempt) || 0);
    const maxRetries = Number((context && context.maxRetries) ?? 3);
    const nextAttempt = prevAttempt + 1;
    const backoffMs = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, prevAttempt)));
    const retryMeta = nextAttempt < maxRetries
      ? {
          retryAttempt: nextAttempt,
          maxRetries,
          nextRetryAt: new Date(Date.now() + backoffMs).toISOString(),
          lastError: err.message,
        }
      : {
          retryAttempt: nextAttempt,
          maxRetries,
          retryExhausted: true,
          lastError: err.message,
        };

    await automationStorage.addLog({
      runId: run.id,
      stepIndex: 999,
      stepType: 'action',
      message: nextAttempt < maxRetries
        ? `${err.message} — scheduled retry #${nextAttempt} in ${Math.round(backoffMs / 1000)}s`
        : `${err.message} — retries exhausted`,
      level: 'error',
      payload: retryMeta,
    }, { workspaceId });
    return automationStorage.updateRun(run.id, {
      status: 'failed',
      error: err.message,
      finishedAt: new Date().toISOString(),
      context: { ...(context || {}), ...retryMeta },
    }, { workspaceId });
  }
}

async function dispatchEvent(triggerType, context = {}, options = {}) {
  const workspaceId = options.workspaceId || context.workspaceId;
  if (!workspaceId) return [];
  const matches = await automationStorage.listEnabledByTrigger(triggerType, { workspaceId });
  const results = [];
  for (const auto of matches) {
    results.push(await runAutomation(auto.id, { ...context, triggerType, workspaceId }, { workspaceId }));
  }
  return results;
}

module.exports = {
  runAutomation,
  dispatchEvent,
  evalCondition,
  evalConditions,
  executeAction,
  executeActionList,
};
