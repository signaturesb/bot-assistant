'use strict';

function gistWritesEnabled(hasPersistentDisk, configuredValue) {
  const raw = String(configuredValue ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return !hasPersistentDisk;
}

function shouldRestoreFromGist(localItemCount, configuredValue) {
  const raw = String(configuredValue ?? '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return Number(localItemCount || 0) === 0;
}

module.exports = { gistWritesEnabled, shouldRestoreFromGist };
