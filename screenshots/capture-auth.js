const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const outDir = 'C:\\AI-LeadGen-system\\screenshots';

  const shots = [
    { url: 'http://localhost:3000/login', file: 'auth-login-v2.png', wait: 2000 },
    { url: 'http://localhost:3000/signup', file: 'auth-signup-v2.png', wait: 2000 },
    { url: 'http://localhost:3000/forgot-password', file: 'auth-forgot-v2.png', wait: 2000 },
  ];

  for (const shot of shots) {
    try {
      await page.goto(shot.url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(shot.wait);
      await page.screenshot({ path: path.join(outDir, shot.file), fullPage: false });
      console.log('Captured:', shot.file);
    } catch (e) {
      console.error('Failed', shot.file, e.message);
    }
  }

  await browser.close();
  console.log('Done');
})();
