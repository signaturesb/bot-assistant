'use strict';

function safeDetail(value) {
  return String(value || '').replace(/[\r\n\0]+/g, ' ').trim().substring(0, 180);
}

/**
 * Convertit des sondes ponctuelles en état durable et anti-bruit.
 * Une connexion critique doit échouer plusieurs fois de suite avant l'alerte.
 * Une reprise produit ensuite un seul avis de rétablissement.
 */
function evaluateConnectionResults(previous, results, options = {}) {
  const now = Number(options.now || Date.now());
  const threshold = Math.max(2, Number(options.threshold || 3));
  const recoveryThreshold = Math.max(1, Number(options.recoveryThreshold || 2));
  const cooldownMs = Math.max(60_000, Number(options.cooldownMs || 6 * 60 * 60 * 1000));
  const priorChecks = previous?.checks && typeof previous.checks === 'object' ? previous.checks : {};
  const checks = {};
  const alerts = [];
  const recoveries = [];

  for (const [name, raw] of Object.entries(results || {})) {
    const result = raw || {};
    const prior = priorChecks[name] || {};
    const ok = result.ok === true;
    const critical = result.critical !== false;
    const consecutiveFailures = ok ? 0 : (prior.ok === false ? Number(prior.consecutiveFailures || 0) + 1 : 1);
    const consecutiveSuccesses = ok ? (prior.ok === true ? Number(prior.consecutiveSuccesses || 0) + 1 : 1) : 0;
    const wasAlertActive = prior.alertActive === true;
    const alertDue = !ok && critical && consecutiveFailures >= threshold && (
      !wasAlertActive || now - Number(prior.lastAlertAt || 0) >= cooldownMs
    );

    if (alertDue) alerts.push({ name, detail: safeDetail(result.detail), consecutiveFailures });
    const recoveryConfirmed = ok && wasAlertActive && consecutiveSuccesses >= recoveryThreshold;
    if (recoveryConfirmed) recoveries.push({ name, detail: safeDetail(result.detail) });

    checks[name] = {
      ok,
      critical,
      detail: safeDetail(result.detail),
      consecutiveFailures,
      consecutiveSuccesses,
      firstFailureAt: ok ? null : (prior.firstFailureAt || now),
      lastFailureAt: ok ? (prior.lastFailureAt || null) : now,
      lastSuccessAt: ok ? now : (prior.lastSuccessAt || null),
      lastAlertAt: alertDue ? now : (prior.lastAlertAt || null),
      alertActive: recoveryConfirmed ? false : (wasAlertActive || alertDue),
    };
  }

  const criticalChecks = Object.values(checks).filter(check => check.critical);
  return {
    state: {
      lastRunAt: now,
      allCriticalOk: criticalChecks.length > 0 && criticalChecks.every(check => check.ok),
      checks,
    },
    alerts,
    recoveries,
  };
}

module.exports = { evaluateConnectionResults };
