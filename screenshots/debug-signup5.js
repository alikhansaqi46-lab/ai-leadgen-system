const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('http://localhost:3000/signup', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Use an email that already exists
  await page.fill('#signup-fullName', 'Dup Test');
  await page.fill('#signup-business', 'DupCorp');
  await page.fill('#signup-email', 'testflow7@example.com');
  await page.fill('#signup-password', 'DupPass123');
  await page.fill('#signup-confirm', 'DupPass123');

  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);

  const errorText = await page.$eval('.auth-error', el => el.textContent).catch(() => null);
  console.log('Error shown on page:', errorText);

  await browser.close();
})();
