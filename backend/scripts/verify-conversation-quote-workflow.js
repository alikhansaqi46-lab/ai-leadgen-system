/**
 * Verify conversation-native quote workflow (API + data checks).
 * Usage: node scripts/verify-conversation-quote-workflow.js
 * Requires OWNER_PASSWORD in .env for authenticated checks.
 */
require('dotenv').config();
const http = require('http');
const path = require('path');

const BASE = `http://localhost:${process.env.PORT || 5001}`;
const email = process.env.OWNER_EMAIL || 'leadflow.my@gmail.com';
const password = process.env.OWNER_PASSWORD || '';

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: 'localhost',
      port: Number(process.env.PORT || 5001),
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let parsed = b;
        try { parsed = JSON.parse(b); } catch { /* keep string */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const report = { steps: [], at: new Date().toISOString() };
  const pass = (name, detail) => report.steps.push({ name, status: 'PASS', detail });
  const fail = (name, detail) => report.steps.push({ name, status: 'FAIL', detail });

  if (!password) {
    fail('Auth', 'Set OWNER_PASSWORD in backend/.env to run authenticated verification');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const login = await req('POST', '/api/auth/login', { email, password });
  if (login.status !== 200 || !login.body?.token) {
    fail('Login', `status=${login.status} ${JSON.stringify(login.body).slice(0, 200)}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  pass('Login', `authenticated as ${email}`);
  const token = login.body.token;
  const workspaceId = login.body.user?.workspace_id || login.body.workspaceId || 'unknown';

  const convRes = await req('GET', '/api/ai/conversations', null, token);
  if (convRes.status !== 200) {
    fail('List conversations', `status=${convRes.status}`);
  } else {
    const convs = convRes.body?.conversations || [];
    pass('List conversations', `${convs.length} conversations in workspace ${workspaceId}`);
    const pick = convs.find((c) => (c.messageCount || 0) > 0) || convs[0];
    if (!pick) {
      fail('Pick conversation', 'No conversations available');
    } else {
      pass('Pick conversation', `${pick.id} channel=${pick.channel} leadId=${pick.leadId}`);

      const aiRes = await req('POST', '/api/quotes/ai-from-conversation', {
        conversationId: pick.id,
        docType: 'quote',
        autoMode: false,
      }, token);

      if (aiRes.status === 201 && aiRes.body?.document?.id) {
        const doc = aiRes.body.document;
        pass('AI from conversation', `${doc.number || doc.id} total=${doc.total} messages=${aiRes.body.messageCount}`);
        report.generatedDocId = doc.id;
        report.generatedNumber = doc.number;
      } else {
        fail('AI from conversation', `status=${aiRes.status} ${JSON.stringify(aiRes.body).slice(0, 300)}`);
      }
    }
  }

  const smsPage = await req('GET', '/api/leads?limit=1', null, token);
  pass('Leads API reachable', `status=${smsPage.status}`);

  const outPath = path.join(__dirname, '../logs/conversation-quote-verify.json');
  require('fs').writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('Wrote', outPath);
  console.log(JSON.stringify(report, null, 2));
  const failed = report.steps.filter((s) => s.status === 'FAIL');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
