'use strict';

function gmailBodyText(payload, snippet = '') {
  const chunks = [String(snippet || '')];
  const visit = part => {
    if (!part) return;
    if (part.body?.data) {
      try { chunks.push(Buffer.from(part.body.data, 'base64url').toString('utf8')); } catch {}
    }
    for (const child of part.parts || []) visit(child);
  };
  visit(payload);
  return chunks.join(' ');
}

function extractCentrisMfaCode({ from = '', subject = '', body = '' } = {}) {
  const context = `${from} ${subject} ${body}`;
  const isCentris = /centris|matrix/i.test(context) &&
    (/@(?:[a-z0-9-]+\.)*centris\.ca\b/i.test(from) || /centris|matrix/i.test(subject));
  if (!isCentris) return null;
  const match = String(body).match(/(?:code|v[ée]rification|authentification|security)[^0-9]{0,80}\b(\d{6})\b/i) ||
    String(body).match(/\b(\d{6})\b[^a-z0-9]{0,80}(?:code|v[ée]rification|authentification)/i);
  return match?.[1] || null;
}

module.exports = { gmailBodyText, extractCentrisMfaCode };
