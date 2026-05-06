const admin = require('firebase-admin');

let serviceAccount;

try {
  serviceAccount = require('../serviceAccountKey.json');
} catch (error) {
  console.log('No Firebase key found, running without DB');
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = serviceAccount ? admin.firestore() : null;

module.exports = { admin, db };