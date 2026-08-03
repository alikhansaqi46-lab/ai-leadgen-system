const express = require('express');
const router = express.Router();
const { buildPerformanceReport } = require('../services/reportService');

const { workspaceOf } = require('../utils/workspaceContext');

/** GET /api/reports/performance?days=30 */
router.get('/performance', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const days = req.query.days || 30;
    const report = await buildPerformanceReport({ workspaceId, days });
    res.json({ success: true, report });
  } catch (error) {
    console.error('[Reports] performance error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
