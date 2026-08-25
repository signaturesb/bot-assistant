'use strict';

const crypto = require('crypto');

function getBearerToken(headers = {}) {
  const authorization = String(headers.authorization || '');
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || '';
}

function isAdminAuthorized(headers, expectedSecret) {
  const token = getBearerToken(headers);
  const expected = String(expectedSecret || '');
  if (!token || !expected) return false;
  const actualBuffer = Buffer.from(token, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

module.exports = { getBearerToken, isAdminAuthorized };
