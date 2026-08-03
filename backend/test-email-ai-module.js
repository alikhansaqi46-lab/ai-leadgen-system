const assert = require('assert');
const { parseEmailAddress, isValidEmail, resolveDeliveryEmail } = require('./utils/emailValidation');
const personalContactStorage = require('./utils/personalContactStorage');
const { mergeAiAgentConfig, buildAiAgentSystemPrompt, shouldHandoffToHuman } = require('./utils/aiAgentConfig');

assert.strictEqual(parseEmailAddress('Ali Khan <saqi@gmail.com>'), 'saqi@gmail.com');
assert.strictEqual(isValidEmail('saqi@gmail.com'), true);
assert.strictEqual(isValidEmail('not-an-email'), false);
assert.strictEqual(resolveDeliveryEmail({ email: 'Name <test@example.com>' }), 'test@example.com');
assert.strictEqual(personalContactStorage.resolveDeliveryEmail({ email: 'bad value', emailNormalized: 'good@example.com' }), 'good@example.com');

const cfg = mergeAiAgentConfig({ businessName: 'Acme Dental', services: 'Teeth whitening' }, null);
assert.ok(cfg.businessName === 'Acme Dental');
assert.ok(buildAiAgentSystemPrompt(cfg).includes('Acme Dental'));
assert.ok(shouldHandoffToHuman('Can I speak to a human please?', cfg));

console.log('email-ai-module checks passed');
