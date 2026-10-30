import { insertEndpoint } from '../../src/endpoints/endpoint.repository';
import { SvixReconciler, type SvixReconcilerOptions } from '../../src/engine/svix/svix-reconciler';
import { ORPHAN_REVIEW_KEY, ORPHAN_REVIEW_RELEASED, SVIX_OWNER_KEY } from '../../src/engine/svix/svix-namespace';
import { cloudEvent } from '../fixtures';
import { newMerchantId } from '../harness';
import { eventually } from './svix-env';
import { startSvixHarness, type SvixHarness } from './svix-harness';

/**
 * RE-REVISION-DINERO F-B1 contra un svix-server REAL (1.104.0), Postgres real y receptores HTTPS reales que verifican la firma.
 *
 * Escenario de la revisión: se restaura la base de pay-webhooks a un punto anterior; los endpoints creados DESPUÉS del punto de restauración siguen en Svix
 * (con su marca `pay_owner`) pero ya no tienen fila local. Antes el reconciliador los BORRABA (3 de 3 en la sonda B; irreversible: el secreto se pierde).
 * Ahora, por defecto, los DESHABILITA (reversible), y reactivarlos restablece la entrega con el procedimiento de docs/runbooks/sandbox-a-produccion.md.
 * La «restauración» se reproduce borrando las filas posteriores al «respaldo»: es el mismo estado (Svix los tiene, la base no); no se ejecutó un `pg_restore`.
 */
const TYPE = 'payment_intent.succeeded';
const t = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('F-B1 · huérfanos propios: se deshabilitan (reversible), el borrado solo es explícito', () => {
  let s: SvixHarness;
  beforeAll(async () => {
    s = await startSvixHarness();
  });
  afterAll(async () => s.stop());
  // El reconciliador solo recorre los comercios con al menos un endpoint local (F-B4): vaciar la tabla deja fuera los comercios de las pruebas anteriores.
  beforeEach(async () => {
    await s.h.db.pool.query('DELETE FROM webhook_endpoints');
  });

  /** Estricto (sin gracia ni margen): la edad no es la variable de la prueba. Por defecto: la acción por defecto del servicio. */
  const reconciler = (options: Partial<SvixReconcilerOptions> = {}) => new SvixReconciler(s.h.db.pool, s.client, { orphanGraceMs: 0, clockMarginMs: 0, concurrency: 2, ...options });
  const remote = async (merchant: string) => new Map(((await s.client.listEndpoints(merchant)) ?? []).map((e) => [e.uid as string, e]));
  const rowExists = async (id: string) => (await s.h.db.pool.query('SELECT 1 FROM webhook_endpoints WHERE id = $1', [id])).rowCount === 1;

  /** Un comercio con un endpoint «anterior al respaldo» (A) y otro «posterior» (B), ambos dados de alta por la API pública; luego la base «se restaura»: B pierde su fila. */
  async function restoredMerchant() {
    const merchant = newMerchantId();
    const receiverA = await s.receiver();
    const receiverB = await s.receiver();
    const a = await s.createEndpoint(merchant, receiverA);
    const b = await s.createEndpoint(merchant, receiverB);
    await s.h.db.pool.query('DELETE FROM webhook_endpoints WHERE id = $1', [b.id]);
    return { merchant, a, b, receiverA, receiverB };
  }

  t('CORRECTO (la sonda B de la revisión): tras la restauración ningún endpoint posterior se borra; se deshabilitan, su secreto sigue en Svix y los anteriores no se tocan', async () => {
    const world = await Promise.all([restoredMerchant(), restoredMerchant(), restoredMerchant()]);
    const pass = reconciler();
    expect(pass.action).toBe('disable'); // el defecto del reconciliador
    const summary = await pass.runOnce();

    expect(summary).toMatchObject({ merchants: 3, orphansDeleted: 0, orphansWithheld: 0, orphansDisabled: 3, orphansHeldDisabled: 0 });
    for (const { merchant, a, b } of world) {
      const endpoints = await remote(merchant);
      expect(endpoints.size).toBe(2); // ninguno se borró
      expect(endpoints.get(b.id)).toMatchObject({ disabled: true, metadata: { [SVIX_OWNER_KEY]: 'sandbox' } });
      expect(endpoints.get(a.id)).toMatchObject({ disabled: false });
      // el secreto del comercio NO se perdió: Svix todavía lo tiene
      expect(await s.client.getEndpointKey(merchant, b.id)).toBe(b.secret);
    }
    expect(pass.disabledStats).toEqual({ disabledTotal: 3, heldDisabled: 3 });
  });

  t('CORRECTO: un huérfano deshabilitado ya no recibe eventos del comercio, y las pasadas siguientes no lo vuelven a tocar (ni cuentan como nuevo)', async () => {
    const { merchant, a, receiverA, receiverB } = await restoredMerchant();
    const pass = reconciler();
    await pass.runOnce();

    const event = cloudEvent(TYPE, merchant);
    expect(await s.h.ingest.ingest(event)).toEqual({ kind: 'queued', deliveries: 1 }); // la tabla local solo conoce a A
    await eventually(async () => receiverA.receiver.accepted.length, (n) => n === 1);
    await sleep(1_500);
    expect(receiverB.requests).toHaveLength(0); // el huérfano deshabilitado no recibe nada
    expect(a.id).toMatch(/^we_/);

    const again = await pass.runOnce();
    expect(again).toMatchObject({ orphansDisabled: 0, orphansHeldDisabled: 1, orphansDeleted: 0 });
    expect(pass.disabledStats).toEqual({ disabledTotal: 1, heldDisabled: 1 });
  });

  t('CORRECTO (el procedimiento): reactivar con la marca de liberado restablece la entrega; el reconciliador lo respeta y, al re-adoptar la fila, queda gestionado', async () => {
    const { merchant, a, b, receiverA, receiverB } = await restoredMerchant();
    const pass = reconciler();
    await pass.runOnce();
    expect((await remote(merchant)).get(b.id)?.disabled).toBe(true);

    // Paso 1 del runbook: PATCH en Svix. Svix REEMPLAZA los metadatos, por eso se reenvía `pay_owner` junto con la marca de liberado.
    await s.client.call('PATCH', `/api/v1/app/${merchant}/endpoint/${b.id}`, { body: { disabled: false, metadata: { [SVIX_OWNER_KEY]: 'sandbox', [ORPHAN_REVIEW_KEY]: ORPHAN_REVIEW_RELEASED } }, expect: [200] });
    const after = await pass.runOnce();
    expect(after).toMatchObject({ orphansReleased: 1, orphansDisabled: 0, orphansDeleted: 0 });
    expect((await remote(merchant)).get(b.id)).toMatchObject({ disabled: false });

    // La entrega se restablece: el siguiente evento del comercio llega a AMBOS endpoints, firmado con el secreto que el comercio ya tenía.
    const event = cloudEvent(TYPE, merchant);
    await s.h.ingest.ingest(event);
    await eventually(async () => [receiverA.receiver.accepted.length, receiverB.receiver.accepted.length], ([x, y]) => x === 1 && y === 1);

    // Paso 2: re-adoptar (volver a insertar la fila). Con la fila el reconciliador ya lo gestiona como a cualquier endpoint.
    await insertEndpoint(s.h.db.pool, { id: b.id, merchantId: merchant, url: receiverB.url, description: null, enabledEvents: [TYPE], signatureScheme: 'v1' });
    const adopted = await pass.runOnce();
    expect(adopted).toMatchObject({ orphansReleased: 0, orphansDisabled: 0, orphansDeleted: 0, endpoints: 2 });
    expect(await rowExists(b.id)).toBe(true);
    const listed = (await s.h.as(merchant).get('/webhook_endpoints')).body.data as { id: string }[];
    expect(listed.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
    expect((await remote(merchant)).get(b.id)).toMatchObject({ disabled: false });
  });

  t('INVÁLIDO: reactivar SIN la marca de liberado no alcanza: la siguiente pasada lo vuelve a deshabilitar (por eso el runbook exige la marca)', async () => {
    const { merchant, b } = await restoredMerchant();
    const pass = reconciler();
    await pass.runOnce();
    await s.client.setEndpointDisabled(merchant, b.id, false);
    expect((await remote(merchant)).get(b.id)?.disabled).toBe(false);
    expect(await pass.runOnce()).toMatchObject({ orphansDisabled: 1 });
    expect((await remote(merchant)).get(b.id)?.disabled).toBe(true);
  });

  t('INVÁLIDO: un huérfano liberado NUNCA se borra, ni siquiera con orphanAction=delete', async () => {
    const { merchant, b } = await restoredMerchant();
    await s.client.call('PATCH', `/api/v1/app/${merchant}/endpoint/${b.id}`, { body: { metadata: { [SVIX_OWNER_KEY]: 'sandbox', [ORPHAN_REVIEW_KEY]: ORPHAN_REVIEW_RELEASED } }, expect: [200] });
    const summary = await reconciler({ orphanAction: 'delete' }).runOnce();
    expect(summary).toMatchObject({ orphansReleased: 1, orphansDeleted: 0 });
    expect((await remote(merchant)).has(b.id)).toBe(true);
  });

  t('INVÁLIDO: la fila aparece (el alta se confirma) entre el ciclo y la acción ⇒ no se deshabilita', async () => {
    const { merchant, b, receiverB } = await restoredMerchant();
    await insertEndpoint(s.h.db.pool, { id: b.id, merchantId: merchant, url: receiverB.url, description: null, enabledEvents: [TYPE], signatureScheme: 'v1' });
    const summary = await reconciler().runOnce();
    expect(summary).toMatchObject({ orphansDisabled: 0, orphansDeleted: 0 });
    expect((await remote(merchant)).get(b.id)?.disabled).toBe(false);
  });

  t('LÍMITE: con orphanAction=delete EXPLÍCITO y dentro del tope sí se borra (el comportamiento anterior, ahora opt-in); con más candidatos que el tope no se borra ninguno y se DESHABILITAN', async () => {
    const small = await restoredMerchant();
    const del = reconciler({ orphanAction: 'delete', maxOrphanDeletesPerPass: 5 });
    expect(await del.runOnce()).toMatchObject({ orphansDeleted: 1, orphansDisabled: 0 });
    expect((await remote(small.merchant)).has(small.b.id)).toBe(false);

    const many = await Promise.all([restoredMerchant(), restoredMerchant(), restoredMerchant()]);
    const capped = reconciler({ orphanAction: 'delete', maxOrphanDeletesPerPass: 2 });
    const summary = await capped.runOnce();
    expect(summary).toMatchObject({ orphansDeleted: 0, orphansWithheld: 3, orphansDisabled: 3 });
    for (const { merchant, b } of many) expect((await remote(merchant)).get(b.id)).toMatchObject({ disabled: true });
    expect(capped.stats).toEqual({ orphanCapTrips: 1, orphansWithheldTotal: 3 });
  });

  t('LÍMITE: un orphanAction desconocido no construye el reconciliador (falla al arrancar, no al actuar)', async () => {
    expect(() => reconciler({ orphanAction: 'purge' as never })).toThrow(/orphanAction/);
  });
});
