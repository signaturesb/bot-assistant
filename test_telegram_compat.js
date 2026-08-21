'use strict';

const assert = require('assert');
const fs = require('fs');

async function main() {
  const telegramModule = require('node-telegram-bot-api');
  assert.strictEqual(typeof telegramModule.TelegramBot, 'function', 'Telegram v1 CommonJS named export missing');

  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const installed = lock.packages?.['node_modules/node-telegram-bot-api'];
  assert.strictEqual(installed?.version, '1.2.0', 'Telegram dependency must stay pinned to reviewed v1.2.0');
  assert.ok(!installed?.dependencies || Object.keys(installed.dependencies).length === 0, 'Telegram v1.2.0 must not restore legacy request dependencies');
  assert.ok(!lock.packages?.['node_modules/request'], 'retired vulnerable request package still locked');

  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, body: String(options.body || '') });
    return new Response(JSON.stringify({
      ok: true,
      result: {
        message_id: 1,
        date: 1,
        chat: { id: 1, type: 'private' },
        text: 'compatibilité',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const bot = new telegramModule.TelegramBot('123456:TEST_TOKEN', {
    polling: false,
    request: { fetch: fakeFetch },
  });
  const message = await bot.sendMessage(1, 'compatibilité', {
    link_preview_options: { is_disabled: true },
  });

  assert.strictEqual(message.message_id, 1);
  assert.strictEqual(calls.length, 1, 'sendMessage must perform exactly one mocked request');
  assert.match(calls[0].url, /\/sendMessage$/);
  assert.match(calls[0].body, /link_preview_options/);

  console.log('✅ Telegram v1.2 compatibility: CommonJS, sendMessage and request removal OK');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
