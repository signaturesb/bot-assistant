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
  let trustedAnchorClicked = false;
  const popup = { async close() { popupClosed = true; } };
  const opener = {
    url: () => navigation.options.referer,
    locator(selector) {
      assert.match(selector, /media\.ashx/);
      return {
        count: async () => 1,
        nth() {
          return {
            getAttribute: async () => 'https://mediaserver.centris.ca/media.ashx?id=popup',
            async click() {
              trustedAnchorClicked = true;
              popupContext.emit('response', {
                url: () => 'https://mediaserver.centris.ca/media.ashx?id=popup',
                headers: () => ({ 'content-type': 'application/pdf' }),
                body: async () => pdf,
              });
            },
          };
        },
      };
    },
    async waitForEvent(event) { assert.strictEqual(event, 'popup'); return popup; },
  };
  const popupResult = await cua._downloadMatrixPdfInBrowser(
    popupContext,
    'https://mediaserver.centris.ca/media.ashx?id=popup',
    navigation.options.referer,
    opener,
  );
  assert.deepStrictEqual(popupResult, pdf);
  assert.strictEqual(trustedAnchorClicked, true, 'le vrai lien Matrix doit être cliqué');
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
  let oversizedFallbackPages = 0;
  const authenticatedOversizedContext = {
    request: {
      async get() {
        return { ok: () => true, status: () => 200, headers: () => ({ 'content-length': String(26 * 1024 * 1024) }) };
      },
    },
    async newPage() { oversizedFallbackPages += 1; throw new Error('fallback interdit'); },
  };
  await assert.rejects(
    () => cua._downloadMatrixPdfAuthenticated(
      authenticatedOversizedContext,
      'https://mediaserver.centris.ca/media.ashx?id=oversized-direct',
      navigation.options.referer,
    ),
    /MATRIX_DOCUMENT_TOO_LARGE/,
  );
  assert.strictEqual(oversizedFallbackPages, 0, 'un fichier trop volumineux ne doit pas ouvrir un onglet Browserless');
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
  const actionContext = new EventEmitter();
  let actionClicks = 0;
  const actionPage = {
    frames() {
      return [{
        locator(selector) {
          assert.strictEqual(selector, 'xpath=//*[@id="ctl00_DV_Link"]');
          return {
            first() { return this; },
            async isVisible() { return true; },
            async click() {
              actionClicks += 1;
              actionContext.emit('response', {
                url: () => 'https://mediaserver.centris.ca/media.ashx?id=dv',
                headers: () => ({ 'content-type': 'application/pdf', 'content-length': String(pdf.length) }),
                body: async () => pdf,
              });
            },
          };
        },
      }];
    },
  };
  assert.deepStrictEqual(
    await cua._downloadMatrixPdfByAction(actionContext, actionPage, 'ctl00_DV_Link'),
    pdf,
    'une DV ASP.NET sans URL directe doit être téléchargée par son vrai clic',
  );
  assert.strictEqual(actionClicks, 1);
  assert.strictEqual(cua._isMatrixDocumentRetryable(new Error('MATRIX_DOCUMENT_TOO_LARGE')), false);
  assert.strictEqual(cua._isMatrixDocumentRetryable(new Error('MATRIX_DOCUMENT_URL_REJECTED')), false);
  assert.strictEqual(cua._isMatrixDocumentRetryable(new Error('MATRIX_DOCUMENT_ACTION_MISSING')), false);
  assert.strictEqual(cua._isMatrixDocumentRetryable(new Error('MATRIX_DOCUMENT_PDF_TIMEOUT:wrapper=html')), true);
  assert.strictEqual(cua._isMatrixDocumentRetryable(new Error('ECONNRESET')), true);
  console.log('✅ Téléchargement PDF Matrix par navigation authentifiée validé');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
