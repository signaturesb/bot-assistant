'use strict';

const assert = require('assert');
const {
  initMatrixObservability,
  captureMatrixWorkflowError,
  _correlationId,
  _redactMatrixEvent,
  _resetForTests,
} = require('./lib/matrix_observability');

const dirtyEvent = {
  message: 'client@example.com 440, rue Exemple',
  user: { email: 'client@example.com' },
  request: { url: 'https://example.test/?email=client@example.com' },
  breadcrumbs: [{ message: 'PDF confidentiel' }],
  contexts: { client: { phone: '5145551212' } },
  modules: { secret: '1' },
  server_name: 'private-host',
  transaction: 'client@example.com',
  tags: {
    stage: 'matrix-download',
    error_code: 'MATRIX_DOWNLOAD_FAILED',
    result: 'failed',
    correlation_id: 'a'.repeat(20),
    email: 'client@example.com',
  },
  extra: {
    document_count: 7,
    failure_count: 1,
    duration_ms: 1234,
    address: '440, rue Exemple',
  },
  exception: { values: [{ type: 'Error', value: 'client@example.com', stacktrace: { frames: [] } }] },
};
const redacted = _redactMatrixEvent(dirtyEvent);
const serialized = JSON.stringify(redacted);
assert.doesNotMatch(serialized, /client@example\.com|440, rue Exemple|5145551212|PDF confidentiel|private-host/);
assert.deepStrictEqual(Object.keys(redacted.tags).sort(), [
  'correlation_id', 'error_code', 'result', 'stage', 'workflow',
]);
assert.deepStrictEqual(redacted.extra, { document_count: 7, failure_count: 1, duration_ms: 1234 });
assert.strictEqual(redacted.message, 'MATRIX_DOWNLOAD_FAILED');

assert.strictEqual(_correlationId({ requestId: 'mx-1', centrisNum: '28936167' }).length, 20);
assert.notStrictEqual(
  _correlationId({ requestId: 'mx-1', centrisNum: '28936167' }),
  _correlationId({ requestId: 'mx-2', centrisNum: '28936167' }),
);

_resetForTests();
assert.deepStrictEqual(initMatrixObservability({ env: {} }), {
  enabled: false, reason: 'SENTRY_DSN_MISSING',
});
assert.strictEqual(captureMatrixWorkflowError(new Error('client@example.com'), {
  stage: 'matrix-download', requestId: 'mx-1', centrisNum: '28936167',
}), false, 'Sentry absent ne doit jamais bloquer le workflow');

const captured = {};
const mockSentry = {
  init(options) { captured.init = options; },
  withScope(callback) {
    callback({
      setTags(tags) { captured.tags = tags; },
      setExtras(extras) { captured.extras = extras; },
    });
  },
  captureMessage(message, level) { captured.message = message; captured.level = level; },
};
assert.strictEqual(initMatrixObservability({
  env: { SENTRY_DSN: 'https://public@example.invalid/1', NODE_ENV: 'test' },
  sentry: mockSentry,
}).enabled, true);
assert.strictEqual(captured.init.sendDefaultPii, false);
assert.strictEqual(captured.init.tracesSampleRate, 0);
assert.strictEqual(captureMatrixWorkflowError(
  Object.assign(new Error('client@example.com 440 rue Exemple'), { code: 'MATRIX_PDF_INVALID' }),
  {
    stage: 'pdf-validation', requestId: 'mx-123', centrisNum: '28936167',
    document_count: 9, failure_count: 1, recipient: 'client@example.com',
  },
), true);
assert.strictEqual(captured.message, 'MATRIX_PDF_INVALID');
assert.strictEqual(captured.tags.stage, 'pdf-validation');
assert.match(captured.tags.correlation_id, /^[a-f0-9]{20}$/);
assert.deepStrictEqual(captured.extras, { document_count: 9, failure_count: 1 });
assert.doesNotMatch(JSON.stringify(captured), /client@example\.com|440 rue Exemple|28936167/);

_resetForTests();
console.log('✅ Sentry Matrix: erreurs corrélées sans courriel, adresse, téléphone, PDF ni traces');
