'use strict';

const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'pdf-lib') return { PDFDocument: { load: async (buffer) => {
    const text = Buffer.from(buffer).toString('latin1');
    if (text.includes('CORRUPT')) throw new Error('invalid object');
    const count = Number(text.match(/\/Count\s+(\d+)/)?.[1] || 0);
    return { getPageCount: () => count };
  } } };
  return originalLoad.call(this, request, parent, isMain);
};
const { inspectPdfEnvelope, validatePdfBuffer } = require('./lib/pdf_validation');

(async () => {
  const valid = Buffer.from(`%PDF-1.7\n%${'fixture'.repeat(20)}\n1 0 obj <</Type /Pages /Count 2>> endobj\nstartxref\n0\n%%EOF\n`);
  const checked = await validatePdfBuffer(valid);
  assert.strictEqual(checked.pageCount, 2);
  assert.match(checked.sha256, /^[a-f0-9]{64}$/);
  assert.strictEqual(checked.bytes, valid.length);

  const bomAndWhitespace = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0x0a]), valid]);
  const normalized = await validatePdfBuffer(bomAndWhitespace);
  assert.strictEqual(normalized.buffer[0], 0x25, 'le préfixe bénin est retiré avant hash et envoi');
  assert.strictEqual(normalized.sha256, checked.sha256);

  assert.throws(() => inspectPdfEnvelope(Buffer.concat([Buffer.from('<html>login</html>'), valid])), /PDF_UNSAFE_PREFIX/);
  assert.throws(() => inspectPdfEnvelope(Buffer.from('<html>%PDF-1.7 login</html>')), /PDF_TOO_SMALL|PDF_UNSAFE_PREFIX|PDF_EOF_MISSING/);
  assert.throws(() => inspectPdfEnvelope(valid.subarray(0, valid.length - 8)), /PDF_EOF_MISSING/);
  assert.throws(() => inspectPdfEnvelope(Buffer.concat([valid, Buffer.alloc(128)]), { maxBytes: valid.length }), /PDF_TOO_LARGE/);

  const corrupt = Buffer.from(`%PDF-1.7\n%${'x'.repeat(80)}\nCORRUPT /Count 2\n%%EOF\n`);
  await assert.rejects(() => validatePdfBuffer(corrupt), /PDF_CORRUPT|PDF_PAGE_COUNT_INVALID/);

  const encryptedMarker = Buffer.from(`%PDF-1.7\n%${'x'.repeat(80)}\n1 0 obj <</Encrypt 2 0 R /Count 1>> endobj\n%%EOF`);
  await assert.rejects(() => validatePdfBuffer(encryptedMarker), /PDF_ENCRYPTED/);
  const protectedMatrixPdf = await validatePdfBuffer(encryptedMarker, { allowEncrypted: true });
  assert.strictEqual(protectedMatrixPdf.encrypted, true);
  assert.strictEqual(protectedMatrixPdf.pageCount, 1);
  Module._load = originalLoad;
  console.log('✅ Validation PDF réelle: enveloppe, pages, corruption, chiffrement, hash et limites OK');
})().catch((error) => { console.error(error); process.exit(1); });
