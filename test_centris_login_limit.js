'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createCentrisLoginLimit } = require('./lib/centris_login_limit');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'centris-limit-'));

(async () => {
  const file = path.join(dir, 'limit.json');
  let guard = createCentrisLoginLimit(file);
  let calls = 0, alerts = 0;
  const failure = async () => { calls++; throw new Error('network failed'); };
  const alert = async () => { alerts++; };
  for (let i = 0; i < 3; i++) {
    await assert.rejects(guard.run(failure, alert), /network failed/);
    guard = createCentrisLoginLimit(file); // fresh process, same persistent disk
  }
  for (let i = 0; i < 10; i++) await assert.rejects(guard.run(failure, alert), /CENTRIS_LOGIN_STOPPED/);
  assert.equal(calls, 3);
  assert.equal(alerts, 1);
  guard.reset();
  await guard.run(async () => { calls++; return 'authenticated'; });
  assert.equal(guard.read().attempts, 0);
  assert.equal(calls, 4);
  let release;
  const active = guard.run(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(guard.run(failure), /IN_PROGRESS/);
  assert.throws(() => guard.reset(), /IN_PROGRESS/);
  release('authenticated'); await active;
  fs.writeFileSync(file, '{broken');
  await assert.rejects(createCentrisLoginLimit(file).run(failure), /STOPPED/);
  assert.equal(calls, 4);
  const invalidPath = createCentrisLoginLimit(path.join(dir, 'missing', 'state'));
  await assert.rejects(invalidPath.run(failure));
  assert.equal(calls, 4, 'persistence failure must prevent network call');

  const cua = require('./cua_driver');
  assert.equal(cua._classifyCentrisLoginSnapshot({ url: 'https://accounts.centris.ca/account/expiring-password?secret=hidden', passwordVisible: 3, mfaVisible: 1 }), 'password-renewal');
  assert.equal(cua._classifyCentrisLoginSnapshot({ url: 'https://untrusted.invalid/account/expiring-password', passwordVisible: 3 }), 'missing');

  // Exercise the real dispatch prefix with controlled dependencies: even an old
  // confirmed native action must produce a fresh PDF preview, never a send.
  const source = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
  const start = source.indexOf('async function executeTool(');
  const end = source.indexOf('    const pdAction =', start);
  const dispatch = source.slice(start, end) + "return 'other'; } catch(e) { throw e; } }";
  let preview, saved = 0;
  const pending = new Map([[1, { name: 'envoyer_fiche_centris_native', inFlight: true }]]);
  const context = vm.createContext({ pendingExternalEmailActions: pending, savePendingEmailState: () => saved++, executeMatrixAnnexesTool: async input => { preview = input; return 'preview'; } });
  vm.runInContext(dispatch + '; this.dispatch = executeTool;', context);
  assert.equal(await context.dispatch('envoyer_fiche_centris_native', { centris_num: '12345678', email: 'client@example.com' }, 1, 'envoie', { confirmedExternalEmail: true }), 'preview');
  assert.equal(preview.userMessage, '', 'old confirmation cannot authorize a new send');
  assert.equal(preview.num, '12345678');
  assert.equal(preview.emailDestination, 'client@example.com');
  assert.equal(pending.size, 0);
  assert.equal(saved, 1);
  console.log('✅ Three-attempt persistence, concurrency, reset, renewal detection and PDF preview routing');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
