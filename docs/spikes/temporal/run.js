// Orquestador de pruebas del spike. Uso:  node run.js   (con Temporal en TEMPORAL_ADDR, default 127.0.0.1:19010)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { Connection, Client } = require('@temporalio/client');

const ADDR = process.env.TEMPORAL_ADDR || '127.0.0.1:19010';
const EFFECTS = process.env.EFFECTS || '/tmp/spike-a/temporal-effects.jsonl';
const LEDGER = process.env.LEDGER || '/tmp/spike-a/temporal-ledger.txt';
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s, o) => console.log(s + (o === undefined ? '' : ' ' + JSON.stringify(o)));

const effects = (intentId) => fs.existsSync(EFFECTS)
  ? fs.readFileSync(EFFECTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.intentId === intentId) : [];
const counts = (intentId) => {
  const c = {};
  for (const e of effects(intentId)) { const k = `${e.act}.${e.ev}`; c[k] = (c[k] || 0) + 1; }
  return c;
};
const until = async (fn, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return Date.now() - t0; await sleep(200); }
  throw new Error('timeout esperando: ' + what);
};
const startWorker = (env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [require.resolve('./worker.js')], { env: { ...process.env, EFFECTS, LEDGER, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; if (out.includes('WORKER_READY')) resolve(child); });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (code) => { if (!out.includes('WORKER_READY')) reject(new Error('worker salió ' + code + ': ' + out.slice(0, 300))); });
});
const killHard = (child) => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); });

(async () => {
  fs.mkdirSync(require('node:path').dirname(EFFECTS), { recursive: true });
  fs.rmSync(EFFECTS, { force: true }); fs.rmSync(LEDGER, { force: true });
  const connection = await Connection.connect({ address: ADDR });
  const info = await connection.workflowService.getSystemInfo({});
  say('# servidor Temporal', { serverVersion: info.serverVersion, capabilities: Object.keys(info.capabilities || {}).length });
  say('# SDK', { worker: require('@temporalio/worker/package.json').version, client: require('@temporalio/client/package.json').version });
  const client = new Client({ connection });
  const start = (id, args) => client.workflow.start('PaymentWorkflow', { taskQueue: 'spike-payments', workflowId: `${id}-${RUN}`, args: [{ intentId: id, ...args }] });

  // T1 camino feliz --------------------------------------------------------
  let w = await startWorker();
  let h = await start('t1', { expireMs: 60000 });
  await until(() => counts('t1')['createCharge.commit'], 15000, 't1 createCharge');
  await h.signal('confirmPayment');
  say('## T1 camino feliz → resultado', await h.result()); say('efectos', counts('t1'));

  // T2 vencimiento sin señal ----------------------------------------------
  const t2 = Date.now(); h = await start('t2', { expireMs: 3000 });
  say('## T2 vencimiento (expireMs=3000, sin señal) → resultado', await h.result());
  say('tiempo hasta terminar (ms)', Date.now() - t2); say('efectos', counts('t2'));

  // T3 fallo en el paso final → compensaciones en orden inverso ----------
  h = await start('t3', { expireMs: 60000, failNotify: true });
  await until(() => counts('t3')['createCharge.commit'], 15000, 't3 createCharge');
  await h.signal('confirmPayment');
  say('## T3 fallo inyectado en notify → resultado', await h.result()); say('efectos', counts('t3'));
  say('orden real de efectos (act.ev)', effects('t3').map((e) => `${e.act}.${e.ev}`));
  await killHard(w);

  // T4 kill -9 con el workflow esperando la señal ------------------------
  w = await startWorker(); h = await start('t4', { expireMs: 120000 });
  await until(() => counts('t4')['createCharge.commit'], 15000, 't4 createCharge');
  const pidA = w.pid; await killHard(w);
  const d = await h.describe();
  say('## T4 worker pid=' + pidA + ' muerto con kill -9; estado del workflow', { status: d.status.name });
  await sleep(3000);
  w = await startWorker(); const tSig = Date.now();
  await h.signal('confirmPayment');
  say('## T4 resultado tras relanzar el worker y enviar la señal', await h.result());
  say('segundos desde la señal hasta terminar', Math.round((Date.now() - tSig) / 100) / 10);
  say('efectos', counts('t4')); say('pids que ejecutaron actividades', [...new Set(effects('t4').map((e) => e.pid))]);
  await killHard(w);

  // T5 kill -9 con la actividad del ledger EN EJECUCIÓN -------------------
  const slow = { LEDGER_DELAY_MS: '6000' };
  w = await startWorker(slow); h = await start('t5', { expireMs: 120000 });
  await until(() => counts('t5')['createCharge.commit'], 15000, 't5 createCharge');
  await h.signal('confirmPayment');
  await until(() => counts('t5')['recordLedger.start'], 15000, 't5 recordLedger.start');
  await killHard(w);
  say('## T5 worker muerto con kill -9 DENTRO de recordLedger (start=1, commit=0)', counts('t5'));
  w = await startWorker(slow);
  say('## T5 resultado tras relanzar el worker', await h.result());
  say('efectos', counts('t5'));
  say('líneas en el ledger para ledger-t5', fs.readFileSync(LEDGER, 'utf8').split('\n').filter((l) => l === 'ledger-t5').length);
  await killHard(w);

  // T6 la actividad es idempotente por id si se ejecuta dos veces ---------
  process.env.EFFECTS = EFFECTS; process.env.LEDGER = LEDGER; process.env.LEDGER_DELAY_MS = '0';
  const acts = require('./activities');
  const r1 = await acts.recordLedger('t6', 'ledger-t6'); const r2 = await acts.recordLedger('t6', 'ledger-t6');
  say('## T6 recordLedger llamada dos veces con el mismo id (fuera de Temporal)', { primera: r1, segunda: r2 });

  await connection.close();
  say('# fin');
  process.exit(0);
})().catch((e) => { console.error('FALLO', e); process.exit(1); });
