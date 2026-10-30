import { insertEndpoint } from '../../src/endpoints/endpoint.repository';
import { SvixReconciler } from '../../src/engine/svix/svix-reconciler';
import type { SvixClient } from '../../src/engine/svix/svix-client';
import { newMerchantId } from '../harness';
import { startSvixHarness, type SvixHarness } from './svix-harness';

/**
 * Propuesta mut23 para la mutación F-B1.c («no se relee la base antes de actuar»), que sobrevivía: el caso existente «la fila aparece entre el ciclo y la
 * acción» inserta la fila ANTES de `runOnce()`, así que la consulta del ciclo ya la ve y el endpoint nunca llega a ser candidato; la relectura de
 * `handleOrphans` no se ejercita.
 * Aquí la fila se confirma DESPUÉS de que el ciclo reunió al candidato (justo cuando `listEndpoints` devuelve) y ANTES de la acción: es la carrera real
 * entre un alta que se confirma y la pasada. Sin la relectura el reconciliador deshabilitaría (o, en `delete`, BORRARÍA) un endpoint legítimo.
 */
const t = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);

describe('F-B1 · la fila confirmada entre la reunión de candidatos y la acción NO se toca (relectura de la base)', () => {
  let s: SvixHarness;
  beforeAll(async () => {
    s = await startSvixHarness();
  });
  afterAll(async () => s.stop());
  beforeEach(async () => {
    await s.h.db.pool.query('DELETE FROM webhook_endpoints');
  });

  /** Un cliente que, al terminar de listar los endpoints remotos del comercio, confirma la fila local de `late` (el alta que se confirma tarde). */
  const lateRowClient = (merchant: string, late: { id: string; url: string }): SvixClient =>
    new Proxy(s.client, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === 'listEndpoints') {
          return async (merchantId: string) => {
            const remote = await target.listEndpoints(merchantId);
            if (merchantId === merchant) {
              await insertEndpoint(s.h.db.pool, { id: late.id, merchantId: merchant, url: late.url, description: null, enabledEvents: ['payment_intent.succeeded'], signatureScheme: 'v1' });
            }
            return remote;
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as SvixClient;

  async function twoEndpoints() {
    const merchant = newMerchantId();
    const a = await s.createEndpoint(merchant, await s.receiver());
    const receiverB = await s.receiver();
    const b = await s.createEndpoint(merchant, receiverB);
    await s.h.db.pool.query('DELETE FROM webhook_endpoints WHERE id = $1', [b.id]); // B: en Svix, sin fila local al empezar el ciclo
    return { merchant, a, b, urlB: receiverB.url };
  }

  for (const orphanAction of ['disable', 'delete'] as const) {
    t(`INVÁLIDO (${orphanAction}): la fila se confirma tras reunir al candidato ⇒ ni se deshabilita ni se borra, y el resumen no lo cuenta`, async () => {
      const { merchant, b, urlB } = await twoEndpoints();
      const reconciler = new SvixReconciler(s.h.db.pool, lateRowClient(merchant, { id: b.id, url: urlB }), { orphanGraceMs: 0, clockMarginMs: 0, concurrency: 1, orphanAction });
      const summary = await reconciler.runOnce();

      expect(summary).toMatchObject({ orphansDisabled: 0, orphansDeleted: 0, orphansHeldDisabled: 0, errors: 0 });
      const remote = new Map(((await s.client.listEndpoints(merchant)) ?? []).map((e) => [e.uid as string, e]));
      expect(remote.get(b.id)).toMatchObject({ disabled: false }); // sigue vivo y habilitado
      expect((await s.h.db.pool.query('SELECT 1 FROM webhook_endpoints WHERE id = $1', [b.id])).rowCount).toBe(1);
    });
  }
});
