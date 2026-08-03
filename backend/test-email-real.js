require('dotenv').config();
const nodemailer = require('nodemailer');

console.log('EMAIL_USER:', process.env.EMAIL_USER || 'NOT SET');
console.log('EMAIL_PASS length:', process.env.EMAIL_PASS ? process.env.EMAIL_PASS.replace(/\s/g, '').length : 0);

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  console.error('No email credentials found in .env');
  process.exit(1);
}

// Production config: explicit Gmail SMTP with spaces stripped from App Password
const pass = process.env.EMAIL_PASS.replace(/\s/g, '');
const tlsOpt = process.env.EMAIL_TLS_REJECT_UNAUTHORIZED === 'false'
  ? { rejectUnauthorized: false }
  : undefined;
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: process.env.EMAIL_USER, pass },
  ...(tlsOpt ? { tls: tlsOpt } : {}),
});

console.log('\n--- Verifying SMTP connection ---');
transporter.verify((err) => {
  if (err) {
    console.error('FAILED:', err.message);
    process.exit(1);
  }
  console.log('SUCCESS: SMTP connection verified');
  sendTest(transporter);
});

async function sendTest(transporter) {
  console.log('\n--- Sending test email ---');
  try {
    const result = await transporter.sendMail({
      from: `"LeadFlow AI Test" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      subject: 'LeadFlow AI - Email Verification Test',
      text: 'This is a test email from LeadFlow AI.\nIf you received this, the SMTP configuration is working.',
      html: '<p>This is a test email from <strong>LeadFlow AI</strong>.</p><p>If you received this, the SMTP configuration is working.</p>',
    });
    console.log('Email sent! MessageId:', result.messageId);
  } catch (err) {
    console.error('Send FAILED:', err.message);
  }
}
