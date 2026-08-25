'use strict';

function cleanId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isAmbiguousTransportError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '');
  return name === 'AbortError' || name === 'TimeoutError' ||
    /abort|timeout|timed out|socket|network|fetch failed|connection reset/i.test(message);
}

async function responseBody(response) {
  if (!response || typeof response !== 'object') return null;
  if (typeof response.clone === 'function') {
    try { return await response.clone().json(); } catch { return null; }
  }
  return response;
}

/**
 * A provider HTTP 2xx is only transport acceptance.  For a send operation we
 * require the provider's immutable receipt before claiming delivery.
 */
async function verifyEmailProviderReceipt(via, response) {
  const provider = String(via || '').toLowerCase();
  const status = typeof response?.status === 'number' ? response.status : undefined;
  if (typeof response?.ok === 'boolean' && !response.ok) {
    return { ok: false, outcome: 'failed', status, code: 'EMAIL_PROVIDER_REJECTED' };
  }

  const body = await responseBody(response);
  if (provider === 'gmail') {
    const id = cleanId(body?.id);
    const threadId = cleanId(body?.threadId);
    if (!id || !threadId) {
      return { ok: false, uncertain: true, outcome: 'uncertain', status,
        code: 'GMAIL_RECEIPT_MISSING', error: 'Gmail n’a pas retourné id + threadId; état à vérifier dans Messages envoyés' };
    }
    return { ok: true, outcome: 'sent', status, receipt: { id, threadId } };
  }

  if (provider === 'brevo') {
    const messageId = cleanId(body?.messageId);
    if (!messageId) {
      return { ok: false, uncertain: true, outcome: 'uncertain', status,
        code: 'BREVO_RECEIPT_MISSING', error: 'Brevo n’a pas retourné messageId; état à vérifier avant toute reprise' };
    }
    return { ok: true, outcome: 'sent', status, receipt: { messageId } };
  }

  return { ok: false, uncertain: true, outcome: 'uncertain', status,
    code: 'EMAIL_PROVIDER_UNKNOWN', error: `Fournisseur email sans règle de preuve: ${provider || 'absent'}` };
}

module.exports = { isAmbiguousTransportError, verifyEmailProviderReceipt };
