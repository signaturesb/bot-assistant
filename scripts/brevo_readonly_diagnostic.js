'use strict';

require('dotenv').config();

const BASE = 'https://api.brevo.com/v3';
const API_KEY = process.env.BREVO_API_KEY || '';
const TIMEOUT_MS = Number(process.env.BREVO_DIAG_TIMEOUT_MS || 8000);

if (!API_KEY) {
  console.error('BREVO_API_KEY manquant');
  process.exit(2);
}

const SAFE_ENDPOINTS = [
  '/account',
  '/contacts/lists?limit=50&offset=0&sort=desc',
  '/emailCampaigns?limit=50&offset=0&sort=desc',
  '/webhooks?type=transactional&sort=desc',
  '/webhooks?type=marketing&sort=desc',
];

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/token|secret|api.?key|authorization|password|headers?/i.test(k)) {
      out[k] = '[REDACTED]';
    } else if (k === 'url' && typeof v === 'string' && /webhook/i.test(v)) {
      try {
        const u = new URL(v);
        out[k] = `${u.protocol}//${u.host}${u.pathname ? '/…' : ''}`;
      } catch { out[k] = '[REDACTED_URL]'; }
    } else {
      out[k] = sanitize(v);
    }
  }
  return out;
}

async function brevoGet(endpoint) {
  if (!SAFE_ENDPOINTS.includes(endpoint)) {
    throw new Error(`Endpoint Brevo non autorise en diagnostic: ${endpoint}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${endpoint}`, {
      method: 'GET',
      headers: { accept: 'application/json', 'api-key': API_KEY },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
    return { ok: res.ok, status: res.status, body: sanitize(body) };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeAccount(body) {
  const plans = Array.isArray(body?.plan) ? body.plan : [];
  return {
    companyName: body?.companyName || null,
    email: body?.email || null,
    enterprise: !!body?.enterprise,
    plans: plans.map(p => ({ type: p.type, creditsType: p.creditsType, credits: p.credits })),
  };
}

async function main() {
  const result = { ts: new Date().toISOString(), mode: 'READ_ONLY', checks: {} };
  for (const endpoint of SAFE_ENDPOINTS) {
    try {
      const r = await brevoGet(endpoint);
      let summary = r.body;
      if (endpoint === '/account' && r.ok) summary = summarizeAccount(r.body);
      if (endpoint.startsWith('/contacts/lists') && r.ok) summary = { count: r.body?.count ?? null, lists: (r.body?.lists || []).map(x => ({ id: x.id, name: x.name, totalSubscribers: x.totalSubscribers })) };
      if (endpoint.startsWith('/emailCampaigns') && r.ok) summary = { count: r.body?.count ?? null, campaigns: (r.body?.campaigns || []).slice(0, 20).map(x => ({ id: x.id, name: x.name, status: x.status, scheduledAt: x.scheduledAt, sentDate: x.sentDate })) };
      if (endpoint.startsWith('/webhooks') && r.ok) summary = { webhooks: (r.body?.webhooks || []).map(x => ({ id: x.id, type: x.type, events: x.events, createdAt: x.createdAt, modifiedAt: x.modifiedAt, url: sanitize({ url: x.url }).url })) };
      result.checks[endpoint] = { ok: r.ok, status: r.status, summary };
    } catch (e) {
      result.checks[endpoint] = { ok: false, error: e.name === 'AbortError' ? `timeout>${TIMEOUT_MS}ms` : e.message };
    }
  }
  console.log(JSON.stringify(result, null, 2));
  if (Object.values(result.checks).some(x => !x.ok)) process.exitCode = 1;
}

main().catch(err => { console.error(err.message); process.exit(1); });
