import { newKey, newMerchantId, startWebhooks, type WebhooksHarness } from './harness';

/**
 * La `Idempotency-Key` se guarda EN CLARO en `idempotency_keys`: una con forma de número de tarjeta se rechaza ANTES de tocar la base (regla del repo: el PAN
 * no existe en ningún lado). Tres niveles. Los números son los de PRUEBA públicos de las marcas.
 */
const GOOD = { url: 'https://hooks.comercio.example/pay', enabled_events: ['payment_intent.succeeded'] };

describe('pay-webhooks: Idempotency-Key con forma de PAN', () => {
  let h: WebhooksHarness;
  beforeAll(async () => {
    h = await startWebhooks({});
  });
  afterAll(async () => h.stop());

  it('CORRECTO: una clave legítima crea el endpoint y se guarda tal cual', async () => {
    const key = newKey();
    const res = await h.as(newMerchantId()).post('/webhook_endpoints').set('Idempotency-Key', key).send(GOOD);
    expect(res.status).toBe(201);
    expect((await h.db.pool.query('SELECT 1 FROM idempotency_keys WHERE key = $1', [key])).rows).toHaveLength(1);
  });

  it.each([
    ['pelado', '4111111111111111'],
    ['con guiones', '4111-1111-1111-1111'],
    ['con prefijo', 'orden-4111111111111111'],
    ['Amex', '378282246310005'],
  ])('LÍMITE — %s: 422 validation_failed/card_number_detected, NO se crea el endpoint, NO se guarda la clave y la respuesta no repite el valor', async (_name, key) => {
    const before = Number((await h.db.pool.query('SELECT count(*)::int AS n FROM webhook_endpoints')).rows[0].n);
    const res = await h.as(newMerchantId()).post('/webhook_endpoints').set('Idempotency-Key', key).send(GOOD);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'validation_failed', errors: [{ field: 'idempotency-key', code: 'card_number_detected' }] });
    expect(JSON.stringify(res.body)).not.toContain(key);
    expect(JSON.stringify(res.body)).not.toContain(key.replace(/\D/g, ''));
    expect(Number((await h.db.pool.query('SELECT count(*)::int AS n FROM webhook_endpoints')).rows[0].n)).toBe(before);
    expect((await h.db.pool.query("SELECT 1 FROM idempotency_keys WHERE key ~ '4111|378282246310005'")).rows).toHaveLength(0);
  });

  it('INVÁLIDO: una clave que ya fallaba por formato sigue dando invalid_format', async () => {
    const res = await h.as(newMerchantId()).post('/webhook_endpoints').set('Idempotency-Key', 'corta').send(GOOD);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ errors: [{ field: 'idempotency-key', code: 'invalid_format' }] });
  });
});
