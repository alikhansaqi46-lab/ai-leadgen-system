const admin = require('firebase-admin');

let serviceAccount = null;
let db = null;

// 1) Try local service account file (development)
try {
  serviceAccount = require('../serviceAccountKey.json');
  console.log('[Firebase] Loaded serviceAccountKey.json');
} catch (error) {
  // Not found locally — try env vars next
}

// 2) Try environment variables (Render / Heroku / production)
if (!serviceAccount && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  serviceAccount = {
    type: 'service_account',
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID || '',
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID || '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs'
  };
  console.log('[Firebase] Initialized from environment variables (project:', process.env.FIREBASE_PROJECT_ID, ')');
}

// 3) Initialize if we have credentials
if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    console.log('[Firebase] Firestore connected');
  } catch (err) {
    console.error('[Firebase] Failed to initialize:', err.message);
    db = null;
  }
} else {
  console.log('[Firebase] No credentials found. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY env vars, or place serviceAccountKey.json in backend/');
}

module.exports = { admin, db };