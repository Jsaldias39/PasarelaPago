import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { VaultController } from '../src/vault/vault.controller';
import { CONNECTORS, MC, MC2, PAYMENTS, normalizeOps, routesOf, startVault, type VaultTest } from './helpers/app';

let v: VaultTest;
let n = 0;
const k = () => `k-vault-${randomBytes(4).toString('hex')}-${n++}`;
const PAN = '4111111111111111';
const CARD = { number: PAN, expMonth: 12, expYear: 2030, cvv: '737', holderName: 'Ana Prueba' };

beforeAll(async () => {
  v = await startVault();
});
afterAll(async () => v.close());

const http = () => request(v.app.getHttpServer());
const openSession = async (merchant = MC, saveCard = false) =>
  (await http().post('/capture_sessions').set(PAYMENTS).set('idempotency-key', k()).send({ merchant_id: merchant, expires_in_seconds: 600, save_card: saveCard })).body.id as string;
/** Abre la sesión, el «pagador» teclea la tarjeta en el formulario alojado y devuelve el token. */
async function tokenFor(merchant = MC, saveCard = false, card = CARD): Promise<string> {
  const id = await openSession(merchant, saveCard);
  v.backend.completeCapture(id, card);
  const session = await http().get(`/capture_sessions/${id}`).set(PAYMENTS);
  expect(session.body.status).toBe('completed');
  return session.body.token as string;
}
const reveal = (token: string, merchant: string, charge: string, headers: Record<string, string> = CONNECTORS) =>
  http().post(`/tokens/${token}/reveal`).set(headers).set('x-merchant-id', merchant).set('idempotency-key', k()).send({ charge_id: charge });

describe('P3.H3.M2 · sesión de captura y tokens por comercio', () => {
  it('abre una sesión (201, conforme al contrato), la repetición con la misma clave devuelve la misma y el pagador la completa', async () => {
    const key = k();
    const body = { merchant_id: MC, payment_intent_id: 'pi_abcdefghij12', expires_in_seconds: 600 };
    const first = await http().post('/capture_sessions').set(PAYMENTS).set('idempotency-key', key).send(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ object: 'capture_session', status: 'open', token: null });
    expect(first.body.capture_url).toMatch(/^https:\/\//);
    expect(v.contract.validateResponse({ method: 'POST', path: '/capture_sessions', status: 201, body: first.body })).toEqual([]);
    const again = await http().post('/capture_sessions').set(PAYMENTS).set('idempotency-key', key).send(body);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotency-replayed']).toBe('true');

    v.backend.completeCapture(first.body.id, CARD);
    const done = await http().get(`/capture_sessions/${first.body.id}`).set(PAYMENTS);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'completed' });
    expect(done.body.capture_url).toBeUndefined(); // solo mientras está abierta
    expect(done.body.token).toMatch(/^tok_[a-z0-9]{10,60}$/);
    expect(v.contract.validateResponse({ method: 'GET', path: `/capture_sessions/${first.body.id}`, status: 200, body: done.body })).toEqual([]);
  });

  it('los metadatos del token no traen el número, el CVV ni el titular', async () => {
    const token = await tokenFor();
    const response = await http().get(`/tokens/${token}`).set(PAYMENTS).set('x-merchant-id', MC);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ object: 'card_token', brand: 'visa', last4: '1111', exp_month: 12, exp_year: 2030, single_use: true });
    expect(v.contract.validateResponse({ method: 'GET', path: `/tokens/${token}`, status: 200, body: response.body })).toEqual([]);
    expect(response.headers['cache-control']).toBe('no-store');
    const text = JSON.stringify(response.body);
    for (const secret of [PAN, '737', 'Ana Prueba']) expect(text).not.toContain(secret);
  });

  it('un token de OTRO comercio no se puede ver, usar ni borrar: 404 idéntico a uno inexistente, y el dueño no pierde el suyo', async () => {
    const token = await tokenFor(MC, true);
    const ghost = 'tok_doesnotexist000000';
    for (const attempt of [
      (t: string) => http().get(`/tokens/${t}`).set(PAYMENTS).set('x-merchant-id', MC2),
      (t: string) => http().delete(`/tokens/${t}`).set(PAYMENTS).set('x-merchant-id', MC2),
      (t: string) => reveal(t, MC2, 'ch_aaaaaaaaaaaa'),
    ]) {
      const foreign = await attempt(token);
      const missing = await attempt(ghost);
      expect(foreign.status).toBe(404);
      expect({ ...foreign.body, instance: undefined }).toEqual({ ...missing.body, instance: undefined });
    }
    expect((await http().get(`/tokens/${token}`).set(PAYMENTS).set('x-merchant-id', MC)).status).toBe(200);
    expect((await reveal(token, MC, 'ch_aaaaaaaaaaaa')).status).toBe(200);
    expect(v.backend.has(token)).toBe(true);
  });

  it('borrar un token es irreversible e idempotente (204 las veces que se repita) y deja de funcionar en todo', async () => {
    const token = await tokenFor(MC, true);
    expect((await http().delete(`/tokens/${token}`).set(PAYMENTS).set('x-merchant-id', MC)).status).toBe(204);
    expect((await http().delete(`/tokens/${token}`).set(PAYMENTS).set('x-merchant-id', MC)).status).toBe(204);
    expect(v.backend.has(token)).toBe(false);
    expect((await http().get(`/tokens/${token}`).set(PAYMENTS).set('x-merchant-id', MC)).status).toBe(404);
    expect((await reveal(token, MC, 'ch_aaaaaaaaaaaa')).status).toBe(404);
    expect((await http().delete('/tokens/tok_neverexisted00000').set(PAYMENTS).set('x-merchant-id', MC)).status).toBe(404);
  });

  it('una sesión desconocida es 404, una abierta que nadie completó sigue abierta y una vencida pasa a expired sin url', async () => {
    expect((await http().get('/capture_sessions/cs_doesnotexist000000').set(PAYMENTS)).status).toBe(404);
    const id = await openSession();
    const open = await http().get(`/capture_sessions/${id}`).set(PAYMENTS);
    expect(open.body).toMatchObject({ status: 'open', token: null });
    v.clock.now = new Date(Date.now() + 3600_000);
    const expired = await http().get(`/capture_sessions/${id}`).set(PAYMENTS);
    expect(expired.body.status).toBe('expired');
    expect(expired.body.capture_url).toBeUndefined();
    v.clock.now = new Date();
  });
});

describe('reveal: único endpoint que devuelve la tarjeta', () => {
  it('lo llama pay-connectors: devuelve los datos, sin caché, conforme al contrato, y deja rastro con el cobro', async () => {
    const token = await tokenFor(MC, true);
    const response = await reveal(token, MC, 'ch_chargeone0001');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ number: PAN, exp_month: 12, exp_year: 2030, holder_name: 'Ana Prueba' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(v.contract.validateResponse({ method: 'POST', path: `/tokens/${token}/reveal`, status: 200, body: response.body })).toEqual([]);
    const audit = await v.db.pool.query('SELECT caller, charge_id, merchant_id, outcome FROM reveal_audit WHERE token = $1', [token]);
    expect(audit.rows).toEqual([{ caller: 'pay-connectors', charge_id: 'ch_chargeone0001', merchant_id: MC, outcome: 'granted' }]);
  });

  it('pay-payments NO puede revelar (403) y no queda ningún dato en la respuesta', async () => {
    const token = await tokenFor(MC, true);
    const response = await reveal(token, MC, 'ch_chargeone0001', PAYMENTS);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(PAN);
  });

  it('token de un solo uso: queda atado al primer cobro (repetirlo para ese cobro sirve; otro cobro, 404 y rastro de la negativa)', async () => {
    const token = await tokenFor(MC, false);
    expect((await reveal(token, MC, 'ch_firstcharge001')).status).toBe(200);
    expect((await reveal(token, MC, 'ch_firstcharge001')).status).toBe(200); // reintento del conector
    const other = await reveal(token, MC, 'ch_secondcharge01');
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain(PAN);
    const outcomes = await v.db.pool.query('SELECT outcome FROM reveal_audit WHERE token = $1 ORDER BY id', [token]);
    expect(outcomes.rows.map((r) => r.outcome)).toEqual(['granted', 'granted', 'denied_bound_to_other_charge']);
  });

  it('una tarjeta guardada (save_card) se puede revelar para varios cobros', async () => {
    const token = await tokenFor(MC, true);
    for (const charge of ['ch_savedone000001', 'ch_savedtwo000001', 'ch_savedthree0001']) expect((await reveal(token, MC, charge)).status).toBe(200);
  });

  it('si no se puede dejar rastro, NO se entrega la tarjeta', async () => {
    const token = await tokenFor(MC, true);
    await v.db.pool.query('ALTER TABLE reveal_audit RENAME TO reveal_audit_off');
    try {
      const response = await reveal(token, MC, 'ch_noaudit0000001');
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain(PAN);
    } finally {
      await v.db.pool.query('ALTER TABLE reveal_audit_off RENAME TO reveal_audit');
    }
  });

  it('el reveal NO guarda su respuesta en la tabla de idempotencia (guardaría el PAN)', async () => {
    const token = await tokenFor(MC, true);
    await reveal(token, MC, 'ch_idemcheck00001');
    const dump = JSON.stringify((await v.db.pool.query('SELECT * FROM idempotency_keys')).rows);
    expect(dump).not.toContain(PAN);
  });

  it('cuerpo inválido: campo no declarado o charge_id con mala forma es 422', async () => {
    const token = await tokenFor(MC, true);
    for (const body of [{}, { charge_id: 'x' }, { charge_id: 'ch_aaaaaaaaaaaa', extra: 1 }, { charge_id: PAN }]) {
      const response = await http().post(`/tokens/${token}/reveal`).set(CONNECTORS).set('x-merchant-id', MC).set('idempotency-key', k()).send(body);
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).not.toContain(PAN);
    }
  });
});

describe('identidad de servicio (solo pay-payments y pay-connectors)', () => {
  const calls: [string, string, string[]][] = [
    ['post', '/capture_sessions', ['pay-payments']],
    ['get', '/capture_sessions/cs_aaaaaaaaaaaa', ['pay-payments']],
    ['get', '/tokens/tok_aaaaaaaaaaaa', ['pay-payments', 'pay-connectors']],
    ['delete', '/tokens/tok_aaaaaaaaaaaa', ['pay-payments', 'pay-connectors']],
    ['post', '/tokens/tok_aaaaaaaaaaaa/reveal', ['pay-connectors']],
  ];
  const call = (method: string, path: string, service: string | undefined) => {
    const agent = http() as unknown as Record<string, (u: string) => request.Test>;
    const req = agent[method]!(path).set('x-merchant-id', MC).set('idempotency-key', k());
    return (service ? req.set('x-service-id', service) : req).send({});
  };

  it.each(calls)('%s %s: solo %j; cualquier otro servicio (incluido pay-edge) o ninguno es 403', async (method, path, allowed) => {
    for (const service of [undefined, 'pay-edge', 'pay-risk', 'pay-ledger', 'pay-schedules', 'pay-merchants', 'pay-qr', 'raro']) expect((await call(method, path, service)).status).toBe(403);
    for (const service of ['pay-payments', 'pay-connectors'].filter((s) => !allowed.includes(s))) expect((await call(method, path, service)).status).toBe(403);
    for (const service of allowed) expect((await call(method, path, service)).status).not.toBe(403);
  });
});

describe('validación y robustez', () => {
  it('abrir sesión: campos no declarados, vencimiento fuera de rango o comercio inválido es 422', async () => {
    for (const body of [{}, { merchant_id: MC }, { merchant_id: MC, expires_in_seconds: 59 }, { merchant_id: MC, expires_in_seconds: 3601 }, { merchant_id: 'x', expires_in_seconds: 600 }, { merchant_id: MC, expires_in_seconds: 600, pan: PAN }, { merchant_id: MC, expires_in_seconds: 600, save_card: 'si' }]) {
      const response = await http().post('/capture_sessions').set(PAYMENTS).set('idempotency-key', k()).send(body);
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).not.toContain(PAN);
    }
    expect((await http().post('/capture_sessions').set(PAYMENTS).send({ merchant_id: MC, expires_in_seconds: 600 })).status).toBe(400);
  });

  it('sin X-Merchant-Id o con ids mal formados no se toca la base', async () => {
    expect((await http().get('/tokens/tok_aaaaaaaaaaaa').set(PAYMENTS)).status).toBe(422);
    expect((await http().get('/tokens/PAN4111').set(PAYMENTS).set('x-merchant-id', MC)).status).toBe(404);
    expect((await http().get('/capture_sessions/xyz').set(PAYMENTS)).status).toBe(404);
  });

  it('el backend caído: 500 genérico, sin su mensaje, y la sesión no queda a medias', async () => {
    v.backend.failNext = 1;
    const response = await http().post('/capture_sessions').set(PAYMENTS).set('idempotency-key', k()).send({ merchant_id: MC, expires_in_seconds: 600 });
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toMatch(/backend|bóveda/i);
  });

  it('la purga elimina los tokens de un solo uso ya usados y deja los demás', async () => {
    const used = await tokenFor(MC, false);
    await reveal(used, MC, 'ch_purgecharge001');
    const saved = await tokenFor(MC, true);
    const unused = await tokenFor(MC, false);
    v.clock.now = new Date(Date.now() + 2 * 3600_000);
    expect(await v.service.purgeSingleUse(3600_000)).toBeGreaterThanOrEqual(1);
    v.clock.now = new Date();
    expect(v.backend.has(used)).toBe(false);
    expect(v.backend.has(saved)).toBe(true);
    expect(v.backend.has(unused)).toBe(true);
  });
});

describe('contrato: el servicio implementa TODO internal-vault-v1.yaml', () => {
  it('cada operación tiene su ruta y no sobra ninguna', () => {
    expect(routesOf(VaultController as never)).toEqual(normalizeOps(v.contract.operations()));
  });
});
