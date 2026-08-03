const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const freshEmail = 'newuser' + Date.now() + '@example.com';

  page.on('response', async res => {
    if (res.url().includes('/api/auth/signup')) {
      console.log('Response Status:', res.status(), res.statusText());
      try {
        const body = await res.text();
        console.log('Response Body:', body);
      } catch (e) {}
    }
  });

  await page.goto('http://localhost:3000/signup', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  await page.fill('#signup-fullName', 'New Debug User');
  await page.fill('#signup-business', 'NewDebugCorp');
  await page.fill('#signup-email', freshEmail);
  await page.fill('#signup-password', 'NewPass123');
  await page.fill('#signup-confirm', 'NewPass123');

  console.log('Submitting with email:', freshEmail);

  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  const errorText = await page.$eval('.auth-error', el => el.textContent).catch(() => null);
  console.log('Frontend error message:', errorText);
  console.log('Current URL:', page.url());

  await browser.close();
})();
