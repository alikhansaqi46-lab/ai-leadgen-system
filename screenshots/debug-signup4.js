const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const freshEmail = 'working' + Date.now() + '@example.com';
  let responseInfo = 'No response';

  page.on('response', async res => {
    if (res.url().includes('/api/auth/signup')) {
      const body = await res.text();
      responseInfo = `Status: ${res.status()} ${res.statusText()}, Body: ${body}`;
    }
  });

  // Capture console errors
  page.on('console', msg => {
    if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text());
  });

  await page.goto('http://localhost:3000/signup', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  await page.fill('#signup-fullName', 'Working User');
  await page.fill('#signup-business', 'WorkingCorp');
  await page.fill('#signup-email', freshEmail);
  await page.fill('#signup-password', 'WorkingPass123');
  await page.fill('#signup-confirm', 'WorkingPass123');

  console.log('Email:', freshEmail);

  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  const errorText = await page.$eval('.auth-error', el => el.textContent).catch(() => null);
  const url = page.url();

  console.log('Response:', responseInfo);
  console.log('Error text:', errorText);
  console.log('URL:', url);

  await browser.close();
})();
