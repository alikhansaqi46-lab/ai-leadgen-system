const files = [
  './server.js',
  './routes/openai.js',
  './routes/ai.js',
  './services/openAiKeyService.js',
  './services/aiProvider.js',
  './utils/encryption.js',
  './utils/userStorage.js',
  './middleware/auth.js',
  './services/authService.js',
  './middleware/subscription.js',
  './routes/webhook.js',
];

let ok = true;
for (const f of files) {
  try {
    require(f);
    console.log(`OK: ${f}`);
  } catch (e) {
    console.error(`FAIL: ${f} - ${e.message}`);
    ok = false;
  }
}
if (ok) console.log('\nALL SYNTAX CHECKS PASSED');
else console.log('\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
