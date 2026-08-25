'use strict';

const assert = require('assert');
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
  console.log('✅ Téléchargement PDF Matrix par navigation authentifiée validé');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
