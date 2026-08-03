/**
 * Quick verification: cold outreach MIME includes List-Unsubscribe + multipart text/html.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const MailComposer = require('nodemailer/lib/mail-composer');

async function main() {
  const composer = new MailComposer({
    from: '"LeadFlow AI" <leadflow.my@gmail.com>',
    to: 'test@example.com',
    replyTo: 'leadflow.my@gmail.com',
    subject: 'Outreach',
    text: 'Hi there, plain text body for deliverability.',
    html: '<!DOCTYPE html><html><body><p>Hi there</p></body></html>',
    headers: {
      'List-Unsubscribe': '<mailto:leadflow.my@gmail.com?subject=Unsubscribe>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
  const raw = (await composer.compile().build()).toString();
  const checks = {
    listUnsubscribe: raw.includes('List-Unsubscribe:'),
    listUnsubscribePost: raw.includes('List-Unsubscribe-Post:'),
    hasPlainText: raw.includes('plain text body'),
    hasHtml: raw.includes('text/html') || raw.includes('<p>Hi there</p>'),
    multipart: raw.includes('multipart/'),
  };
  const pass = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ pass, checks }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
