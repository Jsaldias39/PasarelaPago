import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CircuitBreaker, HttpClient, UpstreamError } from '../../src/clients/http';
import type { Leg } from '../../src/clients/ledger.client';
import { UpstreamRejection } from '../../src/clients/upstream';
import { clientsFor } from '../helpers/clients';
import { ConnectorsDouble } from './connectors.double';
import { LedgerDouble } from './ledger.double';
import { RiskDouble } from './risk.double';
import { VaultDouble } from './vault.double';
import { WalletAuthorizerDouble } from './wallet.double';

const PI = 'pi_abcdefghij12';
const MC = 'mc_abcdefghij12';
const risk = new RiskDouble();
const connectors = new ConnectorsDouble();
const ledger = new LedgerDouble();
const vault = new VaultDouble();
let c: ReturnType<typeof clientsFor>;

beforeAll(async () => {
  const [r, k, l, v] = await Promise.all([risk.start(), connectors.start(), ledger.start(), vault.start()]);
  c = clientsFor({ risk: r, connectors: k, ledger: l, vault: v });
});
afterAll(async () => Promise.all([risk.stop(), connectors.stop(), ledger.stop(), vault.stop()]));
afterEach(() => {
  // Un doble que recibe una petición fuera de contrato no prueba nada: toda prueba exige 0 violaciones.
  for (const d of [risk, connectors, ledger, vault]) expect(d.server.violations).toEqual([]);
  risk.mode = 'allow';
  risk.requireScreening = true;
  risk.sanctions.clear();
  connectors.scenario = 'ok';
  ledger.failNext = 0;
  ledger.latencyMs = 0;
});

const assessInput = { merchantId: MC, paymentIntentId: PI, amountMinor: 10000, currency: 'BOB', method: 'qr' as const, screening: { merchantName: 'Comercio de Prueba S.R.L.' } };
// El doble es idempotente por clave como pay-risk: cada evaluación de estas pruebas usa su propio intento.
let riskSeq = 0;
const fresh = () => ({ ...assessInput, paymentIntentId: `pi_risk${String(riskSeq++).padStart(8, '0')}` });

describe('[DOBLE] pay-risk (internal-risk-v1)', () => {
  it('correcto: allow, deny y review llegan tal cual; con screening y sin coincidencia el doble responde allow/ok y screened', async () => {
    const allowed = await c.risk.assess(fresh());
    expect(allowed).toMatchObject({ decision: 'allow', reason_code: 'ok', screened: true });
    risk.mode = 'deny';
    expect((await c.risk.assess(fresh())).decision).toBe('deny');
    risk.mode = 'review';
    expect((await c.risk.assess(fresh())).decision).toBe('review');
  });

  it('límite: una respuesta lenta pero dentro del timeout (300 ms) todavía vale', async () => {
    risk.mode = { slowMs: 150 };
    expect((await c.risk.assess(fresh())).decision).toBe('allow');
  });

  it('límite: un nombre de la lista con otras mayúsculas, tildes y espacios ⇒ deny/sanctions_match, sea el del COMERCIO o el del PAGADOR; el mismo nombre sin lista ⇒ allow', async () => {
    risk.sanctions.add('entidad sancionada de prueba');
    const listed = '  ENTIDAD  Sancionáda   de Prueba ';
    expect(await c.risk.assess({ ...fresh(), screening: { merchantName: listed } })).toMatchObject({ decision: 'deny', reason_code: 'sanctions_match', screened: true });
    expect(await c.risk.assess({ ...fresh(), screening: { merchantName: 'Comercio de Prueba S.R.L.', payerName: listed } })).toMatchObject({ decision: 'deny', reason_code: 'sanctions_match', screened: true });
    risk.sanctions.clear();
    expect((await c.risk.assess({ ...fresh(), screening: { merchantName: 'Comercio de Prueba S.R.L.', payerName: 'Entidad Sancionada de Prueba' } })).decision).toBe('allow');
  });

  it('límite: un pagador invitado (sin name) NO bloquea; con name sin coincidencia tampoco', async () => {
    expect(await c.risk.assess(fresh())).toMatchObject({ decision: 'allow', reason_code: 'ok' });
    expect((await c.risk.assess({ ...fresh(), screening: { merchantName: 'Comercio de Prueba S.R.L.', payerName: 'Persona Sintetica' } })).decision).toBe('allow');
  });

  it('inválido: SIN merchant_name el doble responde review/screening_not_provided (nunca allow, como el contrato) y screened=false — también si solo viene el pagador sin coincidencia; con requireScreening=false, allow', async () => {
    const base = fresh();
    const withoutScreening = { merchantId: base.merchantId, paymentIntentId: base.paymentIntentId, amountMinor: base.amountMinor, currency: base.currency, method: base.method };
    expect(await c.risk.assess(withoutScreening)).toMatchObject({ decision: 'review', reason_code: 'screening_not_provided', screened: false });
    expect(await c.risk.assess({ ...fresh(), screening: { payerName: 'Persona Sintetica' } })).toMatchObject({ decision: 'review', reason_code: 'screening_not_provided', screened: false });
    risk.sanctions.add('persona sancionada');
    expect(await c.risk.assess({ ...fresh(), screening: { payerName: 'Persona Sancionada' } })).toMatchObject({ decision: 'deny', reason_code: 'sanctions_match' }); // una coincidencia fuerte no se oculta
    risk.requireScreening = false;
    expect(await c.risk.assess({ ...withoutScreening, paymentIntentId: 'pi_risknoscr001' })).toMatchObject({ decision: 'allow', screened: false });
    risk.requireScreening = true;
  });

  it('inválido: un campo fuera de contrato dentro de screening es una violación registrada por el doble', async () => {
    const response = await fetch(`${risk.server.url}/assessments`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-service-id': 'pay-payments', 'idempotency-key': 'k-0002-bbbb' }, body: JSON.stringify({ merchant_id: MC, payment_intent_id: 'pi_oldformat001', amount_minor: 100, currency: 'BOB', method: 'qr', screening: { razon_social: 'x' } }) });
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(risk.server.violations.length).toBeGreaterThan(0);
    risk.server.violations.length = 0;
  });

  it('idempotencia: la misma Idempotency-Key devuelve la MISMA evaluación (200 en la repetición), aunque el modo del doble haya cambiado', async () => {
    const input = fresh();
    const first = await c.risk.assess(input);
    risk.mode = 'deny';
    expect(await c.risk.assess(input)).toEqual(first);
  });

  it('inválido: caído (503) y colgado (timeout) son UpstreamError, no un «deny»', async () => {
    risk.mode = 'down';
    await expect(c.risk.assess(assessInput)).rejects.toMatchObject({ name: 'UpstreamError', kind: 'server_error', status: 503 });
    risk.mode = 'hang';
    const started = Date.now();
    await expect(c.risk.assess(assessInput)).rejects.toMatchObject({ name: 'UpstreamError', kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('inválido: una petición fuera de contrato es rechazada por el doble, no tragada', async () => {
    const response = await fetch(`${risk.server.url}/assessments`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-service-id': 'pay-payments', 'idempotency-key': 'k-0001-aaaa' }, body: JSON.stringify({ campo_inventado: 1 }) });
    expect(response.status).toBeGreaterThanOrEqual(200); // el doble registra la violación…
    expect(risk.server.violations.length).toBeGreaterThan(0);
    risk.server.violations.length = 0; // …y esta prueba la consume a propósito
  });
});

describe('[DOBLE] pay-connectors (internal-connectors-v1)', () => {
  const charge = { mode: 'test' as const, paymentIntentId: PI, merchantId: MC, amountMinor: 10000, currency: 'BOB', method: 'qr' as const, expiresAt: '2026-10-27T16:00:00Z' };

  it('correcto: un cobro QR queda requires_action con el QR, e idempotente por intento', async () => {
    const first = await c.connectors.createCharge(charge);
    const second = await c.connectors.createCharge(charge);
    expect(first.ok && first.value.status).toBe('requires_action');
    expect(first.ok && first.value.next_action?.type).toBe('display_qr');
    expect(second.ok && second.value.id).toBe(first.ok && first.value.id);
    expect(connectors.chargeCreations.get(PI)).toBe(1);
  });

  it('correcto: transferencia y tarjeta devuelven la acción que les toca', async () => {
    const tr = await c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_transfer00001', method: 'bank_transfer' });
    const card = await c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_card00000001', method: 'card', cardToken: 'tok_abcdefghij12' });
    expect(tr.ok && tr.value.next_action?.type).toBe('bank_transfer_instructions');
    expect(card.ok && card.value.next_action?.type).toBe('redirect_to_card_form');
  });

  it('límite: cancelar un cargo ya pagado da 409; cancelar uno pendiente lo anula, y repetir es igual', async () => {
    const created = await c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_cancelme00001' });
    const id = created.ok ? created.value.id : '';
    const first = await c.connectors.cancelCharge(id, 'k-cancel-0001', 'test');
    const again = await c.connectors.cancelCharge(id, 'k-cancel-0001', 'test');
    expect(first.ok && first.value.status).toBe('canceled');
    expect(again.ok && again.value.status).toBe('canceled');
    const paid = await c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_paidcharge001' });
    connectors.setChargeStatus(paid.ok ? paid.value.id : '', 'succeeded');
    expect(await c.connectors.cancelCharge(paid.ok ? paid.value.id : '', 'k-cancel-0002', 'test')).toMatchObject({ ok: false, status: 409 });
  });

  it('inválido: el 422 del proveedor y el `502 connector_unavailable` exacto son DEFINITIVOS ({ok:false}); un 500 es AMBIGUO (UpstreamError)', async () => {
    connectors.scenario = 'decline';
    expect(await c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_declined00001' })).toMatchObject({ ok: false, status: 422 });
    connectors.scenario = 'down'; // 502 + problem+json connector_unavailable: el contrato garantiza que no se envió nada
    expect(await c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_down000000001' })).toMatchObject({ ok: false, status: 502, code: 'connector_unavailable' });
    connectors.scenario = 'charge_ambiguous'; // un 500 NO prueba que no se creó el cargo
    await expect(c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_ambiguous0001' })).rejects.toMatchObject({ name: 'UpstreamError', kind: 'server_error', status: 500 });
  });

  it('inválido: una respuesta fuera del contrato (4xx sin cuerpo problem+json, 502 de un proxy) es AMBIGUA, no un rechazo', async () => {
    const raw = (status: number, body: string, contentType = 'text/plain') => {
      const server = createServer((_req, res) => res.writeHead(status, { 'content-type': contentType }).end(body));
      return new Promise<{ url: string; close: () => Promise<void> }>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) })),
      );
    };
    for (const [status, body] of [[404, 'Not Found'], [422, ''], [502, '<html>Bad Gateway</html>'], [400, '{"error":"x"}']] as const) {
      const fake = await raw(status, body);
      const client = clientsFor({ connectors: fake.url }).connectors;
      await expect(client.createCharge({ ...charge, paymentIntentId: 'pi_proxyfail0001' })).rejects.toMatchObject({ name: 'UpstreamError' });
      await expect(client.createRefund('ch_aaaaaaaaaaaa', 100, 'k-refund-proxy1', 'test')).rejects.toMatchObject({ name: 'UpstreamError' });
      await expect(client.cancelCharge('ch_aaaaaaaaaaaa', 'k-cancel-proxy1', 'test')).rejects.toMatchObject({ name: 'UpstreamError' });
      await fake.close();
    }
  });

  it('límite: el estado del cargo refleja lo que «pagó» el pagador y reembolsar exige un cargo pagado', async () => {
    const created = await c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_statuscheck01' });
    const id = created.ok ? created.value.id : '';
    expect((await c.connectors.getChargeStatus(id, 'test')).status).toBe('requires_action');
    expect(await c.connectors.createRefund(id, 1000, 'k-refund-0001', 'test')).toMatchObject({ ok: false, status: 409 });
    connectors.setChargeStatus(id, 'succeeded');
    expect((await c.connectors.getChargeStatus(id, 'test')).status).toBe('succeeded');
    const refund = await c.connectors.createRefund(id, 1000, 'k-refund-0002', 'test', { refundId: 're_refundone0001' });
    expect(refund.ok && refund.value.status).toBe('succeeded');
  });
});

describe('[DOBLE] pay-connectors: reembolsos consultables, refund_id y cuenta recaudadora (cambios de la ola 2)', () => {
  const base = { mode: 'test' as const, merchantId: MC, amountMinor: 10000, currency: 'BOB', method: 'qr' as const, expiresAt: '2026-10-27T16:00:00Z' };

  it('correcto: el reembolso lleva el refund_id de pay-payments y se consulta por su cr_ con X-Pay-Mode', async () => {
    const created = await c.connectors.createCharge({ ...base, paymentIntentId: 'pi_refundquery01' });
    const chargeId = created.ok ? created.value.id : '';
    connectors.setChargeStatus(chargeId, 'succeeded');
    connectors.scenario = 'refund_pending';
    const refund = await c.connectors.createRefund(chargeId, 4000, 'k-refund-q0001', 'test', { refundId: 're_queryrefund001' });
    expect(refund.ok && refund.value).toMatchObject({ status: 'pending', refund_id: 're_queryrefund001' });
    const crId = refund.ok ? refund.value.id : '';
    expect(await c.connectors.getRefund(crId, 'test')).toMatchObject({ status: 'pending' });
    connectors.setRefundStatus(crId, 'succeeded');
    expect(await c.connectors.getRefund(crId, 'test')).toMatchObject({ status: 'succeeded', refund_id: 're_queryrefund001' });
    const last = connectors.server.callsTo('GET', /^\/refunds\//).at(-1);
    expect(last?.headers['x-pay-mode']).toBe('test');
    expect(last?.query.get('refresh')).toBe('true');
  });

  it('límite: sin poder consultar al proveedor el conector devuelve el último estado con stale (no es una novedad)', async () => {
    const created = await c.connectors.createCharge({ ...base, paymentIntentId: 'pi_refundstale01' });
    const chargeId = created.ok ? created.value.id : '';
    connectors.setChargeStatus(chargeId, 'succeeded');
    const refund = await c.connectors.createRefund(chargeId, 100, 'k-refund-s0001', 'test');
    const crId = refund.ok ? refund.value.id : '';
    connectors.refundInquiryStale = true;
    expect(await c.connectors.getRefund(crId, 'test')).toMatchObject({ status: 'pending', stale: true });
    connectors.refundInquiryStale = false;
  });

  it('inválido: un cr_ desconocido es un rechazo del contrato (404), no un estado', async () => {
    await expect(c.connectors.getRefund('cr_doesnotexist00', 'test')).rejects.toBeInstanceOf(UpstreamRejection);
  });

  it('correcto/límite: la cuenta recaudadora viaja en la acción solo si el conector la informa (T-03: hoy no existe)', async () => {
    const without = await c.connectors.createCharge({ ...base, method: 'bank_transfer', paymentIntentId: 'pi_bankwithout01' });
    expect(without.ok && without.value.next_action).toMatchObject({ type: 'bank_transfer_instructions' });
    expect(without.ok && (without.value.next_action as { account_number?: string }).account_number).toBeUndefined();
    connectors.bankAccount = { bank_name: 'Banco de Prueba (sintético)', account_holder: 'ALOVIDA PRUEBA', account_number: '000-0000000-0' };
    const withAccount = await c.connectors.createCharge({ ...base, method: 'bank_transfer', paymentIntentId: 'pi_bankwith00001' });
    expect(withAccount.ok && withAccount.value.next_action).toMatchObject({ account_number: '000-0000000-0', bank_name: 'Banco de Prueba (sintético)' });
    connectors.bankAccount = null;
  });
});

describe('[DOBLE] pay-ledger (internal-ledger-v1, regla H-1 de TigerBeetle)', () => {
  const legs: Leg[] = [
    { debit_account: 'connector:mock:clearing', credit_account: `merchant:${MC}:pending`, amount_minor: 9700, code: 'charge' },
    { debit_account: 'connector:mock:clearing', credit_account: 'platform:fees', amount_minor: 300, code: 'fee' },
  ];
  const tx = (ref: string, attempt: number, l: Leg[] = legs) => c.ledger.createTransaction({ mode: 'test', businessRef: ref, attempt, currency: 'BOB', legs: l });

  it('correcto: asienta una vez y el mismo (business_ref, attempt) devuelve el mismo resultado sin mover dinero otra vez', async () => {
    const first = await tx('pi_ledgerok00001:capture', 1);
    const again = await tx('pi_ledgerok00001:capture', 1);
    expect(first.kind === 'ok' && first.value.result).toBe('created');
    expect(again.kind === 'ok' && again.value.result).toBe('exists');
    expect(ledger.postedCount('pi_ledgerok00001:capture')).toBe(1);
    expect(ledger.balance('platform:fees')).toBeGreaterThanOrEqual(300);
  });

  it('límite: sin saldo se rechaza; ese attempt queda definitivamente rechazado y recién attempt+1 puede aceptarse', async () => {
    const wallet: Leg[] = [{ debit_account: 'user:usr_wallet0001:wallet', credit_account: `merchant:${MC}:pending`, amount_minor: 5000, code: 'wallet_transfer' }];
    const ref = 'pi_walletlimit01:capture';
    expect(await tx(ref, 1, wallet)).toEqual({ kind: 'rejected', code: 'insufficient_funds' });
    ledger.setBalance('user:usr_wallet0001:wallet', 5000); // entró saldo
    expect(await tx(ref, 1, wallet)).toEqual({ kind: 'rejected', code: 'insufficient_funds' }); // el mismo attempt NO se reabre
    const retried = await tx(ref, 2, wallet);
    expect(retried.kind).toBe('ok');
    expect(ledger.balance('user:usr_wallet0001:wallet')).toBe(0);
    expect(ledger.postedCount(ref)).toBe(1);
  });

  it('inválido: un attempt nuevo tras uno aceptado, o con salto, da 409 y NO mueve dinero', async () => {
    const ref = 'pi_ledgerbad0001:capture';
    await tx(ref, 1);
    const feesBefore = ledger.balance('platform:fees');
    expect(await tx(ref, 2)).toEqual({ kind: 'conflict' });
    expect(await tx('pi_ledgerskip001:capture', 3)).toEqual({ kind: 'conflict' });
    expect(ledger.balance('platform:fees')).toBe(feesBefore);
    expect(ledger.postedCount(ref)).toBe(1);
  });

  it('inválido: el mismo attempt con otro contenido es 422 idempotency_key_reused (un error de quien llama)', async () => {
    const ref = 'pi_ledgerreuse01:capture';
    await tx(ref, 1);
    await expect(tx(ref, 1, [{ ...legs[0], amount_minor: 1 }])).rejects.toBeInstanceOf(UpstreamRejection);
  });

  it('retención en dos fases: post confirma una vez, void anula, y una retención se resuelve una sola vez', async () => {
    ledger.setBalance(`merchant:${MC}:available`, 5000);
    const hold = await c.ledger.createHold({ mode: 'test', businessRef: 're_holdok000001:refund', attempt: 1, debitAccount: `merchant:${MC}:available`, creditAccount: 'connector:mock:clearing', amountMinor: 2000, currency: 'BOB', expiresInSeconds: 3600 });
    const id = hold.kind === 'ok' ? hold.value.id : '';
    expect(hold.kind).toBe('ok');
    expect((await c.ledger.postHold(id, 'k-post-00001', 'test')).kind).toBe('ok');
    expect((await c.ledger.postHold(id, 'k-post-00001', 'test')).kind).toBe('ok'); // misma clave: misma respuesta
    expect((await c.ledger.voidHold(id, 'k-void-00001', 'test')).kind).toBe('conflict'); // ya resuelta
    expect(ledger.balance(`merchant:${MC}:available`)).toBe(3000);
    const second = await c.ledger.createHold({ mode: 'test', businessRef: 're_holdvoid0001:refund', attempt: 1, debitAccount: `merchant:${MC}:available`, creditAccount: 'connector:mock:clearing', amountMinor: 1000, currency: 'BOB', expiresInSeconds: 3600 });
    expect((await c.ledger.voidHold(second.kind === 'ok' ? second.value.id : '', 'k-void-00002', 'test')).kind).toBe('ok');
    expect(ledger.balance(`merchant:${MC}:available`)).toBe(3000);
  });

  it('inválido: una retención sin saldo se rechaza', async () => {
    const hold = await c.ledger.createHold({ mode: 'test', businessRef: 're_holdnofund001:refund', attempt: 1, debitAccount: 'merchant:mc_poor0000001:available', creditAccount: 'connector:mock:clearing', amountMinor: 100, currency: 'BOB', expiresInSeconds: 60 });
    expect(hold).toEqual({ kind: 'rejected', code: 'insufficient_funds' });
  });

  it('inválido: el ledger caído es UpstreamError (5xx), no un rechazo de negocio', async () => {
    ledger.failNext = 1;
    await expect(tx('pi_ledgerdown001:capture', 1)).rejects.toMatchObject({ name: 'UpstreamError', kind: 'server_error', status: 500 });
    expect(ledger.postedCount('pi_ledgerdown001:capture')).toBe(0);
  });
});

describe('[DOBLE] pay-vault (solo GET /tokens/{token}) y emisor de wallet_authorization', () => {
  it('el token es por comercio: el de otro comercio da null (404)', async () => {
    vault.tokens.set('tok_abcdefghij12', MC);
    expect((await c.vault.getToken('tok_abcdefghij12', MC))?.last4).toBe('1111');
    expect(await c.vault.getToken('tok_abcdefghij12', 'mc_otrocomercio1')).toBeNull();
    expect(await c.vault.getToken('tok_noexiste00001', MC)).toBeNull();
  });

  it('wallet_authorization: un solo uso, atada a comercio, importe y moneda, y vence', async () => {
    const wallet = new WalletAuthorizerDouble();
    const ok = { merchantId: MC, amountMinor: 5000, currency: 'BOB' };
    const t1 = wallet.issue({ userId: 'usr_1', ...ok });
    expect(await wallet.consume({ token: t1, ...ok })).toMatchObject({ userId: 'usr_1' });
    expect(await wallet.consume({ token: t1, ...ok })).toBeNull(); // reutilizado
    expect(await wallet.consume({ token: wallet.issue({ userId: 'usr_1', ...ok }), ...ok, merchantId: 'mc_otrocomercio1' })).toBeNull();
    expect(await wallet.consume({ token: wallet.issue({ userId: 'usr_1', ...ok }), ...ok, amountMinor: 5001 })).toBeNull();
    expect(await wallet.consume({ token: wallet.issue({ userId: 'usr_1', ...ok, ttlMs: -1 }), ...ok })).toBeNull(); // vencida
    expect(await wallet.consume({ token: 'wa_inventado', ...ok })).toBeNull();
  });
});

describe('circuit breaker y política de reintentos (P3.H2.M2)', () => {
  it('se abre tras N fallos consecutivos, rechaza al instante y se cierra con una llamada de prueba exitosa', async () => {
    let now = 1000;
    const breaker = new CircuitBreaker('x', { failureThreshold: 3, resetAfterMs: 5000, now: () => now });
    const fail = () => breaker.exec(async () => { throw new UpstreamError('network', 'x'); });
    for (let i = 0; i < 3; i += 1) await expect(fail()).rejects.toMatchObject({ kind: 'network' });
    expect(breaker.state).toBe('open');
    await expect(breaker.exec(async () => 'no debería correr')).rejects.toMatchObject({ kind: 'circuit_open' });
    now += 5000;
    expect(breaker.state).toBe('half_open');
    await expect(breaker.exec(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('semiabierto: si la prueba falla vuelve a abrir, y solo deja pasar UNA llamada de prueba a la vez', async () => {
    let now = 0;
    const breaker = new CircuitBreaker('x', { failureThreshold: 1, resetAfterMs: 1000, now: () => now });
    await expect(breaker.exec(async () => { throw new UpstreamError('timeout', 'x'); })).rejects.toBeDefined();
    now = 1000;
    let release: () => void = () => undefined;
    const probe = breaker.exec(() => new Promise<void>((resolve) => { release = resolve; }));
    await expect(breaker.exec(async () => 'segunda')).rejects.toMatchObject({ kind: 'circuit_open' });
    release();
    await probe;
    expect(breaker.state).toBe('closed');
    await expect(breaker.exec(async () => { throw new UpstreamError('timeout', 'x'); })).rejects.toBeDefined();
    now = 5000;
    await expect(breaker.exec(async () => { throw new UpstreamError('timeout', 'x'); })).rejects.toBeDefined();
    expect(breaker.state).toBe('open');
  });

  it('los errores de negocio (4xx) no cuentan para el breaker ni se reintentan', async () => {
    const lonely = new ConnectorsDouble();
    const url = await lonely.start();
    const http = new HttpClient({ name: 'pay-connectors', baseUrl: url, serviceId: 'pay-payments', timeoutMs: 1000, retries: 3, breaker: { failureThreshold: 2, resetAfterMs: 60_000 } });
    for (let i = 0; i < 5; i += 1) expect((await http.request({ method: 'GET', path: '/charges/ch_noexiste00001/status' })).status).toBe(404);
    expect(http.breaker.state).toBe('closed');
    expect(lonely.server.calls).toHaveLength(5); // 5 llamadas, 0 reintentos
    await lonely.stop();
  });

  it('reintenta una llamada idempotente ante un 503 transitorio y NO reintenta una que no lo es', async () => {
    const flaky = new LedgerDouble();
    const url = await flaky.start();
    const http = new HttpClient({ name: 'pay-ledger', baseUrl: url, serviceId: 'pay-payments', timeoutMs: 1000, retries: 2, breaker: { failureThreshold: 10, resetAfterMs: 60_000 } });
    flaky.failNext = 1;
    expect((await http.request({ method: 'GET', path: '/holds/hd_noexiste000001' })).status).toBe(404); // reintentó y llegó
    flaky.failNext = 1;
    const before = flaky.server.calls.length;
    await expect(http.request({ method: 'POST', path: '/transactions', body: { business_ref: 'pi_x:y', attempt: 1, currency: 'BOB', legs: [] } })).rejects.toBeInstanceOf(UpstreamError);
    expect(flaky.server.calls.length - before).toBe(1); // sin clave de idempotencia: un solo intento
    flaky.server.violations.length = 0;
    await flaky.stop();
  });
});
