'use strict';

const assert = require('assert');
const { isAmbiguousTransportError, verifyEmailProviderReceipt } = require('./lib/email_delivery_receipt');

(async () => {
  assert.deepStrictEqual(
    await verifyEmailProviderReceipt('gmail', { id: 'g-1', threadId: 't-1' }),
    { ok: true, outcome: 'sent', status: undefined, receipt: { id: 'g-1', threadId: 't-1' } }
  );
  for (const ambiguous of [{}, { id: 'g-1' }, { threadId: 't-1' }]) {
    const proof = await verifyEmailProviderReceipt('gmail', ambiguous);
    assert.strictEqual(proof.ok, false);
    assert.strictEqual(proof.uncertain, true);
    assert.strictEqual(proof.code, 'GMAIL_RECEIPT_MISSING');
  }

  const gmailResponse = new Response(JSON.stringify({ id: 'g-2', threadId: 't-2' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  assert.strictEqual((await verifyEmailProviderReceipt('gmail', gmailResponse)).ok, true);

  const empty202 = new Response('{}', { status: 202, headers: { 'content-type': 'application/json' } });
  assert.strictEqual((await verifyEmailProviderReceipt('gmail', empty202)).uncertain, true);

  assert.strictEqual((await verifyEmailProviderReceipt('brevo', { messageId: '<b-1>' })).ok, true);
  assert.strictEqual((await verifyEmailProviderReceipt('brevo', {})).uncertain, true);
  assert.strictEqual((await verifyEmailProviderReceipt('gmail', new Response('no', { status: 500 }))).outcome, 'failed');

  assert.strictEqual(isAmbiguousTransportError(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.strictEqual(isAmbiguousTransportError(new Error('fetch failed: socket closed')), true);
  assert.strictEqual(isAmbiguousTransportError(new Error('HTTP 400')), false);

  console.log('✅ Preuve fournisseur Gmail/Brevo et états incertains OK');
})().catch(error => { console.error(error); process.exit(1); });
