'use strict';

const assert = require('assert');
const cua = require('./cua_driver');

(async () => {
  const input = Buffer.from('%PDF-test');

  const v1 = async (buffer) => {
    assert.strictEqual(buffer, input);
    return { text: 'v1', numpages: 1 };
  };
  assert.deepStrictEqual(await cua._parsePdfBufferWithModule(v1, input), { text: 'v1', numpages: 1 });

  let destroyed = false;
  class PDFParse {
    constructor({ data }) { assert.strictEqual(data, input); }
    async getText() { return { text: 'v2', total: 2, pages: [{}, {}] }; }
    async destroy() { destroyed = true; }
  }
  assert.deepStrictEqual(
    await cua._parsePdfBufferWithModule({ PDFParse }, input),
    { text: 'v2', total: 2, pages: [{}, {}] },
  );
  assert.strictEqual(destroyed, true, 'le parseur v2 doit toujours être détruit');

  await assert.rejects(
    cua._parsePdfBufferWithModule({}, input),
    /API pdf-parse non supportée/,
  );

  console.log('✅ Compatibilité pdf-parse v1/v2 + libération mémoire OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
