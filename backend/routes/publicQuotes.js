const express = require('express');
const router = express.Router();
const quoteService = require('../services/quoteService');
const quoteStorage = require('../utils/quoteStorage');
const path = require('path');
const fs = require('fs');

/** Public share viewer — no auth. Token is the capability. */
router.get('/:token', async (req, res) => {
  try {
    const document = await quoteService.getPublicDocument(req.params.token);
    if (!document) return res.status(404).json({ error: 'Document not found or link expired' });
    res.json({ success: true, document });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:token/pdf', async (req, res) => {
  try {
    const doc = await quoteStorage.getByPublicToken(req.params.token);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const frontend = process.env.FRONTEND_URL || process.env.APP_FRONTEND_URL || 'http://localhost:3000';
    const shareUrl = `${String(frontend).replace(/\/$/, '')}/share/quote/${req.params.token}`;
    const { document, pdf } = await quoteService.exportPdf(doc.id, doc.workspaceId, { shareUrl, publicUrl: shareUrl });
    const abs = path.join(__dirname, '..', 'uploads', pdf.filename);
    if (!fs.existsSync(abs)) return res.status(500).json({ error: 'PDF missing' });
    // Token-gated public document: allow cross-origin embedding (Inbox thumbnail, mail clients).
    res.removeHeader('X-Frame-Options');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${document.number || document.id}.pdf"`);
    fs.createReadStream(abs).pipe(res);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
