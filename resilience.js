/**
 * ═══════════════════════════════════════════════════════════════
 * RESILIENCE.JS — Système anti-downtime niveau entreprise
 * ═══════════════════════════════════════════════════════════════
 *
 * Objectif: garantir que le bot ne tombe JAMAIS silencieusement.
 *
 * 5 couches de protection:
 * 1. Heartbeat interne (dead man's switch GitHub)
 * 2. Watchdog event loop (détecte zombies/freezes)
 * 3. Retry universel avec backoff exponentiel + jitter
 * 4. Circuit breaker par service (fail-fast)
 * 5. Auto-restart Render via API si dégradation critique
 *
 * Usage dans bot.js:
 *   const R = require('./resilience');
 *   R.initAll({ telegram: bot, shawnId: TELEGRAM_USER_ID });
 *   const data = await R.fetchResilient('pipedrive', url, options);
 *
 * Auteur: Kira (Opus 4.7) — avril 2026
 * ═══════════════════════════════════════════════════════════════
 */

const https = require('https');

// ─── État global ────────────────────────────────────────────────
const state = {
  boot: Date.now(),
  lastHeartbeat: Date.now(),
  lastEventLoopTick: Date.now(),
  telegram: null,
  shawnId: null,
  alertsLast: {},       // anti-spam: { key: timestamp }
  alertCooldown: 15 * 60 * 1000, // 15 min entre alertes identiques
  circuits: {},         // { service: { state, fails, openUntil, lastError } }
  metrics: {
    requests: {},       // { service: { ok, fail, totalMs } }
    retries: 0,
    circuitOpens: 0,
    crashes: 0,
    autoRestarts: 0,
  },
};

// ─── Configuration par service ─────────────────────────────────
const SERVICE_CONFIG = {
  pipedrive:  { timeout: 15000, retries: 3, circuitThreshold: 5, circuitCooldown: 120000 },
  gmail:      { timeout: 20000, retries: 3, circuitThreshold: 5, circuitCooldown: 120000 },
  dropbox:    { timeout: 20000, retries: 3, circuitThreshold: 5, circuitCooldown: 180000 },
  anthropic:  { timeout: 60000, retries: 2, circuitThreshold: 3, circuitCooldown: 60000 },
  brevo:      { timeout: 15000, retries: 3, circuitThreshold: 5, circuitCooldown: 120000 },
  telegram:   { timeout: 10000, retries: 4, circuitThreshold: 8, circuitCooldown: 60000 },
  centris:    { timeout: 45000, retries: 2, circuitThreshold: 3, circuitCooldown: 300000 },
  github:     { timeout: 15000, retries: 3, circuitThreshold: 5, circuitCooldown: 120000 },
  render:     { timeout: 15000, retries: 2, circuitThreshold: 3, circuitCooldown: 300000 },
  default:    { timeout: 15000, retries: 2, circuitThreshold: 5, circuitCooldown: 120000 },
};

function cfg(service) {
  return SERVICE_CONFIG[service] || SERVICE_CONFIG.default;
}

// ═══════════════════════════════════════════════════════════════
// 1. CIRCUIT BREAKER — évite les boucles de crash
// ═══════════════════════════════════════════════════════════════

function getCircuit(service) {
  if (!state.circuits[service]) {
    state.circuits[service] = {
      state: 'closed',      // closed = OK | open = bloqué | half_open = test
      fails: 0,
      openUntil: 0,
      lastError: null,
      lastSuccess: Date.now(),
    };
  }
  return state.circuits[service];
}

function circuitAllows(service) {
  const c = getCircuit(service);
  if (c.state === 'closed') return true;
  if (c.state === 'open') {
    if (Date.now() >= c.openUntil) {
      c.state = 'half_open';
      log(`🟡 Circuit ${service} → half_open (test)`);
      return true;
    }
    return false;
  }
  return true; // half_open: laisse passer 1 requête test
}

function circuitRecordSuccess(service) {
  const c = getCircuit(service);
  c.fails = 0;
  c.state = 'closed';
  c.lastSuccess = Date.now();
  c.lastError = null;
}

function circuitRecordFailure(service, err) {
  const c = getCircuit(service);
  const conf = cfg(service);
  c.fails++;
  c.lastError = err?.message || String(err);
  if (c.fails >= conf.circuitThreshold) {
    if (c.state !== 'open') {
      c.state = 'open';
      c.openUntil = Date.now() + conf.circuitCooldown;
      state.metrics.circuitOpens++;
      alertShawn(
        `circuit_${service}`,
        `🔴 *Circuit ${service} OUVERT*\n${c.fails} échecs consécutifs\nDernière erreur: ${c.lastError}\nRéouverture dans ${Math.round(conf.circuitCooldown/1000)}s`
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 2. RETRY UNIVERSEL — backoff exponentiel + jitter
// ═══════════════════════════════════════════════════════════════

async function withRetry(service, fn, opts = {}) {
  const conf = cfg(service);
  const maxRetries = opts.retries ?? conf.retries;
  const baseDelay = opts.baseDelay ?? 500;
  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!circuitAllows(service)) {
      throw new Error(`Circuit ${service} OUVERT — requête refusée (failfast)`);
    }

    try {
      const t0 = Date.now();
      const result = await withTimeout(fn(), conf.timeout, service);
      recordMetric(service, 'ok', Date.now() - t0);
      circuitRecordSuccess(service);
      return result;
    } catch (err) {
      lastErr = err;
      recordMetric(service, 'fail', 0);

      // 4xx (sauf 408/429) = erreur client, ne pas retry
      const status = err.status || err.statusCode;
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        circuitRecordFailure(service, err);
        throw err;
      }

      if (attempt < maxRetries) {
        state.metrics.retries++;
        const delay = Math.min(30000, baseDelay * Math.pow(2, attempt)) + Math.random() * 500;
        log(`⚠️  ${service} retry ${attempt + 1}/${maxRetries} dans ${Math.round(delay)}ms (${err.message})`);
        await sleep(delay);
      }
    }
  }

  circuitRecordFailure(service, lastErr);
  throw lastErr;
}

function withTimeout(promise, ms, label = 'op') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout ${ms}ms sur ${label}`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function recordMetric(service, kind, ms) {
  if (!state.metrics.requests[service]) {
    state.metrics.requests[service] = { ok: 0, fail: 0, totalMs: 0 };
  }
  state.metrics.requests[service][kind]++;
  if (ms) state.metrics.requests[service].totalMs += ms;
}

// ═══════════════════════════════════════════════════════════════
// 3. FETCH RÉSILIENT — wrapper fetch natif avec toute la logique
// ═══════════════════════════════════════════════════════════════

async function fetchResilient(service, url, options = {}) {
  return withRetry(service, async () => {
    const res = await fetch(url, options);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} sur ${service}`);
      err.status = res.status;
      err.url = url;
      throw err;
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? await res.json() : await res.text();
  }, options);
}

// ═══════════════════════════════════════════════════════════════
// 4. HEARTBEAT — dead man's switch GitHub
// ═══════════════════════════════════════════════════════════════

async function heartbeatToGitHub() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  const payload = {
    timestamp: new Date().toISOString(),
    uptime_s: Math.round((Date.now() - state.boot) / 1000),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    circuits_open: Object.entries(state.circuits)
      .filter(([_, c]) => c.state === 'open')
      .map(([name]) => name),
    metrics: {
      requests: Object.fromEntries(
        Object.entries(state.metrics.requests).map(([k, v]) => [
          k, { ok: v.ok, fail: v.fail, avg_ms: v.ok ? Math.round(v.totalMs / v.ok) : 0 }
        ])
      ),
      retries: state.metrics.retries,
      circuit_opens: state.metrics.circuitOpens,
      auto_restarts: state.metrics.autoRestarts,
    },
  };

  try {
    const content = Buffer.from(JSON.stringify(payload, null, 2)).toString('base64');
    const getRes = await fetch(
      'https://api.github.com/repos/signaturesb/bot-assistant/contents/heartbeat.json',
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'kira-bot' } }
    );
    const existing = getRes.ok ? await getRes.json() : null;

    await fetch(
      'https://api.github.com/repos/signaturesb/bot-assistant/contents/heartbeat.json',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'kira-bot',
        },
        body: JSON.stringify({
          message: `💓 heartbeat ${payload.timestamp}`,
          content,
          sha: existing?.sha,
        }),
      }
    );
    state.lastHeartbeat = Date.now();
  } catch (err) {
    log(`⚠️  Heartbeat GitHub échec: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// 5. WATCHDOG EVENT LOOP — détecte freezes
// ═══════════════════════════════════════════════════════════════

function startEventLoopWatchdog() {
  // Tick toutes les secondes — si écart > 5s, event loop est bloqué
  setInterval(() => {
    const now = Date.now();
    const delta = now - state.lastEventLoopTick;
    state.lastEventLoopTick = now;

    if (delta > 5000) {
      alertShawn(
        'event_loop_freeze',
        `🧊 *Event loop gelé ${Math.round(delta/1000)}s*\nLe bot a bloqué — possiblement trop de CPU ou I/O sync.`
      );
    }
  }, 1000).unref();
}

// ═══════════════════════════════════════════════════════════════
// 6. AUTO-RESTART RENDER — self-heal ultime
// ═══════════════════════════════════════════════════════════════

async function selfRestart(reason) {
  const token = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;

  if (!token || !serviceId) {
    log(`⚠️  selfRestart demandé (${reason}) mais RENDER_API_KEY ou RENDER_SERVICE_ID manquant`);
    return false;
  }

  log(`🔄 SELF-RESTART déclenché: ${reason}`);
  state.metrics.autoRestarts++;

  await alertShawn(
    'self_restart',
    `🔄 *Auto-restart déclenché*\nRaison: ${reason}\nRedémarrage via Render API...`,
    true // force, bypass cooldown
  );

  try {
    const res = await fetch(
      `https://api.render.com/v1/services/${serviceId}/deploys`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clearCache: 'do_not_clear' }),
      }
    );
    return res.ok;
  } catch (err) {
    log(`❌ Self-restart API échec: ${err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// 7. ALERTES TELEGRAM — avec anti-spam
// ═══════════════════════════════════════════════════════════════

async function alertShawn(key, message, force = false) {
  if (!state.telegram || !state.shawnId) return;

  if (!force) {
    const last = state.alertsLast[key] || 0;
    if (Date.now() - last < state.alertCooldown) return;
  }
  state.alertsLast[key] = Date.now();

  try {
    await state.telegram.sendMessage(state.shawnId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    // Fallback sans markdown
    try {
      await state.telegram.sendMessage(state.shawnId, message.replace(/[*_`]/g, ''));
    } catch (e) {
      log(`❌ Alerte Telegram impossible: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 8. CRASH HANDLERS — capture tout
// ═══════════════════════════════════════════════════════════════

function installCrashHandlers() {
  process.on('uncaughtException', async (err) => {
    state.metrics.crashes++;
    log(`💥 uncaughtException: ${err.stack || err.message}`);
    await alertShawn(
      'uncaught_exception',
      `💥 *Exception non catchée*\n\`\`\`\n${(err.stack || err.message).slice(0, 500)}\n\`\`\``,
      true
    );
    // Ne PAS exit — laisser le process tenter de continuer
    // Si ça devient critique, le watchdog externe fera le reset
  });

  process.on('unhandledRejection', async (reason) => {
    state.metrics.crashes++;
    const msg = reason?.stack || reason?.message || String(reason);
    log(`💥 unhandledRejection: ${msg}`);
    await alertShawn(
      'unhandled_rejection',
      `💥 *Promise rejection non catchée*\n\`\`\`\n${msg.slice(0, 500)}\n\`\`\``,
      true
    );
  });

  process.on('SIGTERM', async () => {
    log('🛑 SIGTERM reçu — shutdown propre');
    await alertShawn('sigterm', '🛑 Bot redémarre (SIGTERM reçu — normal sur deploy)', true);
  });
}

// ═══════════════════════════════════════════════════════════════
// 9. HEALTH CHECK DÉTAILLÉ
// ═══════════════════════════════════════════════════════════════

function healthReport() {
  const uptime = Math.round((Date.now() - state.boot) / 1000);
  const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  const circuits = Object.fromEntries(
    Object.entries(state.circuits).map(([name, c]) => [
      name,
      {
        state: c.state,
        fails: c.fails,
        last_success_ago_s: Math.round((Date.now() - c.lastSuccess) / 1000),
        last_error: c.lastError,
      },
    ])
  );

  const anyOpen = Object.values(circuits).some((c) => c.state === 'open');
  const status = anyOpen ? 'degraded' : 'ok';

  return {
    status,
    timestamp: new Date().toISOString(),
    uptime_s: uptime,
    uptime_human: formatDuration(uptime),
    memory: { rss_mb: memMB, heap_mb: heapMB },
    circuits,
    metrics: state.metrics,
    last_heartbeat_ago_s: Math.round((Date.now() - state.lastHeartbeat) / 1000),
  };
}

function formatDuration(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}j ${h}h ${m}m`;
}

// ═══════════════════════════════════════════════════════════════
// 10. AUTO-RECOVERY — surveille sa propre santé
// ═══════════════════════════════════════════════════════════════

function startSelfRecovery() {
  // Check toutes les 5 min
  setInterval(async () => {
    const h = healthReport();
    const memMB = h.memory.rss_mb;

    // Leak mémoire: >900 MB sur plan Render Starter (512 MB) → restart
    if (memMB > 900) {
      await selfRestart(`Mémoire critique: ${memMB} MB`);
      return;
    }

    // 3+ circuits ouverts simultanément → probable souci systémique
    const openCircuits = Object.values(h.circuits).filter((c) => c.state === 'open').length;
    if (openCircuits >= 3) {
      await selfRestart(`${openCircuits} circuits ouverts simultanément`);
      return;
    }
  }, 5 * 60 * 1000).unref();
}

// ═══════════════════════════════════════════════════════════════
// 11. LOGS STRUCTURÉS
// ═══════════════════════════════════════════════════════════════

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}][resilience]`, ...args);
}

// ═══════════════════════════════════════════════════════════════
// 12. INIT — appelé une fois au boot
// ═══════════════════════════════════════════════════════════════

function initAll({ telegram, shawnId }) {
  state.telegram = telegram;
  state.shawnId = shawnId;

  installCrashHandlers();
  startEventLoopWatchdog();
  startSelfRecovery();

  // Heartbeat toutes les 5 min vers GitHub
  setInterval(heartbeatToGitHub, 5 * 60 * 1000).unref();
  // Premier heartbeat dans 30s
  setTimeout(heartbeatToGitHub, 30000).unref();

  log('✅ Resilience system armed — 5 couches actives');
  log('   • Crash handlers (uncaught/unhandled)');
  log('   • Event loop watchdog (freeze detect 5s)');
  log('   • Self-recovery (mem > 900MB ou 3+ circuits open)');
  log('   • Heartbeat GitHub /5min');
  log('   • Circuit breakers + retry universel');

  // Notif boot
  alertShawn(
    'boot',
    `✅ *Bot redémarré*\nRésilience armée — 5 couches actives\nUptime tracker actif.`,
    true
  );
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  initAll,
  fetchResilient,
  withRetry,
  withTimeout,
  healthReport,
  alertShawn,
  selfRestart,
  heartbeatToGitHub,
  getState: () => state,
  getCircuits: () => state.circuits,
};
