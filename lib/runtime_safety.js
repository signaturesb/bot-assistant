'use strict';

function createNonOverlappingRunner(fn, opts = {}) {
  const timeoutMs = Math.max(1, Number(opts.timeoutMs) || 120000);
  const onTimeout = opts.onTimeout || (() => {});
  const onError = opts.onError || (() => {});
  const onOverlap = opts.onOverlap || (() => {});
  let active = null;

  async function run() {
    if (active) {
      onOverlap();
      return { status: 'skipped_overlap' };
    }

    active = Promise.resolve()
      .then(fn)
      .then(value => ({ status: 'completed', value }))
      .catch(error => {
        onError(error);
        return { status: 'failed', error };
      })
      .finally(() => { active = null; });

    let timeoutId;
    const timeout = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    });
    const outcome = await Promise.race([active, timeout]);
    clearTimeout(timeoutId);
    if (outcome.status === 'timeout') onTimeout(timeoutMs);
    return outcome;
  }

  return { run, isRunning: () => active !== null };
}

function telegramPlainText(value) {
  return String(value || '').replace(/[*_`]/g, '');
}

function canUseLegacyTelegramMarkdown(value) {
  const text = String(value || '');
  if (text.includes('_')) return false;
  for (const marker of ['*', '`']) {
    const count = text.split(marker).length - 1;
    if (count % 2 !== 0) return false;
  }
  return true;
}

function isTelegramEntityParseError(error) {
  return /can't parse entities|cant parse entities|parse entities/i.test(String(error?.message || error || ''));
}

function timingSafeHexEqual(provided, expected) {
  const a = String(provided || '').toLowerCase();
  const b = String(expected || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return require('crypto').timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

async function retryReadOnly(fn, opts = {}) {
  const attempts = Math.max(1, Number(opts.attempts) || 2);
  const delayMs = Math.max(0, Number(opts.delayMs) || 0);
  const isSuccess = opts.isSuccess || (value => value !== null && value !== undefined);
  let lastValue;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      lastValue = await fn(attempt);
      if (isSuccess(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  if (lastError && lastValue === undefined) throw lastError;
  return lastValue;
}

module.exports = {
  createNonOverlappingRunner,
  telegramPlainText,
  canUseLegacyTelegramMarkdown,
  isTelegramEntityParseError,
  timingSafeHexEqual,
  retryReadOnly,
};
