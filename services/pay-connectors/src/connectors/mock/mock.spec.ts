import { generateSecret, signedHeaders } from '@pay/webhook-signature';
import { ConnectorRejectedError, ConnectorTimeoutError, ConnectorUnavailableError, type ProviderChargeRequest } from '../../domain/connector';
import { EnvSecretProvider } from '../../domain/secrets';
import { MockConnector, type QrPort } from './mock.connector';
import { SCENARIOS, scenarioFor, seededRandom } from './scenarios';
import { SimulatedBank } from './simulated-bank';

// [DOBLE] pay-qr: payload con la forma de un QR EMVCo. Lo que se prueba acá es el simulador, no el QR.
const qr: QrPort = { issue: async (i) => ({ payload: `00020101021263040000`, expiresAt: i.expiresAt }) };
const SECRET = generateSecret();
const NOW = new Date('2026-10-27T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const setup = (options: { seed?: number; delayMs?: number } = {}) => {
  const bank = new SimulatedBank(options);
  const connector = new MockConnector({ bank, qr, secrets: new EnvSecretProvider({ PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET: SECRET }) });
  return { bank, connector };
};
let n = 0;
const request = (cents: number, over: Partial<ProviderChargeRequest> = {}): ProviderChargeRequest => ({
  reference: `ch_ref${String((n += 1)).padStart(12, '0')}`,
  paymentIntentId: 'pi_aaaaaaaaaaaaaaaa',
  merchantId: 'mc_aaaaaaaaaaaaaaaa',
  amountMinor: 10000n + BigInt(cents),
  currency: 'BOB',
  method: 'qr',
  expiresAt: at(3_600_000),
  ...over,
});

describe('escenarios del simulador [DOBLE] — un caso por fila de la tabla (P4.H1.M4)', () => {
  it('la tabla tiene los 10 escenarios con centavos únicos 00–09 y `scenarioFor` los resuelve', () => {
    expect(SCENARIOS.map((s) => s.cents)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const s of SCENARIOS) expect(scenarioFor(10000n + BigInt(s.cents))).toBe(s.scenario);
    expect(scenarioFor(0n)).toBe('approved');
  });

  it.each([10, 11, 50, 99])('centavos %i (fuera de la tabla) ⇒ aprobado', (cents) => {
    expect(scenarioFor(BigInt(10000 + cents))).toBe('approved');
    expect(scenarioFor(BigInt(cents))).toBe('approved');
  });

  it('00 aprobado: pendiente con QR; el callback `captured` llega enseguida; la consulta dice captured', async () => {
    const { bank, connector } = setup();
    const r = request(0);
    const result = await connector.createCharge(r, NOW);
    expect(result).toMatchObject({ status: 'pending', providerReference: 'SIM-000001', nextAction: { type: 'display_qr' } });
    expect(bank.dueCallbacks(NOW).map((c) => c.status)).toEqual(['captured']);
    expect(await connector.getStatus(r.reference, NOW)).toMatchObject({ status: 'captured' });
  });

  it('01 rechazado: `failed` con `card_declined` de forma síncrona, sin QR ni callbacks', async () => {
    const { bank, connector } = setup();
    const r = request(1);
    expect(await connector.createCharge(r, NOW)).toEqual({ providerReference: 'SIM-000001', status: 'failed', failureCode: 'card_declined' });
    expect(bank.dueCallbacks(at(1e9))).toEqual([]);
    expect(await connector.getStatus(r.reference, at(1e9))).toMatchObject({ status: 'failed', failureCode: 'card_declined' });
  });

  it('02 demorado: el callback llega recién a los `delayMs` (límite exacto incluido)', async () => {
    const { bank, connector } = setup({ delayMs: 5000 });
    const r = request(2);
    await connector.createCharge(r, NOW);
    expect(await connector.getStatus(r.reference, at(4999))).toMatchObject({ status: 'pending' });
    expect(bank.dueCallbacks(at(4999))).toEqual([]);
    expect(await connector.getStatus(r.reference, at(5000))).toMatchObject({ status: 'captured' });
    expect(bank.dueCallbacks(at(5000)).map((c) => c.status)).toEqual(['captured']);
  });

  it('03 duplicado: el mismo hecho 3 veces con el MISMO id de evento', async () => {
    const { bank, connector } = setup();
    await connector.createCharge(request(3), NOW);
    const due = bank.dueCallbacks(NOW);
    expect(due).toHaveLength(3);
    expect(new Set(due.map((c) => c.eventId)).size).toBe(1);
    expect(new Set(due.map((c) => c.status))).toEqual(new Set(['captured']));
  });

  it('04 fuera de orden: llega `captured` y después `authorized`, con `occurredAt` anterior', async () => {
    const { bank, connector } = setup();
    await connector.createCharge(request(4), NOW);
    const due = bank.dueCallbacks(NOW);
    expect(due.map((c) => c.status)).toEqual(['captured', 'authorized']);
    expect((due[0]?.occurredAt.getTime() ?? 0) > (due[1]?.occurredAt.getTime() ?? 0)).toBe(true);
    expect(new Set(due.map((c) => c.eventId)).size).toBe(2);
  });

  it('05 callback perdido: no hay entregas, pero la consulta revela `captured`', async () => {
    const { bank, connector } = setup();
    const r = request(5);
    await connector.createCharge(r, NOW);
    expect(bank.dueCallbacks(at(1e9))).toEqual([]);
    expect(await connector.getStatus(r.reference, NOW)).toMatchObject({ status: 'captured' });
  });

  it('06 caído: createCharge falla con ConnectorUnavailableError y no se crea nada', async () => {
    const { bank, connector } = setup();
    const r = request(6);
    await expect(connector.createCharge(r, NOW)).rejects.toBeInstanceOf(ConnectorUnavailableError);
    expect(bank.statement({ from: at(-1e9), to: at(1e9) })).toEqual([]);
    await expect(connector.getStatus(r.reference, NOW)).rejects.toBeInstanceOf(ConnectorRejectedError); // el proveedor no conoce esa referencia
  });

  it('07 timeout ambiguo: el cobro SE CREA pero la respuesta se pierde; reintentar con la misma referencia devuelve el MISMO cobro', async () => {
    const { bank, connector } = setup();
    const r = request(7);
    await expect(connector.createCharge(r, NOW)).rejects.toBeInstanceOf(ConnectorTimeoutError);
    const retry = await connector.createCharge(r, NOW);
    expect(retry.providerReference).toBe('SIM-000001');
    expect(bank.statement({ from: at(-1e9), to: at(1e9) }).filter((l) => l.ourReference === r.reference)).toHaveLength(1);
  });

  it('08 nunca pagado: pendiente hasta `expiresAt`, luego `expired`; se puede anular antes, no después', async () => {
    const { bank, connector } = setup();
    const r = request(8, { expiresAt: at(60_000) });
    await connector.createCharge(r, NOW);
    expect(bank.dueCallbacks(at(1e9))).toEqual([]);
    expect(await connector.getStatus(r.reference, at(59_999))).toMatchObject({ status: 'pending' });
    expect(await connector.getStatus(r.reference, at(60_000))).toMatchObject({ status: 'expired' });
    await expect(connector.cancel(r.reference, at(60_000))).rejects.toMatchObject({ code: 'invalid_state_transition' });

    const early = request(8, { expiresAt: at(60_000) });
    await connector.createCharge(early, NOW);
    expect(await connector.cancel(early.reference, at(1000))).toEqual({ status: 'canceled' });
    expect(await connector.cancel(early.reference, at(2000))).toEqual({ status: 'canceled' }); // idempotente
  });

  it('09 extracto con diferencia: se cobra bien pero el extracto trae Bs 1,00 menos', async () => {
    const { bank, connector } = setup();
    const r = request(9);
    await connector.createCharge(r, NOW);
    const [line] = bank.statement({ from: at(-1000), to: at(1000) });
    expect(line).toMatchObject({ ourReference: r.reference, direction: 'credit', amountMinor: r.amountMinor - 100n });
  });
});

describe('simulador: propiedades comunes', () => {
  it('idempotente por referencia: cobrar dos veces lo mismo no crea otro cobro', async () => {
    const { bank, connector } = setup();
    const r = request(0);
    const a = await connector.createCharge(r, NOW);
    const b = await connector.createCharge(r, NOW);
    expect(b.providerReference).toBe(a.providerReference);
    expect(bank.statement({ from: at(-1000), to: at(1000) })).toHaveLength(1);
    expect(bank.dueCallbacks(NOW)).toHaveLength(1);
  });

  it('reproducible por semilla: misma semilla ⇒ mismos ids de evento; otra semilla ⇒ otros', async () => {
    const ids = async (seed: number) => {
      const { bank, connector } = setup({ seed });
      const out: string[] = [];
      for (const cents of [0, 3, 4]) {
        await connector.createCharge({ ...request(cents), reference: `ch_seed${seed}${cents}aaaaaaaaaa` }, NOW);
        out.push(...bank.dueCallbacks(NOW).map((c) => c.eventId));
      }
      return out;
    };
    expect(await ids(42)).toEqual(await ids(42));
    expect(await ids(42)).not.toEqual(await ids(43));
    const a = seededRandom(7);
    const b = seededRandom(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('reembolsos: parcial, total, sobre lo cobrado (falla), sobre cobro no pagado (rechazado) e idempotente por referencia', async () => {
    const { connector } = setup();
    const paid = request(0);
    await connector.createCharge(paid, NOW);
    const refund = (reference: string, amountMinor: bigint) => connector.refund({ reference, chargeReference: paid.reference, amountMinor }, NOW);
    expect(await refund('cr_a', 3000n)).toMatchObject({ status: 'captured' });
    expect(await refund('cr_a', 3000n)).toMatchObject({ status: 'captured' }); // misma referencia: no reembolsa dos veces
    expect(await refund('cr_b', 7000n)).toMatchObject({ status: 'captured' }); // total acumulado = cobrado
    expect(await refund('cr_c', 1n)).toMatchObject({ status: 'failed', failureCode: 'validation_failed' });

    const declined = request(1);
    await connector.createCharge(declined, NOW);
    await expect(connector.refund({ reference: 'cr_d', chargeReference: declined.reference, amountMinor: 1n }, NOW)).rejects.toMatchObject({ code: 'invalid_state_transition' });
    await expect(connector.refund({ reference: 'cr_e', chargeReference: 'ch_nope', amountMinor: 1n }, NOW)).rejects.toBeInstanceOf(ConnectorRejectedError);
  });

  it('banco caído: todas las operaciones fallan con ConnectorUnavailableError y el sondeo lo refleja', async () => {
    const { bank, connector } = setup();
    const r = request(0);
    await connector.createCharge(r, NOW);
    bank.setDown(true);
    expect(await connector.probe()).toMatchObject({ ok: false, reason: 'unreachable' });
    await expect(connector.createCharge(request(0), NOW)).rejects.toBeInstanceOf(ConnectorUnavailableError);
    await expect(connector.getStatus(r.reference, NOW)).rejects.toBeInstanceOf(ConnectorUnavailableError);
    await expect(connector.cancel(r.reference, NOW)).rejects.toBeInstanceOf(ConnectorUnavailableError);
    await expect(connector.refund({ reference: 'cr_x', chargeReference: r.reference, amountMinor: 1n }, NOW)).rejects.toBeInstanceOf(ConnectorUnavailableError);
    await expect(connector.fetchStatement({ from: at(-1000), to: at(1000) })).rejects.toBeInstanceOf(ConnectorUnavailableError);
    bank.setDown(false);
    expect(await connector.probe()).toMatchObject({ ok: true });
    bank.setDown(true);
    bank.reset();
    expect(await connector.probe()).toMatchObject({ ok: true });
  });

  it('el QR que devuelve pay-qr se valida: un payload que no es EMV es un fallo interno, no algo que mostrarle al pagador (3 niveles del doble)', async () => {
    const make = (payload: string) => new MockConnector({ bank: new SimulatedBank(), secrets: new EnvSecretProvider({}), qr: { issue: async (i) => ({ payload, expiresAt: i.expiresAt }) } });
    // correcto
    expect(await make('0002010102126304ABCD').createCharge(request(0), NOW)).toMatchObject({ nextAction: { type: 'display_qr', payload: '0002010102126304ABCD' } });
    // límite: el payload más corto que cumple la forma (`000201` + `6304` + 4 hex)
    expect(await make('00020163040000').createCharge(request(0), NOW)).toMatchObject({ nextAction: { type: 'display_qr' } });
    // inválido
    for (const bad of ['', 'hola', '000201', '0002016304ZZZZ', '0002016304abcd', '010201630400AB']) {
      await expect(make(bad).createCharge(request(0), NOW)).rejects.toMatchObject({ code: 'internal_error' });
    }
  });

  it('tarjeta y transferencia no piden QR: devuelven la redirección y las instrucciones', async () => {
    const { connector } = setup();
    const card = await connector.createCharge(request(0, { method: 'card' }), NOW);
    expect(card.nextAction).toMatchObject({ type: 'redirect_to_card_form', url: expect.stringMatching(/^https:\/\/sandbox\.invalid\//) });
    const r = request(0, { method: 'bank_transfer' });
    expect((await connector.createCharge(r, NOW)).nextAction).toEqual({ type: 'bank_transfer_instructions', reference: r.reference });
  });
});

describe('verifyCallback del simulador (Standard Webhooks) — correcto, límite, inválido', () => {
  const { connector } = setup();
  const body = JSON.stringify({ id: 'evt_1', type: 'charge.status', reference: 'ch_aaaaaaaaaaaaaaaa', status: 'captured', occurred_at: NOW.toISOString(), amount_minor: 10000 });
  const verify = (over: { payload?: string; ts?: number; secrets?: string[]; now?: Date } = {}) => {
    const payload = over.payload ?? body;
    const headers = signedHeaders({ id: 'evt_1', timestamp: over.ts ?? Math.floor(NOW.getTime() / 1000), payload, secrets: over.secrets ?? [SECRET] });
    return connector.verifyCallback({ headers, rawBody: Buffer.from(payload), now: over.now ?? NOW });
  };

  it('correcto: devuelve el evento interpretado', async () => {
    expect(await verify()).toEqual({ ok: true, events: [{ providerEventId: 'evt_1', chargeReference: 'ch_aaaaaaaaaaaaaaaa', status: 'captured', occurredAt: NOW, amountMinor: 10000n }] });
  });

  it('límite: a 300 s del timestamp pasa; a 301 s no', async () => {
    const ts = Math.floor(NOW.getTime() / 1000);
    expect((await verify({ ts, now: new Date((ts + 300) * 1000) })).ok).toBe(true);
    expect((await verify({ ts, now: new Date((ts + 301) * 1000) })).ok).toBe(false);
    expect((await verify({ ts, now: new Date((ts - 301) * 1000) })).ok).toBe(false);
  });

  it('inválido: otro secreto, cuerpo alterado, sin firma ⇒ ok:false (sin motivo); firmado pero ilegible ⇒ malformed', async () => {
    expect(await verify({ secrets: [generateSecret()] })).toEqual({ ok: false });
    const tampered = connector.verifyCallback({ headers: signedHeaders({ id: 'evt_1', timestamp: Math.floor(NOW.getTime() / 1000), payload: body, secrets: [SECRET] }), rawBody: Buffer.from(body.replace('captured', 'failed')), now: NOW });
    expect(await tampered).toEqual({ ok: false });
    expect(await connector.verifyCallback({ headers: {}, rawBody: Buffer.from(body), now: NOW })).toEqual({ ok: false });
    expect(await verify({ payload: 'no es json' })).toEqual({ ok: false, malformed: true });
    expect(await verify({ payload: '{"id":"x"}' })).toEqual({ ok: false, malformed: true });
  });

  it('sin secreto configurado: rechaza todo, aunque la firma sea «válida» para un secreto vacío', async () => {
    const empty = new MockConnector({ bank: new SimulatedBank(), qr, secrets: new EnvSecretProvider({}) });
    const headers = signedHeaders({ id: 'evt_1', timestamp: Math.floor(NOW.getTime() / 1000), payload: body, secrets: [SECRET] });
    expect(await empty.verifyCallback({ headers, rawBody: Buffer.from(body), now: NOW })).toEqual({ ok: false });
  });

  it('firma callbacks que él mismo verifica (ida y vuelta)', async () => {
    const { bank, connector: c } = setup();
    const r = request(0);
    await c.createCharge(r, NOW);
    const [cb] = bank.dueCallbacks(NOW);
    const signed = await c.signCallback(cb as NonNullable<typeof cb>, NOW);
    expect(await c.verifyCallback({ headers: signed.headers, rawBody: signed.rawBody, now: NOW })).toMatchObject({ ok: true, events: [{ chargeReference: r.reference, status: 'captured', amountMinor: r.amountMinor }] });
  });
});
