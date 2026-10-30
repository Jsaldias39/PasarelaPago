import request from 'supertest';
import { verify } from '@pay/webhook-signature';
import { SCENARIOS } from '../src/bank/scenarios';
import { asConnectors, chargeBody, createTestApp, deliver, get, post, type TestApp } from './support/app';

// Un caso por fila de la tabla de escenarios (README § Escenarios, `src/bank/scenarios.ts`), cada uno con SU importe fijo: Bs 100,0N.
// El banco decide por los centavos; nada de azar. Toda confirmación llega por un callback FIRMADO que se verifica con el secreto sintético.
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
});

const AMOUNT = (cents: number) => 10000 + cents;

/** Crea un cobro con el importe del escenario y devuelve su referencia junto con la respuesta. */
async function open(cents: number, over: Record<string, unknown> = {}) {
  const body = chargeBody({ amount_minor: AMOUNT(cents), ...over }, t.clock);
  const response = await post(t, '/sandbox/charges', body);
  return { reference: body.reference as string, body, response };
}
const statusOf = async (reference: string) => (await get(t, `/sandbox/charges/${reference}`)).body as { status: string; failure_code?: string };

type Callback = { id: string; type: string; reference: string; status: string; amount_minor: number; failure_code?: string };
/** Cada entrega recibida se verifica con Standard Webhooks igual que lo haría pay-connectors. */
const verified = (): Callback[] =>
  t.receiver.received.map((r) => {
    verify({ headers: r.headers as Record<string, string>, payload: Buffer.from(r.rawBody, 'utf8'), secrets: [t.config.webhookSecret], now: Math.floor(t.clock.now().getTime() / 1000) });
    return JSON.parse(r.rawBody) as Callback;
  });

describe('la tabla cubre las diez filas', () => {
  it('SCENARIOS tiene los centavos 0 a 9, sin repetir, y cada fila trae importe de ejemplo', () => {
    expect(SCENARIOS.map((s) => s.cents)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const s of SCENARIOS) expect(s.example).toBe(`Bs 100,0${s.cents}`);
  });

  it('un importe fuera de la tabla (centavos 10 a 99) se aprueba', async () => {
    const { reference, response } = await open(37);
    expect(response.status).toBe(201);
    await deliver(t);
    expect(verified().map((e) => [e.reference, e.status])).toEqual([[reference, 'captured']]);
  });
});

describe('escenarios deterministas por importe (P4.H4.M3)', () => {
  it('00 aprobado (Bs 100,00): nace pendiente, está cobrado y entrega UN callback captured firmado', async () => {
    const { reference, response } = await open(0);
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('pending');
    t.contract.assertResponse({ method: 'POST', path: '/sandbox/charges', status: 201, body: response.body });
    expect((await statusOf(reference)).status).toBe('captured');
    expect(await deliver(t)).toEqual({ delivered: 1, failed: 0 });
    expect(verified()).toEqual([expect.objectContaining({ reference, status: 'captured', amount_minor: AMOUNT(0), type: 'charge.status' })]);
    expect(await deliver(t)).toEqual({ delivered: 0, failed: 0 }); // ya entregado: no se repite
  });

  it('01 rechazado (Bs 100,01): failed con card_declined de forma síncrona; nunca se paga ni se entrega nada', async () => {
    const { reference, response } = await open(1);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
    expect(await statusOf(reference)).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
    t.clock.advance(7_200_000);
    await deliver(t);
    expect(t.receiver.received).toHaveLength(0);
  });

  it('02 demorado (Bs 100,02): pendiente hasta MOCKBANK_DELAY_MS (límite exacto incluido); el callback sale entonces', async () => {
    const { reference } = await open(2);
    expect((await statusOf(reference)).status).toBe('pending');
    t.clock.advance(t.config.delayMs - 1);
    expect((await statusOf(reference)).status).toBe('pending');
    await deliver(t);
    expect(t.receiver.received).toHaveLength(0);
    t.clock.advance(1);
    expect((await statusOf(reference)).status).toBe('captured');
    await deliver(t);
    expect(verified().map((e) => e.status)).toEqual(['captured']);
  });

  it('03 callback duplicado (Bs 100,03): TRES entregas con el mismo id de evento y el mismo cuerpo', async () => {
    const { reference } = await open(3);
    await deliver(t);
    const events = verified();
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.id)).size).toBe(1);
    expect(new Set(t.receiver.received.map((r) => r.rawBody)).size).toBe(1);
    expect(events.every((e) => e.reference === reference && e.status === 'captured')).toBe(true);
  });

  it('04 fuera de orden (Bs 100,04): llega captured y DESPUÉS authorized, con ids distintos', async () => {
    await open(4);
    await deliver(t);
    const events = verified();
    expect(events.map((e) => e.status)).toEqual(['captured', 'authorized']);
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });

  it('05 callback perdido (Bs 100,05): no se entrega NUNCA nada; la consulta de estado revela captured', async () => {
    const { reference } = await open(5);
    t.clock.advance(60_000);
    expect(await deliver(t)).toEqual({ delivered: 0, failed: 0 });
    expect(t.receiver.received).toHaveLength(0);
    expect((await statusOf(reference)).status).toBe('captured');
  });

  it('06 banco caído (Bs 100,06): 503 bank_unavailable, no se crea nada y el mismo importe sigue cayendo', async () => {
    const { reference, response } = await open(6);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('bank_unavailable');
    t.contract.assertResponse({ method: 'POST', path: '/sandbox/charges', status: 503, body: response.body });
    expect((await get(t, `/sandbox/charges/${reference}`)).status).toBe(404); // no se creó nada: seguro reintentar o pasar a otro
    expect((await post(t, '/sandbox/charges', { ...chargeBody({ amount_minor: AMOUNT(6) }, t.clock), reference })).status).toBe(503);
  });

  it('07 timeout ambiguo (Bs 100,07): el cobro SE CREA pero la conexión se corta sin respuesta; repetir la referencia devuelve el mismo cobro', async () => {
    const body = chargeBody({ amount_minor: AMOUNT(7) }, t.clock);
    await expect(request(t.app.getHttpServer()).post('/sandbox/charges').set(asConnectors).send(body as object).timeout({ response: 150, deadline: 1500 })).rejects.toBeDefined();
    const existing = await get(t, `/sandbox/charges/${body.reference as string}`);
    expect(existing.status).toBe(200); // la orden se ejecutó
    expect(existing.body.status).toBe('captured');
    const again = await post(t, '/sandbox/charges', body);
    expect(again.status).toBe(200); // mismo cobro, no uno nuevo
    expect(again.body.bank_reference).toBe(existing.body.bank_reference);
    await deliver(t);
    expect(verified().map((e) => e.status)).toEqual(['captured']); // y su callback salió una sola vez
  });

  it('08 nunca pagado (Bs 100,08): pendiente hasta expires_at y entonces expired; no hay callback', async () => {
    const { reference } = await open(8, { expires_at: new Date(t.clock.now().getTime() + 60_000).toISOString() });
    expect((await statusOf(reference)).status).toBe('pending');
    t.clock.advance(59_999);
    expect((await statusOf(reference)).status).toBe('pending');
    t.clock.advance(1);
    expect((await statusOf(reference)).status).toBe('expired');
    await deliver(t);
    expect(t.receiver.received).toHaveLength(0);
  });

  it('09 extracto con diferencia (Bs 100,09): se cobra Bs 100,09 y el extracto trae Bs 1,00 menos', async () => {
    const { reference } = await open(9);
    expect((await statusOf(reference)).status).toBe('captured');
    const statement = await get(t, `/sandbox/statement?from=${new Date(t.clock.now().getTime() - 60_000).toISOString()}&to=${new Date(t.clock.now().getTime() + 60_000).toISOString()}`);
    expect(statement.status).toBe(200);
    t.contract.assertResponse({ method: 'GET', path: '/sandbox/statement', status: 200, body: statement.body });
    expect(statement.body.data).toEqual([expect.objectContaining({ our_reference: reference, direction: 'credit', amount_minor: AMOUNT(9) - 100, currency: 'BOB' })]);
    await deliver(t);
    expect(verified()[0]?.amount_minor).toBe(AMOUNT(9)); // el callback sí informa lo cobrado
  });
});
