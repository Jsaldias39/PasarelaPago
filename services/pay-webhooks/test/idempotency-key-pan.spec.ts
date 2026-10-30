import { newKey, newMerchantId, startWebhooks, type WebhooksHarness } from './harness';

/**
 * La `Idempotency-Key` se guarda EN CLARO en `idempotency_keys`: una con forma de número de tarjeta se guarda como su hash (`masked-<sha256>`), nunca tal cual
 * (regla del repo: el PAN no existe en ningún lado). NO se rechaza (falsos positivos con claves hexadecimales). Tres niveles. Números de PRUEBA públicos.
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
    ['con separadores raros', '4111+1111:1111;1111'],
  ])('LÍMITE — %s: el endpoint se crea, la clave se guarda como masked-<sha256> y la repetición con la MISMA clave devuelve el MISMO endpoint (sin duplicar)', async (_name, key) => {
    const merchant = newMerchantId();
    const first = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', key).send(GOOD);
    const second = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', key).send(GOOD);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    const stored = (await h.db.pool.query('SELECT key FROM idempotency_keys WHERE key LIKE \'masked-%\'')).rows.map((r) => r.key as string);
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(first.body)).not.toContain(key.replace(/\D/g, ''));
    expect((await h.db.pool.query("SELECT 1 FROM idempotency_keys WHERE key ~ '4111|378282246310005'")).rows).toHaveLength(0);
  });

  it('INVÁLIDO: una clave que ya fallaba por formato sigue dando invalid_format', async () => {
    const res = await h.as(newMerchantId()).post('/webhook_endpoints').set('Idempotency-Key', 'corta').send(GOOD);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ errors: [{ field: 'idempotency-key', code: 'invalid_format' }] });
  });
});
