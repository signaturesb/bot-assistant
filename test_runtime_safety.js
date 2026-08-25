#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  createNonOverlappingRunner,
  telegramPlainText,
  canUseLegacyTelegramMarkdown,
  isTelegramEntityParseError,
  timingSafeHexEqual,
  retryReadOnly,
} = require('./lib/runtime_safety');
const { gistWritesEnabled, shouldRestoreFromGist } = require('./lib/persistence_policy');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  let timeoutCount = 0;
  const fast = createNonOverlappingRunner(async () => 'ok', {
    timeoutMs: 20,
    onTimeout: () => { timeoutCount++; },
  });
  assert.deepStrictEqual(await fast.run(), { status: 'completed', value: 'ok' });
  await wait(35);
  assert.strictEqual(timeoutCount, 0, 'un cron terminé ne doit jamais produire un faux timeout');

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = createNonOverlappingRunner(() => gate, {
    timeoutMs: 15,
    onTimeout: () => { timeoutCount++; },
  });
  assert.strictEqual((await slow.run()).status, 'timeout');
  assert.strictEqual((await slow.run()).status, 'skipped_overlap');
  assert.strictEqual(timeoutCount, 1);
  release('done');
  await wait(5);
  assert.strictEqual(slow.isRunning(), false);

  assert.strictEqual(canUseLegacyTelegramMarkdown('*Titre* sans risque'), true);
  assert.strictEqual(canUseLegacyTelegramMarkdown('email_outbox'), false);
  assert.strictEqual(canUseLegacyTelegramMarkdown('*titre incomplet'), false);
  assert.strictEqual(telegramPlainText('*Alerte* `email_outbox`'), 'Alerte emailoutbox');
  assert.strictEqual(isTelegramEntityParseError(new Error("can't parse entities at byte offset 12")), true);

  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', 'secret').update('{}').digest('hex');
  assert.strictEqual(timingSafeHexEqual(expected, expected), true);
  assert.strictEqual(timingSafeHexEqual('bad', expected), false);

  let retries = 0;
  const retried = await retryReadOnly(async () => ++retries === 2 ? { ok: true } : null, {
    attempts: 2,
    isSuccess: value => value?.ok === true,
  });
  assert.deepStrictEqual(retried, { ok: true });
  assert.strictEqual(retries, 2);

  assert.strictEqual(gistWritesEnabled(true, undefined), false, 'le disque /data doit être primaire');
  assert.strictEqual(gistWritesEnabled(true, 'true'), true, 'override explicite autorisé');
  assert.strictEqual(gistWritesEnabled(false, undefined), true, 'fallback /tmp conserve le backup Gist');
  assert.strictEqual(shouldRestoreFromGist(10, undefined), false, 'ne jamais écraser des données locales');
  assert.strictEqual(shouldRestoreFromGist(0, undefined), true);
  assert.strictEqual(shouldRestoreFromGist(0, 'false'), false);

  console.log('✅ runtime safety: timeout, overlap, Telegram, HMAC et persistance OK');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
