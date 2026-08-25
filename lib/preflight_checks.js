'use strict';

const crypto = require('crypto');
const { timingSafeHexEqual } = require('./runtime_safety');

function evaluateSmsHmacSelfTest(secret) {
  const value = String(secret || '');
  if (!value) return { ok: false, detail: 'secret absent ou comparaison invalide' };

  const body = '{"probe":true}';
  const good = crypto.createHmac('sha256', value).update(body).digest('hex');
  const bad = `${good[0] === '0' ? '1' : '0'}${good.slice(1)}`;
  const ok = timingSafeHexEqual(good, good) && !timingSafeHexEqual(bad, good);
  return {
    ok,
    detail: ok
      ? 'comparaison cryptographique locale OK · mauvais token refusé par la route SMS (401 attendu)'
      : 'secret absent ou comparaison invalide',
  };
}

function evaluateActiveTemplate(validation) {
  if (!validation?.ok) {
    return {
      ok: false,
      detail: `invalide: ${(validation?.errors || ['indisponible']).join(', ').substring(0, 140)}`,
    };
  }
  return {
    ok: true,
    detail: `structure active OK · sha256 ${validation.sha256.slice(0, 12)} · ${Math.round(validation.bytes / 1024)}KB`,
  };
}

module.exports = { evaluateSmsHmacSelfTest, evaluateActiveTemplate };
