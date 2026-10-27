// Spike P2.H1.M1 — ¿sirve TigerBeetle como motor de pay-ledger?
// Uso:  TB_ADDR=127.0.0.1:19001 node spike.cjs   (ver README en ../tigerbeetle.md)
// Datos 100 % sintéticos. Montos en centavos de BOB (unidades menores enteras).
const crypto = require('node:crypto');
const tb = require('tigerbeetle-node');
const { createClient, AccountFlags, TransferFlags, AccountFilterFlags,
  CreateAccountStatus, CreateTransferStatus } = tb;

const ADDR = process.env.TB_ADDR || '127.0.0.1:19001';
const LEDGER = 1;           // 1 = BOB
const CODE = 1;
const RUN = process.env.RUN || crypto.randomBytes(4).toString('hex'); // aísla corridas repetidas sobre el mismo archivo de datos
const MAX128 = (1n << 128n) - 1n;

const log = (t, o) => console.log(`${t}${o === undefined ? '' : ' ' + JSON.stringify(o, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
const tName = (s) => (s === -1 ? 'SIN_RESPUESTA_15s(-1)' : `${CreateTransferStatus[s] ?? '?'}(${s})`);
const aName = (s) => `${CreateAccountStatus[s] ?? '?'}(${s})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (6) id de 128 bits derivado de forma determinista de un id lógico
function id128(logical) {
  const h = crypto.createHash('sha256').update(`alovida-pay|${RUN}|${logical}`).digest();
  let v = BigInt('0x' + h.subarray(0, 16).toString('hex'));
  if (v === 0n || v === MAX128) v = 1n; // 0 y 2^128-1 están prohibidos
  return v;
}
const acct = (logical, flags = 0) => ({
  id: id128(logical), debits_pending: 0n, debits_posted: 0n, credits_pending: 0n, credits_posted: 0n,
  user_data_128: 0n, user_data_64: 0n, user_data_32: 0, reserved: 0, ledger: LEDGER, code: CODE, flags, timestamp: 0n,
});
const xfer = (logical, debit, credit, amount, extra = {}) => ({
  id: id128(logical), debit_account_id: debit, credit_account_id: credit, amount: BigInt(amount),
  pending_id: 0n, user_data_128: 0n, user_data_64: 0n, user_data_32: 0, timeout: 0, ledger: LEDGER, code: CODE,
  flags: 0, timestamp: 0n, ...extra,
});
const bal = async (c, id) => {
  const [a] = await c.lookupAccounts([id]);
  return { debits_pending: a.debits_pending, debits_posted: a.debits_posted, credits_pending: a.credits_pending, credits_posted: a.credits_posted,
    disponible: a.credits_posted - a.debits_posted - a.debits_pending };
};

(async () => {
  const client = createClient({ cluster_id: 0n, replica_addresses: [ADDR] });
  log('# corrida', { RUN, ADDR });

  // ---------- Cuentas (plan de cuentas de P2, §3.3 del maestro)
  const CLEAR = acct('connector:banco:clearing');
  const AVAIL = acct('merchant:A:available', AccountFlags.debits_must_not_exceed_credits | AccountFlags.history);
  const FEES = acct('platform:fees');
  const PAYOUT = acct('payout:clearing');
  const r = await client.createAccounts([CLEAR, AVAIL, FEES, PAYOUT]);
  log('## E0 crear cuentas', r.map((x) => aName(x.status)));
  const r2 = await client.createAccounts([FEES]);
  log('## E0b crear la misma cuenta otra vez (idempotencia de cuentas)', r2.map((x) => aName(x.status)));
  const rz = await client.createAccounts([{ ...acct('x'), id: 0n }]);
  log('## E0c id = 0', rz.map((x) => aName(x.status)));

  // fondeo: el PSP nos debe 5000 (clearing débito) y el comercio tiene 5000 disponible (crédito)
  const fund = await client.createTransfers([xfer('fund', CLEAR.id, AVAIL.id, 5000)]);
  log('## fondeo 50,00 BOB', fund.map((x) => tName(x.status)));
  log('saldo AVAIL', await bal(client, AVAIL.id));

  // ---------- (2) invariante de saldo
  const over = await client.createTransfers([xfer('over', AVAIL.id, FEES.id, 5001)]);
  log('## E2 débito 5001 con 5000 disponibles', over.map((x) => tName(x.status)));
  log('saldo AVAIL tras el rechazo (debe seguir igual)', await bal(client, AVAIL.id));
  const ok = await client.createTransfers([xfer('exact', AVAIL.id, FEES.id, 200)]);
  log('## E2b débito 200 (comisión)', ok.map((x) => tName(x.status)));
  log('saldo AVAIL', await bal(client, AVAIL.id));

  // ---------- (3) dos fases: pending -> post / void / vencimiento
  const P1 = xfer('hold1', AVAIL.id, PAYOUT.id, 1000, { flags: TransferFlags.pending });
  log('## E3 pending 1000', (await client.createTransfers([P1])).map((x) => tName(x.status)));
  log('saldo con la retención (disponible baja, no hay gasto doble)', await bal(client, AVAIL.id));
  const tooMuch = await client.createTransfers([xfer('gasto-doble', AVAIL.id, FEES.id, 4000)]);
  log('## E3b gastar 4000 con 3800 disponibles tras la retención', tooMuch.map((x) => tName(x.status)));
  const post = xfer('post1', AVAIL.id, PAYOUT.id, 1000, { flags: TransferFlags.post_pending_transfer, pending_id: P1.id });
  log('## E3c post', (await client.createTransfers([post])).map((x) => tName(x.status)));
  log('saldo tras post', await bal(client, AVAIL.id));
  const post2 = xfer('post1-again', AVAIL.id, PAYOUT.id, 1000, { flags: TransferFlags.post_pending_transfer, pending_id: P1.id });
  log('## E3d post otra vez sobre la misma retención', (await client.createTransfers([post2])).map((x) => tName(x.status)));

  const P2 = xfer('hold2', AVAIL.id, PAYOUT.id, 500, { flags: TransferFlags.pending });
  await client.createTransfers([P2]);
  const void2 = xfer('void2', AVAIL.id, PAYOUT.id, 500, { flags: TransferFlags.void_pending_transfer, pending_id: P2.id });
  log('## E3e void', (await client.createTransfers([void2])).map((x) => tName(x.status)));
  log('saldo tras void (el monto vuelve)', await bal(client, AVAIL.id));

  const P3 = xfer('hold3', AVAIL.id, PAYOUT.id, 700, { flags: TransferFlags.pending, timeout: 2 });
  await client.createTransfers([P3]);
  log('## E3f pending 700 con timeout=2 s', await bal(client, AVAIL.id));
  await sleep(6000);
  log('saldo 6 s después (el vencimiento devuelve el monto)', await bal(client, AVAIL.id));
  const late = xfer('post3', AVAIL.id, PAYOUT.id, 700, { flags: TransferFlags.post_pending_transfer, pending_id: P3.id });
  log('## E3g post sobre una retención vencida', (await client.createTransfers([late])).map((x) => tName(x.status)));

  // ---------- (4) idempotencia
  const before = await bal(client, AVAIL.id);
  const same = xfer('idem', AVAIL.id, FEES.id, 100);
  const res = await Promise.all(Array.from({ length: 10 }, () => client.createTransfers([same])));
  const counts = {};
  res.flat().forEach((x) => { const n = tName(x.status); counts[n] = (counts[n] || 0) + 1; });
  const after = await bal(client, AVAIL.id);
  log('## E4 mismo id x10 en paralelo, un cliente', counts);
  log('delta de disponible (esperado -100)', { antes: before.disponible, despues: after.disponible, delta: after.disponible - before.disponible });

  const clients = Array.from({ length: 10 }, () => createClient({ cluster_id: 0n, replica_addresses: [ADDR] }));
  const same2 = xfer('idem2', AVAIL.id, FEES.id, 100);
  const b2 = await bal(client, AVAIL.id);
  const TIMED_OUT = [{ status: -1 }];
  const res2 = await Promise.all(clients.map((c) => Promise.race([c.createTransfers([same2]), sleep(15000).then(() => TIMED_OUT)])));
  const counts2 = {};
  res2.flat().forEach((x) => { const n = tName(x.status); counts2[n] = (counts2[n] || 0) + 1; });
  const a2 = await bal(client, AVAIL.id);
  log('## E4b mismo id x10, diez clientes distintos', counts2);
  log('delta de disponible (esperado -100)', { delta: a2.disponible - b2.disponible });
  clients.forEach((c) => c.destroy());
  const diff = await client.createTransfers([xfer('idem', AVAIL.id, FEES.id, 999)]);
  log('## E4c mismo id con otro monto', diff.map((x) => tName(x.status)));

  // ---------- (5) lote enlazado
  const b5 = await bal(client, AVAIL.id);
  const chain = await client.createTransfers([
    xfer('l1', AVAIL.id, FEES.id, 10, { flags: TransferFlags.linked }),
    xfer('l2', AVAIL.id, FEES.id, 10, { flags: TransferFlags.linked }),
    xfer('l3', AVAIL.id, FEES.id, 999999), // falla: excede el saldo
  ]);
  log('## E5 cadena enlazada de 3 donde la última falla', chain.map((x) => tName(x.status)));
  const a5 = await bal(client, AVAIL.id);
  log('delta (esperado 0: ninguna se aplica)', { delta: a5.disponible - b5.disponible });
  const chain2 = await client.createTransfers([
    xfer('m1', AVAIL.id, FEES.id, 10, { flags: TransferFlags.linked }),
    xfer('m2', AVAIL.id, FEES.id, 10),
  ]);
  log('## E5b cadena válida', chain2.map((x) => tName(x.status)));
  log('saldo', await bal(client, AVAIL.id));

  // ---------- (6) ids derivados, lookups, historial
  log('## E6 id derivado es determinista', { igual: id128('merchant:A:available') === AVAIL.id, id: AVAIL.id.toString(16) });
  const found = await client.lookupTransfers([id128('fund'), id128('over'), id128('exact')]);
  log('lookupTransfers de [fund, over(rechazada), exact]', found.map((t) => ({ amount: t.amount, flags: t.flags })));
  const hist = await client.getAccountTransfers({ account_id: AVAIL.id, user_data_128: 0n, user_data_64: 0n, user_data_32: 0, code: 0,
    timestamp_min: 0n, timestamp_max: 0n, limit: 100, flags: AccountFilterFlags.debits | AccountFilterFlags.credits });
  log('getAccountTransfers(AVAIL) cantidad (las rechazadas no figuran)', { n: hist.length });
  const balances = await client.getAccountBalances({ account_id: AVAIL.id, user_data_128: 0n, user_data_64: 0n, user_data_32: 0, code: 0,
    timestamp_min: 0n, timestamp_max: 0n, limit: 3, flags: AccountFilterFlags.debits | AccountFilterFlags.credits });
  log('getAccountBalances (flag history) primeras 3 filas', balances.map((b) => ({ dp: b.debits_posted, cp: b.credits_posted, dpend: b.debits_pending })));

  // ---------- (4d) ¿se puede reintentar el id de una transferencia que fue RECHAZADA?
  const retryFailed = await client.createTransfers([xfer('over', AVAIL.id, FEES.id, 5001)]);
  log('## E4d reintentar con el mismo id una transferencia que ya fue rechazada (E2)', retryFailed.map((x) => tName(x.status)));
  const retryFailedSmall = await client.createTransfers([xfer('over', AVAIL.id, FEES.id, 1)]);
  log('## E4e mismo id rechazado, ahora con un monto que sí alcanza', retryFailedSmall.map((x) => tName(x.status)));
  const newId = await client.createTransfers([xfer('over-intento2', AVAIL.id, FEES.id, 1)]);
  log('## E4f id nuevo (por intento) con el monto que sí alcanza', newId.map((x) => tName(x.status)));

  // ---------- (7) límites
  const BIG_A = acct('big:a'), BIG_B = acct('big:b');
  await client.createAccounts([BIG_A, BIG_B]);
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => xfer(`${tag}-${i}`, BIG_A.id, BIG_B.id, 1));
  for (const n of [8189, 8190, 8191]) {
    try {
      const rr = await Promise.race([client.createTransfers(mk(n, `lote${n}`)), sleep(15000).then(() => 'TIMEOUT 15 s')]);
      log(`## E7 lote de ${n} transferencias`, typeof rr === 'string' ? rr : { resultados: rr.length, creadas: rr.filter((x) => x.status === CreateTransferStatus.created).length });
    } catch (e) {
      log(`## E7 lote de ${n} transferencias → EXCEPCIÓN`, { name: e.name, message: String(e.message).slice(0, 160) });
    }
  }
  const wrong = createClient({ cluster_id: 7n, replica_addresses: [ADDR] });
  const w = await Promise.race([wrong.lookupAccounts([AVAIL.id]).then((x) => ({ ok: x.length })).catch((e) => ({ error: String(e).slice(0, 120) })), sleep(8000).then(() => 'sin respuesta en 8 s (el cliente reintenta)')]);
  log('## E7b cliente con cluster_id=7 contra el cluster 0', w);
  wrong.destroy();

  log('saldo final AVAIL (para recovery.cjs)', await bal(client, AVAIL.id));
  client.destroy();
  log('# fin');
  process.exit(0);
})().catch((e) => { console.error('FALLO', e); process.exit(1); });
