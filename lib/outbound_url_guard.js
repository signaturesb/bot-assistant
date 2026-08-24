'use strict';
const dns = require('dns').promises;
const net = require('net');
const CENTRIS_SESSION_HOSTS = new Set(['matrix.centris.ca', 'zone.centris.ca']);
const SECRET_TEST_TARGETS = Object.freeze({
  OPENAI_API_KEY: Object.freeze({ url: 'https://api.openai.com/v1/models', header: 'Authorization', prefix: 'Bearer ' }),
  FIRECRAWL_API_KEY: Object.freeze({ url: 'https://api.firecrawl.dev/v1/scrape', header: 'Authorization', prefix: 'Bearer ' }),
});
function parseStrictHttpsUrl(rawUrl, allowedHosts = null) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '')); } catch { throw new Error('URL_INVALIDE'); }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (parsed.protocol !== 'https:') throw new Error('HTTPS_REQUIS');
  if (parsed.username || parsed.password) throw new Error('IDENTIFIANTS_URL_INTERDITS');
  if (parsed.port && parsed.port !== '443') throw new Error('PORT_INTERDIT');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || net.isIP(host)) throw new Error('HOTE_INTERDIT');
  if (allowedHosts && !allowedHosts.has(host)) throw new Error('HOTE_NON_AUTORISE');
  return parsed;
}
function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(value)) {
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('::ffff:127.') ||
      value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.') || value.startsWith('::ffff:169.254.');
  }
  return true;
}
async function assertPublicHttpsUrl(rawUrl, lookup = dns.lookup) {
  const parsed = parseStrictHttpsUrl(rawUrl);
  const answers = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (!Array.isArray(answers) || answers.length === 0) throw new Error('DNS_SANS_RESULTAT');
  if (answers.some(answer => isPrivateAddress(answer.address))) throw new Error('ADRESSE_PRIVEE_INTERDITE');
  return parsed;
}
function validateCentrisSessionUrl(rawUrl) { return parseStrictHttpsUrl(rawUrl, CENTRIS_SESSION_HOSTS); }
function secretTestTarget(key, requestedUrl, requestedHeader) {
  const target = SECRET_TEST_TARGETS[String(key || '')];
  if (!target) throw new Error('TEST_NON_SUPPORTE_POUR_CETTE_CLE');
  if (requestedUrl && String(requestedUrl) !== target.url) throw new Error('TEST_URL_NON_AUTORISEE');
  if (requestedHeader && String(requestedHeader).toLowerCase() !== target.header.toLowerCase()) throw new Error('TEST_HEADER_NON_AUTORISE');
  return target;
}
async function fetchWithValidatedRedirects(rawUrl, fetchImpl, options, validateUrl, maxRedirects = 5) {
  let current = await validateUrl(rawUrl);
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetchImpl(current.toString(), { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects === maxRedirects) throw new Error('TROP_DE_REDIRECTIONS');
    current = await validateUrl(new URL(location, current).toString());
  }
  throw new Error('TROP_DE_REDIRECTIONS');
}
module.exports = { parseStrictHttpsUrl, isPrivateAddress, assertPublicHttpsUrl, validateCentrisSessionUrl, secretTestTarget, fetchWithValidatedRedirects };
