'use strict';

const { isAdminAuthorized } = require('./admin_auth');

const MAX_BODY_BYTES = 64 * 1024;
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2024-11-05']);

function writeJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function requireMuseConnector(req, res) {
  try {
    const expected = String(process.env.MUSE_CONNECTOR_TOKEN || '');
    if (Buffer.byteLength(expected, 'utf8') < 32) {
      writeJson(res, 503, { ok: false, error: 'MUSE_CONNECTOR_NOT_CONFIGURED' });
      return false;
    }
    if (!isAdminAuthorized(req.headers, expected)) {
      writeJson(res, 401, { ok: false, error: 'UNAUTHORIZED' }, {
        'WWW-Authenticate': 'Bearer realm="kira-mcp"',
      });
      return false;
    }
    return true;
  } catch {
    writeJson(res, 400, { ok: false, error: 'BAD_REQUEST' });
    return false;
  }
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const error = new Error('BODY_TOO_LARGE');
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        const error = new Error('INVALID_JSON');
        error.code = 'INVALID_JSON';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function buildMuseMcpResponse(message, status = {}) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { status: 400, body: rpcError(message?.id, -32600, 'Invalid Request') };
  }

  const id = message.id;
  if (message.method === 'initialize') {
    const requested = String(message.params?.protocolVersion || '');
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : '2025-03-26';
    return {
      status: 200,
      body: {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kira-signature-sb', version: '1.0.0' },
          instructions: 'Connecteur Kira en lecture seule. Aucune action externe, aucun envoi et aucune mutation Pipedrive.',
        },
      },
    };
  }

  if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (message.method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (message.method === 'tools/list') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0', id,
        result: {
          tools: [{
            name: 'kira_status',
            title: 'État de Kira',
            description: 'Vérifie la disponibilité et les permissions du connecteur Kira sans lire de données client.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          }],
        },
      },
    };
  }
  if (message.method === 'tools/call') {
    if (message.params?.name !== 'kira_status') {
      return { status: 200, body: rpcError(id, -32602, 'Unknown tool') };
    }
    const publicStatus = {
      service: 'Kira — Signature SB',
      status: 'ok',
      mode: 'read_only',
      externalActions: false,
      commit: String(status.commit || 'unknown').substring(0, 7),
    };
    return {
      status: 200,
      body: {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(publicStatus) }],
          structuredContent: publicStatus,
          isError: false,
        },
      },
    };
  }
  return { status: 200, body: rpcError(id, -32601, 'Method not found') };
}

async function handleMuseMcpRequest(req, res, status = {}) {
  if (!requireMuseConnector(req, res)) return;
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' });
    return;
  }
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    writeJson(res, 415, rpcError(null, -32600, 'Content-Type must be application/json'));
    return;
  }
  try {
    const message = await readJsonBody(req);
    const response = buildMuseMcpResponse(message, status);
    if (response.body === null) {
      res.writeHead(response.status, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    writeJson(res, response.status, response.body);
  } catch (error) {
    const tooLarge = error?.code === 'BODY_TOO_LARGE';
    writeJson(res, tooLarge ? 413 : 400, rpcError(null, -32700, tooLarge ? 'Request body too large' : 'Parse error'));
  }
}

module.exports = { MAX_BODY_BYTES, buildMuseMcpResponse, handleMuseMcpRequest, requireMuseConnector };
