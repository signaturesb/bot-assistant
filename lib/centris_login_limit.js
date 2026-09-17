'use strict';

const fs = require('fs');

// Reserve each attempt on disk BEFORE contacting Centris. A crash therefore
// consumes an attempt instead of silently granting three more after restart.
function createCentrisLoginLimit(file) {
  let running = false;
  function read() {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isInteger(state.attempts) || state.attempts < 0 || state.attempts > 3) throw new Error('invalid state');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { attempts: process.env.CENTRIS_LOGIN_START_PAUSED === 'true' ? 3 : 0 };
      return { attempts: 3 }; // Corrupt/unreadable state must fail closed.
    }
  }
  function write(state) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  function reset() {
    if (running) throw new Error('CENTRIS_LOGIN_IN_PROGRESS');
    write({ attempts: 0 });
  }
  async function run(operation, onStopped = async () => {}) {
    if (running) throw new Error('CENTRIS_LOGIN_IN_PROGRESS');
    const state = read();
    if (state.attempts >= 3) throw new Error('CENTRIS_LOGIN_STOPPED: 3 essais atteints. Corrige le compte, puis utilise /centris pour relancer explicitement.');
    running = true;
    try {
      write({ attempts: state.attempts + 1 });
      const result = await operation();
      write({ attempts: 0 });
      return result;
    } catch (error) {
      if (read().attempts >= 3) await onStopped().catch(() => {});
      throw error;
    } finally {
      running = false;
    }
  }
  return { read, reset, run };
}

module.exports = { createCentrisLoginLimit };
