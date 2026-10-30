// Actividades del spike. Cada ejecución deja una línea en EFFECTS (JSONL) para contar ejecuciones reales.
// El «ledger» es un archivo con un id por línea: recordLedger es idempotente por ledgerId.
const fs = require('node:fs');
const { ApplicationFailure } = require('@temporalio/activity');

const EFFECTS = process.env.EFFECTS || '/tmp/spike-a/temporal-effects.jsonl';
const LEDGER = process.env.LEDGER || '/tmp/spike-a/temporal-ledger.txt';
const LEDGER_DELAY_MS = Number(process.env.LEDGER_DELAY_MS || 0);

const log = (act, intentId, ev, extra = {}) =>
  fs.appendFileSync(EFFECTS, JSON.stringify({ t: Date.now(), pid: process.pid, act, intentId, ev, ...extra }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ledgerHas = (id) => fs.existsSync(LEDGER) && fs.readFileSync(LEDGER, 'utf8').split('\n').includes(id);

async function createCharge(intentId) {
  log('createCharge', intentId, 'commit');
  return `chg-${intentId}`;
}

async function cancelCharge(intentId, chargeId) {
  log('cancelCharge', intentId, 'commit', { chargeId });
}

async function recordLedger(intentId, ledgerId) {
  log('recordLedger', intentId, 'start');
  if (LEDGER_DELAY_MS) await sleep(LEDGER_DELAY_MS); // ventana para matar el worker a mitad de la actividad
  if (ledgerHas(ledgerId)) { log('recordLedger', intentId, 'commit', { applied: false }); return { applied: false }; }
  fs.appendFileSync(LEDGER, ledgerId + '\n');
  log('recordLedger', intentId, 'commit', { applied: true });
  return { applied: true };
}

async function reverseLedger(intentId, ledgerId) {
  log('reverseLedger', intentId, 'commit', { ledgerId });
}

async function notify(intentId, fail) {
  if (fail) {
    log('notify', intentId, 'rejected');
    throw ApplicationFailure.nonRetryable('notify rechazado (fallo inyectado)', 'NotifyRejected');
  }
  log('notify', intentId, 'commit');
}

module.exports = { createCharge, cancelCharge, recordLedger, reverseLedger, notify };
