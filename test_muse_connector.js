'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildMuseMcpResponse,
  getMuseConnectorToken,
  isMuseConnectorAuthorized,
} = require('./lib/muse_connector');

const connectorSecret = 'muse-test-secret-that-is-at-least-32-bytes-long';

assert.deepStrictEqual(
  getMuseConnectorToken({ authorization: `Bearer ${connectorSecret}` }),
  { token: connectorSecret, source: 'bearer' },
);
assert.deepStrictEqual(
  getMuseConnectorToken({ 'x-api-key': connectorSecret }),
  { token: connectorSecret, source: 'x-api-key' },
);
assert.strictEqual(
  isMuseConnectorAuthorized({ 'x-api-key': connectorSecret }, connectorSecret).authorized,
  true,
);
assert.strictEqual(
  isMuseConnectorAuthorized({ authorization: `Bearer ${connectorSecret}` }, connectorSecret).authorized,
  true,
);
assert.strictEqual(
  isMuseConnectorAuthorized({ 'x-api-key': `Bearer ${connectorSecret}` }, connectorSecret).authorized,
  false,
  'A prefixed or whitespace-bearing API key must not be normalized silently',
);
assert.strictEqual(
  isMuseConnectorAuthorized({ 'x-api-key': 'wrong-secret' }, connectorSecret).authorized,
  false,
);

const initialized = buildMuseMcpResponse({
  jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' },
});
assert.strictEqual(initialized.status, 200);
assert.strictEqual(initialized.body.result.protocolVersion, '2025-03-26');
assert.strictEqual(initialized.body.result.capabilities.tools.listChanged, false);

const tools = buildMuseMcpResponse({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
assert.deepStrictEqual(tools.body.result.tools.map(tool => tool.name), ['kira_status']);
assert.strictEqual(tools.body.result.tools[0].annotations.readOnlyHint, true);
assert.strictEqual(tools.body.result.tools[0].annotations.destructiveHint, false);

const call = buildMuseMcpResponse({
  jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kira_status', arguments: {} },
}, { commit: '1234567890abcdef' });
assert.strictEqual(call.body.result.structuredContent.mode, 'read_only');
assert.strictEqual(call.body.result.structuredContent.externalActions, false);
assert.strictEqual(call.body.result.structuredContent.commit, '1234567');

const unknown = buildMuseMcpResponse({
  jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'send_email' },
});
assert.strictEqual(unknown.body.error.code, -32602);

const botSource = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
const connectorSource = fs.readFileSync(path.join(__dirname, 'lib', 'muse_connector.js'), 'utf8');
assert(botSource.includes("url === '/mcp'"), 'Muse MCP route missing');
assert(botSource.includes("url === '/muse/mcp'"), 'Muse MCP compatibility route missing');
assert(botSource.includes("url === '/.well-known/mcp.json'"), 'Muse discovery route missing');
assert(botSource.includes("req.method === 'POST' && (url === '/'"), 'Muse base URL POST route missing');
assert(connectorSource.includes('process.env.MUSE_CONNECTOR_TOKEN'), 'dedicated Muse secret missing');
assert(connectorSource.includes("headers['x-api-key']"), 'Muse X-API-Key compatibility missing');
assert(!connectorSource.includes('process.env.WEBHOOK_SECRET'), 'Muse must never reuse admin secret');
assert(!connectorSource.includes('PIPEDRIVE_API_KEY'), 'Muse must never receive Pipedrive secret');

console.log('✅ Muse MCP connector: tests passed');
