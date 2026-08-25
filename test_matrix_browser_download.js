'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const cua = require('./cua_driver');

const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1500, 1)]);
let closed = false;
let navigation = null;
const context = {
  async newPage() {
    return {
      async goto(url, options) {
        navigation = { url, options };
        return {
          ok: () => true,
          status: () => 200,
          headers: () => ({ 'content-type': 'application/pdf' }),
          body: async () => pdf,
        };
      },
      async close() { closed = true; },
    };
  },
};

(async () => {
  const result = await cua._downloadMatrixPdfInBrowser(
    context,
    'https://mediaserver.centris.ca/media.ashx?t=di&id=abc',
    'https://matrix.centris.ca/Matrix/Results.aspx?c=xyz'
  );
  assert.deepStrictEqual(result, pdf);
  assert.strictEqual(navigation.options.referer, 'https://matrix.centris.ca/Matrix/Results.aspx?c=xyz');
  assert.strictEqual(navigation.options.waitUntil, 'commit');
  assert.strictEqual(closed, true);

  const popupContext = new EventEmitter();
  let popupClosed = false;
  const popup = { async close() { popupClosed = true; } };
  const opener = {
    async waitForEvent(event) { assert.strictEqual(event, 'popup'); return popup; },
    async evaluate(_fn, href) {
      assert.match(href, /^https:\/\/mediaserver\.centris\.ca\//);
      popupContext.emit('response', {
        url: () => href,
        headers: () => ({ 'content-type': 'application/pdf' }),
        body: async () => pdf,
      });
    },
  };
  const popupResult = await cua._downloadMatrixPdfInBrowser(
    popupContext,
    'https://mediaserver.centris.ca/media.ashx?id=popup',
    navigation.options.referer,
    opener,
  );
  assert.deepStrictEqual(popupResult, pdf);
  assert.strictEqual(popupClosed, true, 'le popup Matrix doit être fermé');
  const oversizedContext = {
    async newPage() {
      return {
        async goto() {
          return { ok: () => true, status: () => 200, headers: () => ({ 'content-type': 'application/pdf', 'content-length': String(26 * 1024 * 1024) }), body: async () => pdf };
        },
        async close() {},
      };
    },
  };
  await assert.rejects(
    () => cua._downloadMatrixPdfInBrowser(oversizedContext, 'https://mediaserver.centris.ca/media.ashx?id=large', navigation.options.referer),
    /MATRIX_DOCUMENT_TOO_LARGE/
  );
  await assert.rejects(
    () => cua._downloadMatrixPdfInBrowser(context, 'https://example.com/file.pdf', navigation.options.referer),
    /MATRIX_DOCUMENT_URL_REJECTED/
  );
  const ordered = await cua._mapWithConcurrency([1, 2, 3, 4], 2, async (value) => value * 2);
  assert.deepStrictEqual(ordered, [2, 4, 6, 8]);
  const authenticatedContext = {
    request: {
      async get(url, options) {
        assert.match(url, /^https:\/\/mediaserver\.centris\.ca\//);
        assert.strictEqual(options.headers.Referer, navigation.options.referer);
        return { ok: () => true, status: () => 200, headers: () => ({ 'content-type': 'application/pdf' }), body: async () => pdf };
      },
    },
    async newPage() { throw new Error('fallback navigateur ne doit pas être utilisé'); },
  };
  assert.deepStrictEqual(
    await cua._downloadMatrixPdfAuthenticated(authenticatedContext, 'https://mediaserver.centris.ca/media.ashx?id=direct', navigation.options.referer),
    pdf
  );
  const authenticatedFallbackContext = new EventEmitter();
  authenticatedFallbackContext.request = {
    async get() {
      return { ok: () => true, status: () => 200, headers: () => ({ 'content-type': 'text/html' }), body: async () => Buffer.from('<html>wrapper</html>') };
    },
  };
  const fallbackOpener = {
    async waitForEvent() { return { async close() {} }; },
    async evaluate(_fn, href) {
      authenticatedFallbackContext.emit('response', {
        url: () => href,
        headers: () => ({ 'content-type': 'application/pdf' }),
        body: async () => pdf,
      });
    },
  };
  assert.deepStrictEqual(
    await cua._downloadMatrixPdfAuthenticated(
      authenticatedFallbackContext,
      'https://mediaserver.centris.ca/media.ashx?id=fallback',
      navigation.options.referer,
      fallbackOpener,
    ),
    pdf,
    'une réponse API enveloppée doit basculer vers le clic authentifié Matrix',
  );
  console.log('✅ Téléchargement PDF Matrix par navigation authentifiée validé');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
