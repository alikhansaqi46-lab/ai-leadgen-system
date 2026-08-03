const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const freshEmail = 'fresh' + Date.now() + '@example.com';
  let responseStatus = 'No response captured';
  let responseBody = 'No body captured';

  page.on('response', async res => {
    if (res.url().includes('/api/auth/signup')) {
      responseStatus = res.status() + ' ' + res.statusText();
      try { responseBody = await res.text(); } catch (e) { responseBody = 'Error: ' + e.message; }
    }
  });

  await page.goto('http://localhost:3000/signup', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  await page.fill('#signup-fullName', 'Fresh User');
  await page.fill('#signup-business', 'FreshCorp');
  await page.fill('#signup-email', freshEmail);
  await page.fill('#signup-password', 'FreshPass123');
  await page.fill('#signup-confirm', 'FreshPass123');

  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  const errorText = await page.$eval('.auth-error', el => el.textContent).catch(() => null);

  console.log('Email used:', freshEmail);
  console.log('Response Status:', responseStatus);
  console.log('Response Body:', responseBody);
  console.log('Frontend error:', errorText);
  console.log('Current URL:', page.url());

  await browser.close();
})();
