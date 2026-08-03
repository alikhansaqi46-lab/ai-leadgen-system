/**
 * Full campaign route trace (bypasses HTTP auth) — logs steps 1-10.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const WORKSPACE_ID = process.env.TRACE_WORKSPACE_ID || 'usr_super_admin_1783323507243';

function step(n, label, extra = {}) {
  console.log('[TRACE]', JSON.stringify({ step: n, label, at: new Date().toISOString(), ...extra }));
}

async function main() {
  step(1, 'frontend_would_post', { route: 'POST /api/campaign/send-with-preview' });

  const payload = {
    channel: 'email',
    leads: [{ id: 'e0d9b27e-fe87-473c-bd5c-4c0e9719673d', email: 'leadflow.my@gmail.com', name: 'Sky Dental', city: 'New York', niche: 'dental clinic' }],
    message: 'Route trace message',
    subject: 'Route Trace',
    previewMode: false,
  };

  const req = {
    body: payload,
    auth: { userId: WORKSPACE_ID, workspaceId: WORKSPACE_ID },
    headers: {},
  };

  let statusCode = null;
  let responseBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { responseBody = body; return body; },
  };

  step(2, 'backend_route_invoked');
  const campaignRouter = require('../routes/campaign');
  const layer = campaignRouter.stack.find((l) => l.route && l.route.path === '/send-with-preview' && l.route.methods.post);
  if (!layer) throw new Error('send-with-preview route not found');
  const handler = layer.route.stack[0].handle;

  step(3, 'campaign_handler_started');
  const started = Date.now();
  try {
    await handler(req, res);
    step(9, 'backend_response_sent', {
      statusCode,
      elapsedMs: Date.now() - started,
      body: responseBody,
    });
    step(10, 'frontend_would_receive', { success: responseBody?.sent > 0, statusCode });
  } catch (err) {
    step(9, 'campaign_handler_threw', {
      elapsedMs: Date.now() - started,
      message: err?.message,
      source: err?.source,
      rateLimited: err?.rateLimited,
      retryAfter: err?.retryAfter,
      response: err?.response?.data,
    });
    process.exit(1);
  }
}

main();
