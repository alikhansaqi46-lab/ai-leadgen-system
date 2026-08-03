/**
 * CampaignBulkSender — sequential bulk campaign orchestration.
 *
 * Responsibilities:
 *   - Receive recipients
 *   - Process strictly one recipient at a time (sequential)
 *   - Isolate each recipient's execution (one failure never stops the batch)
 *   - Collect per-recipient results
 *   - Produce a final summary
 *
 * Contains NO WhatsApp logic. Delivery is delegated entirely to the injected
 * per-recipient executor function.
 */

async function execute({ recipients, executeRecipient, delayMs = 0, onResult = null }) {
  if (typeof executeRecipient !== 'function') {
    throw new Error('CampaignBulkSender requires an executeRecipient function');
  }

  const list = Array.isArray(recipients) ? recipients : [];
  const results = [];
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < list.length; i++) {
    const recipient = list[i];
    const position = { index: i + 1, total: list.length };
    let entry;
    try {
      const outcome = await executeRecipient(recipient, position);
      entry = { leadId: recipient?.id, name: recipient?.name, ...outcome };
      if (!entry.status) entry.status = 'sent';
      if (entry.status === 'sent') sent += 1; else failed += 1;
    } catch (err) {
      entry = {
        leadId: recipient?.id,
        name: recipient?.name,
        status: 'failed',
        error: err.message,
        source: err.source || err.service || null,
        rateLimited: Boolean(err.rateLimited || err.status === 429),
        retryAfter: err.retryAfter || null,
      };
      failed += 1;
      console.error(`[BulkSender] Recipient ${position.index}/${position.total} failed:`, err.message);
    }

    results.push(entry);
    if (typeof onResult === 'function') {
      try {
        onResult(entry, position);
      } catch (_) { /* listener errors must not stop the batch */ }
    }

    if (delayMs > 0 && i < list.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const summary = { total: list.length, sent, failed, results };
  console.log(`[BulkSender] Batch complete — total=${summary.total} sent=${summary.sent} failed=${summary.failed}`);
  return summary;
}

module.exports = { execute };
