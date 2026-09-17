'use strict';
const fs = require('fs');
const path = require('path');

// An operator supplies a NEW non-secret revision only after correcting the
// credentials. Consume it durably before resetting: restart never grants
// another attempt budget, including if the process crashes during recovery.
function recoverCentrisCredentials(dir, revision, reset) {
  if (!revision) return false;
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(revision)) throw new Error('CENTRIS_CREDENTIAL_REVISION_INVALID');
  const marker = path.join(dir, `centris_credentials_${revision}.applied`);
  let fd;
  try {
    fd = fs.openSync(marker, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try { fs.writeFileSync(fd, 'consumed\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  reset();
  return true;
}

module.exports = { recoverCentrisCredentials };
