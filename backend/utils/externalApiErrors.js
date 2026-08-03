/**
 * External API error helpers — identify rate-limit sources and log structured details.
 *
 * Gmail returns: "User-rate limit exceeded. Retry after 2026-07-08T05:00:00.000Z"
 * OpenAI returns: { error: { type: "rate_limit_exceeded", ... } }
 */

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function extractRetryAfter(err) {
  const headers = err?.response?.headers || {};
  const headerValue = headers['retry-after'] || headers['Retry-After'];
  if (headerValue) return String(headerValue);

  const message = String(err?.message || '');
  const match = message.match(/Retry after ([0-9TZ:.+-]+)/i);
  if (match) return match[1];

  const retryMs = err?.response?.data?.error?.retry_after;
  if (retryMs != null) return String(retryMs);

  return null;
}

function googleReason(err) {
  return err?.errors?.[0]?.reason
    || err?.response?.data?.error?.errors?.[0]?.reason
    || err?.response?.data?.error?.status
    || null;
}

function identifyRateLimitSource(err) {
  if (!err) return null;

  const message = String(err.message || '').toLowerCase();
  const status = err.status || err.response?.status;
  const reason = String(googleReason(err) || '').toLowerCase();
  const requestUrl = String(err.config?.url || err.response?.config?.url || '');

  if (
    err.response?.data?.error?.type === 'rate_limit_exceeded'
    || err.response?.data?.error?.code === 'rate_limit_exceeded'
    || (requestUrl.includes('openai.com') && (status === 429 || message.includes('rate limit')))
  ) {
    return 'openai_api';
  }

  if (
    reason === 'userratelimitexceeded'
    || reason === 'ratelimitexceeded'
    || reason === 'quotaexceeded'
    || reason === 'dailylimitexceeded'
    || message.includes('user-rate limit exceeded')
    || (message.includes('rate limit') && (status === 403 || status === 429))
  ) {
    return 'gmail_api';
  }

  if (message.includes('free messages exhausted') || err.code === 'FREE_MESSAGES_EXHAUSTED') {
    return 'platform_quota';
  }

  if (message.includes('test limit reached')) {
    return 'test_mode_quota';
  }

  return null;
}

function isRateLimitError(err) {
  return Boolean(identifyRateLimitSource(err));
}

function logExternalApiError(err, context = {}) {
  const source = identifyRateLimitSource(err) || err?.source || 'unknown';
  const payload = {
    source,
    service: source,
    context,
    message: err?.message || 'Unknown error',
    status: err?.status || err?.response?.status || null,
    code: err?.code || err?.response?.data?.error?.code || null,
    reason: googleReason(err),
    retryAfter: extractRetryAfter(err),
    errors: err?.errors || err?.response?.data?.error?.errors || null,
    responseData: safeJson(err?.response?.data || null),
    stack: err?.stack || null,
  };

  if (isRateLimitError(err)) {
    console.error(`[RateLimit:${source}]`, JSON.stringify(payload));
  } else {
    console.error(`[ExternalAPI:${source}]`, JSON.stringify(payload));
  }

  return payload;
}

function enrichExternalError(err, context = {}) {
  const source = identifyRateLimitSource(err) || err?.source || context.defaultSource || 'unknown';
  const retryAfter = extractRetryAfter(err);
  const enriched = new Error(err?.message || 'External API request failed');
  enriched.name = err?.name || 'ExternalApiError';
  enriched.source = source;
  enriched.service = source;
  enriched.status = isRateLimitError(err)
    ? 429
    : (err?.status || err?.response?.status || 500);
  enriched.code = err?.code || err?.response?.data?.error?.code || null;
  enriched.reason = googleReason(err);
  enriched.retryAfter = retryAfter;
  enriched.rateLimited = isRateLimitError(err);
  enriched.context = context;
  enriched.original = err;
  enriched.details = logExternalApiError(err, context);
  return enriched;
}

function formatHttpErrorResponse(err, context = {}, fallbackMessage = 'Request failed') {
  const source = identifyRateLimitSource(err) || err?.source || 'backend';
  const rateLimited = Boolean(err?.rateLimited || isRateLimitError(err));
  const retryAfter = err?.retryAfter || extractRetryAfter(err);
  logExternalApiError(err, context);

  const status = rateLimited
    ? 429
    : (err?.status || err?.response?.status || 500);

  const serviceLabel = {
    gmail_api: 'Gmail API',
    openai_api: 'OpenAI API',
    platform_quota: 'Platform AI quota',
    test_mode_quota: 'Test mode quota',
    backend: 'Backend',
    unknown: 'External service',
  }[source] || source;

  return {
    status,
    body: {
      error: rateLimited
        ? `${serviceLabel} rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}` : ''}`
        : (err?.message || fallbackMessage),
      message: err?.message || fallbackMessage,
      source,
      service: source,
      serviceLabel,
      rateLimited,
      retryAfter,
      reason: err?.reason || googleReason(err),
      code: err?.code || err?.response?.data?.error?.code || null,
    },
  };
}

function computeBackoffUntil(err, fallbackMs = 120000) {
  const retryAfter = extractRetryAfter(err);
  if (retryAfter) {
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) return asDate;
    const asSeconds = Number(retryAfter);
    if (!Number.isNaN(asSeconds) && asSeconds > 0) {
      return Date.now() + (asSeconds * 1000);
    }
  }
  return Date.now() + fallbackMs;
}

function respondWithExternalError(res, err, context = {}, fallbackMessage = 'Request failed') {
  const formatted = formatHttpErrorResponse(err, context, fallbackMessage);
  return res.status(formatted.status).json(formatted.body);
}

module.exports = {
  identifyRateLimitSource,
  isRateLimitError,
  extractRetryAfter,
  logExternalApiError,
  enrichExternalError,
  formatHttpErrorResponse,
  computeBackoffUntil,
  respondWithExternalError,
};
