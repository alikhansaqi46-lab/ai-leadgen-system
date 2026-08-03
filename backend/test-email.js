const nodemailer = require('nodemailer');

console.log('EMAIL_USER:', process.env.EMAIL_USER || 'NOT SET');
console.log('EMAIL_PASS length:', process.env.EMAIL_PASS ? process.env.EMAIL_PASS.length : 0);

// Try the current config
const t1 = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// Verify
console.log('\n--- Testing current config ---');
t1.verify((err, success) => {
  if (err) {
    console.error('Current config FAILED:', err.message);
    console.log('Retrying with TLS rejectUnauthorized: false...');
    
    const t2 = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      tls: { rejectUnauthorized: false }
    });
    
    t2.verify((err2, success2) => {
      if (err2) {
        console.error('TLS relaxed config FAILED:', err2.message);
        console.log('Retrying with explicit host/port...');
        
        const t3 = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
          tls: { rejectUnauthorized: false, ciphers: 'SSLv3' }
        });
        
        t3.verify((err3, success3) => {
          if (err3) {
            console.error('Explicit config FAILED:', err3.message);
          } else {
            console.log('Explicit config SUCCESS');
          }
        });
      } else {
        console.log('TLS relaxed config SUCCESS');
      }
    });
  } else {
    console.log('Current config SUCCESS');
  }
});
