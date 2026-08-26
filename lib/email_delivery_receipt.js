'use strict';

function cleanId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function metadataHeaders(message) {
  const headers = Array.isArray(message?.payload?.headers) ? message.payload.headers : [];
  const result = new Map();
  for (const header of headers) {
    const name = String(header?.name || '').trim().toLowerCase();
    if (name) result.set(name, String(header?.value || '').trim());
  }
  return result;
}

function headerEmails(value) {
  return [...String(value || '').matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map(match => match[0].toLowerCase());
}

/**
 * A send receipt only proves Gmail accepted the API request. This second,
 * read-only check proves the exact message exists in the authenticated
 * account's Sent folder and that its To header contains the expected address.
 * It deliberately does not claim that an external recipient opened or even
 * received the message; Gmail does not expose the recipient's mailbox.
 */
function verifyGmailSentMetadata(message, expectedTo) {
  const id = cleanId(message?.id);
  const labels = new Set(Array.isArray(message?.labelIds) ? message.labelIds.map(String) : []);
  const headers = metadataHeaders(message);
  const to = String(expectedTo || '').trim().toLowerCase();
  const recipients = headerEmails(headers.get('to'));
  if (!id) return { ok: false, code: 'GMAIL_SENT_MESSAGE_ID_MISSING' };
  if (!labels.has('SENT')) return { ok: false, code: 'GMAIL_SENT_LABEL_MISSING', id };
  if (!to || !recipients.includes(to)) {
    return { ok: false, code: 'GMAIL_SENT_RECIPIENT_MISMATCH', id, recipients };
  }
  return {
    ok: true,
    state: 'sent_folder_verified',
    id,
    recipients,
    inboxVisible: labels.has('INBOX'),
    rfc822MessageId: cleanId(headers.get('message-id')),
  };
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

module.exports = { isAmbiguousTransportError, verifyEmailProviderReceipt, verifyGmailSentMetadata };
