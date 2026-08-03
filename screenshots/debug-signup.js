const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Intercept and log all network requests
  page.on('request', req => {
    if (req.url().includes('/api/auth/signup')) {
      console.log('Request URL:', req.url());
      console.log('Request Method:', req.method());
      console.log('Request Headers:', JSON.stringify(req.headers()));
      req.postData() && console.log('Request Body:', req.postData());
    }
  });

  page.on('response', async res => {
    if (res.url().includes('/api/auth/signup')) {
      console.log('Response Status:', res.status(), res.statusText());
      try {
        const body = await res.text();
        console.log('Response Body:', body);
      } catch (e) {
        console.log('Could not read response body');
      }
    }
  });

  // Go to signup page
  await page.goto('http://localhost:3000/signup', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Fill the form
  await page.fill('#signup-fullName', 'Debug User');
  await page.fill('#signup-business', 'DebugCorp');
  await page.fill('#signup-email', 'debuguser999@example.com');
  await page.fill('#signup-password', 'DebugPass123');
  await page.fill('#signup-confirm', 'DebugPass123');

  console.log('Form filled, submitting...');

  // Submit
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  // Check for error message
  const errorText = await page.$eval('.auth-error', el => el.textContent).catch(() => null);
  console.log('Frontend error message:', errorText);

  // Check current URL
  console.log('Current URL:', page.url());

  await browser.close();
})();
