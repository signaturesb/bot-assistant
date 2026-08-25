'use strict';

const PROTECTED_STATE_FILES = new Set([
  'session_live.md',
  'sessionlive.md',
  'docs/current_state.md',
  'état_système.md',
  'etat_système.md',
  'etat_systeme.md',
]);

function normalizePath(filePath) {
  return String(filePath || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function isProtectedStateFile(filePath) {
  return PROTECTED_STATE_FILES.has(normalizePath(filePath));
}

function normalizeSha(value) {
  const match = String(value || '').trim().match(/^[0-9a-f]{7,40}$/i);
  return match ? match[0].toLowerCase() : '';
}

function messageExplicitlyAuthorizesGitHubWrite(message, filePath) {
  const current = String(message || '').toLowerCase();
  const explicitWrite = /\b(?:écris|ecris|modifie|mets à jour|met à jour|commit|publie)\b/i.test(current);
  if (!explicitWrite || !/\bgithub\b/i.test(current)) return false;
  const filename = normalizePath(filePath).split('/').pop() || '';
  const compactMessage = current.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const compactFilename = filename.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const compactStem = compactFilename.replace(/(?:md|txt|json|ya?ml)$/, '');
  return Boolean(compactFilename && (compactMessage.includes(compactFilename) || (compactStem && compactMessage.includes(compactStem))));
}

function extractActiveDeploymentClaim(content) {
  const text = String(content || '');
  const pluralClaim = /commits?\s+(?:confirmés?\s+[^\n]{0,30})?(?:déployés?|actifs?)/i.test(text)
    && (text.match(/\b[0-9a-f]{7,40}\b/ig) || []).length > 1;
  if (pluralClaim) {
    return { ambiguous: true, sha: '', reason: 'plusieurs commits sont présentés comme actifs ou déployés' };
  }

  const patterns = [
    /commit\s+applicatif\s+déployé\s*:\s*`?([0-9a-f]{7,40})`?/i,
    /(?:dernier\s+)?commit\s+(?:de\s+production|actif|déployé)\s*:\s*`?([0-9a-f]{7,40})`?/i,
    /(?:production|version\s+active)\s*:\s*`?([0-9a-f]{7,40})`?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { ambiguous: false, sha: normalizeSha(match[1]), reason: '' };
  }
  return { ambiguous: false, sha: '', reason: '' };
}

function shasMatch(claimed, observed) {
  const a = normalizeSha(claimed);
  const b = normalizeSha(observed);
  if (!a || !b) return false;
  const min = Math.min(a.length, b.length);
  return min >= 7 && a.slice(0, min) === b.slice(0, min);
}

async function verifyProtectedStateWrite({ filePath, content, fetchImpl = global.fetch, productionUrl }) {
  if (!isProtectedStateFile(filePath)) return { ok: true, protected: false };

  const claim = extractActiveDeploymentClaim(content);
  if (claim.ambiguous) {
    return { ok: false, protected: true, code: 'AMBIGUOUS_DEPLOYMENT_CLAIM', reason: claim.reason };
  }
  if (!claim.sha) return { ok: true, protected: true, claim: null };
  if (typeof fetchImpl !== 'function') {
    return { ok: false, protected: true, code: 'VERSION_CHECK_UNAVAILABLE', claim: claim.sha };
  }

  const base = String(productionUrl || '').replace(/\/$/, '');
  if (!/^https:\/\//i.test(base)) {
    return { ok: false, protected: true, code: 'INVALID_PRODUCTION_URL', claim: claim.sha };
  }

  try {
    const response = await fetchImpl(`${base}/version`, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      return { ok: false, protected: true, code: 'VERSION_HTTP_ERROR', status: response.status, claim: claim.sha };
    }
    const body = await response.json();
    const observed = normalizeSha(body?.commit);
    if (!shasMatch(claim.sha, observed)) {
      return { ok: false, protected: true, code: 'VERSION_MISMATCH', claim: claim.sha, observed: observed || 'unknown' };
    }
    return { ok: true, protected: true, claim: claim.sha, observed };
  } catch (error) {
    return { ok: false, protected: true, code: 'VERSION_CHECK_FAILED', claim: claim.sha, reason: error.message };
  }
}

module.exports = {
  extractActiveDeploymentClaim,
  isProtectedStateFile,
  messageExplicitlyAuthorizesGitHubWrite,
  normalizePath,
  shasMatch,
  verifyProtectedStateWrite,
};
