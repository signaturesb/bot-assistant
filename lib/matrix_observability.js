'use strict';

const crypto = require('crypto');

const SAFE_ERROR_CODE_RE = /^[A-Z0-9][A-Z0-9_:-]{2,79}$/;
const SAFE_STAGE_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const SAFE_RESULT_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const NUMERIC_EXTRA_KEYS = new Set([
  'document_count',
  'failure_count',
  'duration_ms',
]);

let state = { enabled: false, sdk: null, reason: 'NOT_INITIALIZED' };

function safeToken(value, pattern, fallback) {
  const token = String(value || '').trim();
  return pattern.test(token) ? token : fallback;
}

function errorCode(error, explicitCode = '') {
  const candidate = String(explicitCode || error?.code || '').trim().toUpperCase();
  if (SAFE_ERROR_CODE_RE.test(candidate)) return candidate;
  const safeName = String(error?.name || 'ERROR').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return safeToken(`MATRIX_${safeName}`, SAFE_ERROR_CODE_RE, 'MATRIX_WORKFLOW_ERROR');
}

function correlationId({ requestId = '', centrisNum = '' } = {}) {
  const seed = `${String(requestId || '')}|${String(centrisNum || '').replace(/\D/g, '')}`;
  if (seed === '|') return 'unknown';
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 20);
}

// Allowlist stricte: même si un futur appelant ajoute accidentellement un
// courriel, une adresse ou le texte d'une exception, ces valeurs ne quittent
// jamais le processus. Les traces et breadcrumbs sont retirés eux aussi.
function redactMatrixEvent(event = {}) {
  const safeEvent = { ...event };
  delete safeEvent.user;
  delete safeEvent.request;
  delete safeEvent.breadcrumbs;
  delete safeEvent.contexts;
  delete safeEvent.modules;
  delete safeEvent.server_name;
  delete safeEvent.transaction;

  const incomingTags = event.tags || {};
  safeEvent.tags = {
    workflow: 'matrix-pdf-email',
    stage: safeToken(incomingTags.stage, SAFE_STAGE_RE, 'unknown'),
    error_code: safeToken(incomingTags.error_code, SAFE_ERROR_CODE_RE, 'MATRIX_WORKFLOW_ERROR'),
    result: safeToken(incomingTags.result, SAFE_RESULT_RE, 'failed'),
    correlation_id: /^[a-f0-9]{20}$/.test(String(incomingTags.correlation_id || ''))
      ? String(incomingTags.correlation_id)
      : 'unknown',
  };

  safeEvent.extra = {};
  for (const key of NUMERIC_EXTRA_KEYS) {
    const value = Number(event.extra?.[key]);
    if (Number.isFinite(value) && value >= 0) safeEvent.extra[key] = value;
  }

  const code = safeEvent.tags.error_code;
  safeEvent.message = code;
  if (safeEvent.exception?.values) {
    safeEvent.exception = {
      values: safeEvent.exception.values.slice(0, 1).map(() => ({
        type: 'MatrixWorkflowError',
        value: code,
      })),
    };
  }
  return safeEvent;
}

function initMatrixObservability({ env = process.env, sentry = null } = {}) {
  const dsn = String(env.SENTRY_DSN || '').trim();
  if (!dsn) {
    state = { enabled: false, sdk: null, reason: 'SENTRY_DSN_MISSING' };
    return { enabled: false, reason: state.reason };
  }

  try {
    const sdk = sentry || require('@sentry/node');
    sdk.init({
      dsn,
      environment: String(env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'production').substring(0, 64),
      release: String(env.SENTRY_RELEASE || env.RENDER_GIT_COMMIT || '').substring(0, 128) || undefined,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      attachStacktrace: false,
      beforeSend: redactMatrixEvent,
    });
    state = { enabled: true, sdk, reason: 'READY' };
    return { enabled: true, reason: state.reason };
  } catch {
    state = { enabled: false, sdk: null, reason: 'SENTRY_INIT_FAILED' };
    return { enabled: false, reason: state.reason };
  }
}

function captureMatrixWorkflowError(error, context = {}) {
  if (!state.enabled || !state.sdk) return false;
  try {
    const code = errorCode(error, context.errorCode);
    const stage = safeToken(context.stage, SAFE_STAGE_RE, 'unknown');
    const result = safeToken(context.result, SAFE_RESULT_RE, 'failed');
    const correlation = correlationId(context);
    state.sdk.withScope((scope) => {
      scope.setTags({
        workflow: 'matrix-pdf-email',
        stage,
        error_code: code,
        result,
        correlation_id: correlation,
      });
      const extras = {};
      for (const key of NUMERIC_EXTRA_KEYS) {
        const value = Number(context[key]);
        if (Number.isFinite(value) && value >= 0) extras[key] = value;
      }
      scope.setExtras(extras);
      state.sdk.captureMessage(code, 'error');
    });
    return true;
  } catch {
    return false;
  }
}

function resetMatrixObservabilityForTests() {
  state = { enabled: false, sdk: null, reason: 'NOT_INITIALIZED' };
}

module.exports = {
  initMatrixObservability,
  captureMatrixWorkflowError,
  _correlationId: correlationId,
  _redactMatrixEvent: redactMatrixEvent,
  _resetForTests: resetMatrixObservabilityForTests,
};
