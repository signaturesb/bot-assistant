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
  // Fail closed: a subject/body mentioning Centris is not proof that the
  // message was sent by Centris. This prevents an unrelated message from
  // injecting a wrong six-digit value during the short MFA polling window.
  if (!/@(?:[a-z0-9-]+\.)*centris\.ca\b/i.test(String(from))) return null;
  if (!/centris|matrix|authentification|v[ée]rification|security/i.test(`${subject} ${body}`)) return null;
  const match = String(body).match(/(?:code|v[ée]rification|authentification|security)[^0-9]{0,80}\b(\d{6})\b/i) ||
    String(body).match(/\b(\d{6})\b[^a-z0-9]{0,80}(?:code|v[ée]rification|authentification)/i);
  return match?.[1] || null;
}

module.exports = { gmailBodyText, extractCentrisMfaCode };
