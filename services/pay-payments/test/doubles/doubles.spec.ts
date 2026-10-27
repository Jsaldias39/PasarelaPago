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
  connectors.scenario = 'ok';
  ledger.failNext = 0;
  ledger.latencyMs = 0;
});

const assessInput = { merchantId: MC, paymentIntentId: PI, amountMinor: 10000, currency: 'BOB', method: 'qr' as const };

describe('[DOBLE] pay-risk (internal-risk-v1)', () => {
  it('correcto: allow, deny y review llegan tal cual', async () => {
    expect((await c.risk.assess(assessInput)).decision).toBe('allow');
    risk.mode = 'deny';
    expect((await c.risk.assess(assessInput)).decision).toBe('deny');
    risk.mode = 'review';
    expect((await c.risk.assess(assessInput)).decision).toBe('review');
  });

  it('límite: una respuesta lenta pero dentro del timeout (300 ms) todavía vale', async () => {
    risk.mode = { slowMs: 150 };
    expect((await c.risk.assess(assessInput)).decision).toBe('allow');
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
  const charge = { paymentIntentId: PI, merchantId: MC, amountMinor: 10000, currency: 'BOB', method: 'qr' as const, expiresAt: '2026-10-27T16:00:00Z' };

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
    const first = await c.connectors.cancelCharge(id, 'k-cancel-0001');
    const again = await c.connectors.cancelCharge(id, 'k-cancel-0001');
    expect(first.ok && first.value.status).toBe('canceled');
    expect(again.ok && again.value.status).toBe('canceled');
    const paid = await c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_paidcharge001' });
    connectors.setChargeStatus(paid.ok ? paid.value.id : '', 'succeeded');
    expect(await c.connectors.cancelCharge(paid.ok ? paid.value.id : '', 'k-cancel-0002')).toMatchObject({ ok: false, status: 409 });
  });

  it('inválido: 422 del proveedor es un fallo de negocio ({ok:false}); la caída es UpstreamError', async () => {
    connectors.scenario = 'decline';
    expect(await c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_declined00001' })).toMatchObject({ ok: false, status: 422 });
    connectors.scenario = 'down';
    await expect(c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_down000000001' })).rejects.toBeInstanceOf(UpstreamError);
  });

  it('límite: el estado del cargo refleja lo que «pagó» el pagador y reembolsar exige un cargo pagado', async () => {
    const created = await c.connectors.createCharge({ ...charge, paymentIntentId: 'pi_statuscheck01' });
    const id = created.ok ? created.value.id : '';
    expect((await c.connectors.getChargeStatus(id)).status).toBe('requires_action');
    expect(await c.connectors.createRefund(id, 1000, 'k-refund-0001')).toMatchObject({ ok: false, status: 409 });
    connectors.setChargeStatus(id, 'succeeded');
    expect((await c.connectors.getChargeStatus(id)).status).toBe('succeeded');
    const refund = await c.connectors.createRefund(id, 1000, 'k-refund-0002');
    expect(refund.ok && refund.value.status).toBe('succeeded');
  });
});

describe('[DOBLE] pay-ledger (internal-ledger-v1, regla H-1 de TigerBeetle)', () => {
  const legs: Leg[] = [
    { debit_account: 'connector:mock:clearing', credit_account: `merchant:${MC}:pending`, amount_minor: 9700, code: 'charge' },
    { debit_account: 'connector:mock:clearing', credit_account: 'platform:fees', amount_minor: 300, code: 'fee' },
  ];
  const tx = (ref: string, attempt: number, l: Leg[] = legs) => c.ledger.createTransaction({ businessRef: ref, attempt, currency: 'BOB', legs: l });

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
    const hold = await c.ledger.createHold({ businessRef: 're_holdok000001:refund', attempt: 1, debitAccount: `merchant:${MC}:available`, creditAccount: 'connector:mock:clearing', amountMinor: 2000, currency: 'BOB', expiresInSeconds: 3600 });
    const id = hold.kind === 'ok' ? hold.value.id : '';
    expect(hold.kind).toBe('ok');
    expect((await c.ledger.postHold(id, 'k-post-00001')).kind).toBe('ok');
    expect((await c.ledger.postHold(id, 'k-post-00001')).kind).toBe('ok'); // misma clave: misma respuesta
    expect((await c.ledger.voidHold(id, 'k-void-00001')).kind).toBe('conflict'); // ya resuelta
    expect(ledger.balance(`merchant:${MC}:available`)).toBe(3000);
    const second = await c.ledger.createHold({ businessRef: 're_holdvoid0001:refund', attempt: 1, debitAccount: `merchant:${MC}:available`, creditAccount: 'connector:mock:clearing', amountMinor: 1000, currency: 'BOB', expiresInSeconds: 3600 });
    expect((await c.ledger.voidHold(second.kind === 'ok' ? second.value.id : '', 'k-void-00002')).kind).toBe('ok');
    expect(ledger.balance(`merchant:${MC}:available`)).toBe(3000);
  });

  it('inválido: una retención sin saldo se rechaza', async () => {
    const hold = await c.ledger.createHold({ businessRef: 're_holdnofund001:refund', attempt: 1, debitAccount: 'merchant:mc_poor0000001:available', creditAccount: 'connector:mock:clearing', amountMinor: 100, currency: 'BOB', expiresInSeconds: 60 });
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
