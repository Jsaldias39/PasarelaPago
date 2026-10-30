import { randomBytes } from 'node:crypto';
import { createIsolatedDatabase, type IsolatedDatabase } from '@pay/testing';
import type { SvixClient } from '../../src/engine/svix/svix-client';
import { SvixReconciler, type SvixReconcilerOptions } from '../../src/engine/svix/svix-reconciler';
import { insertEndpoint } from '../../src/endpoints/endpoint.repository';
import { newMerchantId, SQL_FILES } from '../harness';
import { assertSvixReady, newSvixClient, svixToken } from './svix-env';

/**
 * REVISION-DINERO F2 y F5 (reloj): el reconciliador contra un svix-server REAL (1.104.0) y Postgres real.
 * Cada prueba usa su propia base (la «base» del servicio) y su propio comercio; la organización de Svix es propia de la corrida (svixToken).
 * Los endpoints se crean directamente con el cliente de Svix, como los dejaría un alta cuya transacción se revirtió (sin fila local).
 */
const TYPE = 'payment_intent.succeeded';
const URL = 'https://receptor.comercio.example/hook';
const SECRET = 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oDC2FVsBQIhrs=';
const OWNER_KEY = 'pay_owner';
const t = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);

const newEndpointId = () => `we_${randomBytes(10).toString('hex')}`;

describe('SvixReconciler: espacio de nombres, tope de borrados y reloj contra Svix REAL', () => {
  let client: SvixClient;
  let db: IsolatedDatabase;

  beforeAll(async () => {
    client = newSvixClient(svixToken());
    await assertSvixReady(client);
    await client.ensureEventType(TYPE, 'Evento público de pruebas');
  });
  beforeEach(async () => {
    db = await createIsolatedDatabase(SQL_FILES);
  });
  afterEach(async () => db.drop());

  /** Estrictos: sin gracia ni margen, para que la edad no sea la variable de la prueba. */
  const reconciler = (options: Partial<SvixReconcilerOptions> = {}) => new SvixReconciler(db.pool, client, { orphanGraceMs: 0, clockMarginMs: 0, concurrency: 2, ...options });

  /** Un endpoint de Svix en la aplicación del comercio. `owner` undefined ⇒ sin marca (anterior a la marca o de un Svix compartido). */
  async function svixEndpoint(merchantId: string, owner?: string): Promise<string> {
    const uid = newEndpointId();
    await client.ensureApp(merchantId, merchantId);
    await client.createEndpoint(merchantId, { uid, url: URL, eventTypes: [TYPE], secret: SECRET, ...(owner ? { metadata: { [OWNER_KEY]: owner } } : {}) });
    return uid;
  }
  /** Un endpoint CON fila local y con contraparte en Svix: el comercio «existe» para el reconciliador. */
  async function legitimate(merchantId: string): Promise<string> {
    const id = await svixEndpoint(merchantId, 'sandbox');
    await insertEndpoint(db.pool, { id, merchantId, url: URL, description: null, enabledEvents: [TYPE], signatureScheme: 'v1' });
    return id;
  }
  const uids = async (merchantId: string) => ((await client.listEndpoints(merchantId)) ?? []).map((e) => e.uid).sort();

  describe('F2 · espacio de nombres del propietario', () => {
    t('CORRECTO: un huérfano PROPIO (marca de este entorno, sin fila) se borra pasada la gracia; con la gracia vigente no se toca', async () => {
      const merchant = newMerchantId();
      const kept = await legitimate(merchant);
      const orphan = await svixEndpoint(merchant, 'sandbox');

      const patient = reconciler({ orphanGraceMs: 3_600_000 });
      expect((await patient.runOnce()).orphansDeleted).toBe(0);
      expect(await uids(merchant)).toEqual([kept, orphan].sort());

      const summary = await reconciler().runOnce();
      expect(summary.orphansDeleted).toBe(1);
      expect(await uids(merchant)).toEqual([kept]);
    });

    t('INVÁLIDO: un endpoint de OTRO entorno y uno SIN marca (anterior a la marca) NO se borran nunca, ni con gracia 0', async () => {
      const merchant = newMerchantId();
      const kept = await legitimate(merchant);
      const otherEnvironment = await svixEndpoint(merchant, 'live-produccion');
      const unlabeled = await svixEndpoint(merchant);
      const own = await svixEndpoint(merchant, 'sandbox');

      const summary = await reconciler().runOnce();
      expect(summary).toMatchObject({ orphansDeleted: 1, notOwnedUnknown: 2 });
      // solo el propio se fue; el de otro entorno y el anterior a la marca siguen, y se puede repetir las veces que sea
      expect(await uids(merchant)).toEqual([kept, otherEnvironment, unlabeled].sort());
      expect(own).toMatch(/^we_/);
      await reconciler().runOnce();
      expect(await uids(merchant)).toEqual([kept, otherEnvironment, unlabeled].sort());
    });

    t('INVÁLIDO: el espacio de nombres es el de CADA reconciliador: el de «live-produccion» borra los suyos y deja los de «sandbox»', async () => {
      const merchant = newMerchantId();
      const kept = await legitimate(merchant);
      const sandboxOrphan = await svixEndpoint(merchant, 'sandbox');
      const liveOrphan = await svixEndpoint(merchant, 'live-produccion');

      expect((await reconciler({ namespace: 'live-produccion' }).runOnce()).orphansDeleted).toBe(1);
      expect(await uids(merchant)).toEqual([kept, sandboxOrphan].sort());
      expect(liveOrphan).toMatch(/^we_/);
    });

    t('LÍMITE: un espacio de nombres mal formado no construye el reconciliador (falla al arrancar, no al borrar)', async () => {
      expect(() => reconciler({ namespace: 'Mal Formado' })).toThrow(/espacio de nombres/);
      expect(() => reconciler({ namespace: '' })).toThrow(/espacio de nombres/);
    });
  });

  describe('F2 · tope de borrados por pasada', () => {
    t('LÍMITE: con exactamente el tope de huérfanos propios, se borran todos', async () => {
      const merchant = newMerchantId();
      const kept = await legitimate(merchant);
      for (let i = 0; i < 3; i += 1) await svixEndpoint(merchant, 'sandbox');
      const summary = await reconciler({ maxOrphanDeletesPerPass: 3 }).runOnce();
      expect(summary).toMatchObject({ orphansDeleted: 3, orphansWithheld: 0 });
      expect(await uids(merchant)).toEqual([kept]);
    });

    t('INVÁLIDO: más huérfanos propios que el tope (sumando comercios) ⇒ NINGUNO se borra, se avisa y se cuenta', async () => {
      const a = newMerchantId();
      const b = newMerchantId();
      const keptA = await legitimate(a);
      const keptB = await legitimate(b);
      const orphans = [await svixEndpoint(a, 'sandbox'), await svixEndpoint(a, 'sandbox'), await svixEndpoint(b, 'sandbox')];

      const guarded = reconciler({ maxOrphanDeletesPerPass: 2 });
      const summary = await guarded.runOnce();
      expect(summary).toMatchObject({ orphansDeleted: 0, orphansWithheld: 3 });
      expect(guarded.stats).toEqual({ orphanCapTrips: 1, orphansWithheldTotal: 3 });
      expect(await uids(a)).toEqual([keptA, orphans[0], orphans[1]].sort());
      expect(await uids(b)).toEqual([keptB, orphans[2]].sort());

      // la siguiente pasada vuelve a avisar (el estado no se «gasta») y el contador acumula
      await guarded.runOnce();
      expect(guarded.stats).toEqual({ orphanCapTrips: 2, orphansWithheldTotal: 6 });
      // con el tope en 0 el borrado queda desactivado aunque haya un solo candidato
      const off = reconciler({ maxOrphanDeletesPerPass: 0 });
      expect((await off.runOnce()).orphansDeleted).toBe(0);
      expect(await uids(a)).toHaveLength(3);
    });

    t('INVÁLIDO: base RESTAURADA a un punto anterior (conoce 1 de 9 endpoints del comercio) con el tope por defecto ⇒ no se borra ninguno', async () => {
      const merchant = newMerchantId();
      const known = await legitimate(merchant); // lo único que sabe la base restaurada
      const created = [];
      for (let i = 0; i < 8; i += 1) created.push(await svixEndpoint(merchant, 'sandbox')); // creados después del punto de restauración
      const summary = await new SvixReconciler(db.pool, client, { orphanGraceMs: 0, clockMarginMs: 0, concurrency: 2 }).runOnce(); // tope por defecto
      expect(summary.orphansDeleted).toBe(0);
      expect(summary.orphansWithheld).toBe(8);
      expect(await uids(merchant)).toEqual([known, ...created].sort());
    });

    t('INVÁLIDO: base VACÍA (restaurada de cero) con muchos endpoints en Svix ⇒ no se borra ninguno', async () => {
      const merchant = newMerchantId();
      for (let i = 0; i < 8; i += 1) await svixEndpoint(merchant, 'sandbox');
      const summary = await reconciler({ maxOrphanDeletesPerPass: 100 }).runOnce(); // aun con un tope generoso
      expect(summary).toMatchObject({ merchants: 0, endpoints: 0, orphansDeleted: 0 });
      expect(await uids(merchant)).toHaveLength(8);
    });

    t('LÍMITE: un tope inválido no construye el reconciliador', async () => {
      expect(() => reconciler({ maxOrphanDeletesPerPass: -1 })).toThrow(/maxOrphanDeletesPerPass/);
      expect(() => reconciler({ maxOrphanDeletesPerPass: 1.5 })).toThrow(/maxOrphanDeletesPerPass/);
    });
  });

  describe('F5 · la gracia compara dos relojes y lleva un margen explícito', () => {
    const GRACE = 10 * 60_000;
    const MARGIN = 60_000;

    t('LÍMITE: con el reloj de Svix atrasado menos que el margen, el huérfano todavía no se borra; pasado grace + margen, sí', async () => {
      const merchant = newMerchantId();
      const kept = await legitimate(merchant);
      const orphan = await svixEndpoint(merchant, 'sandbox');
      const created = Date.now();

      // edad aparente = grace + 30 s: ya supera la gracia pero NO la gracia + margen ⇒ intacto
      const early = reconciler({ orphanGraceMs: GRACE, clockMarginMs: MARGIN, now: () => new Date(created + GRACE + 30_000) });
      expect((await early.runOnce()).orphansDeleted).toBe(0);
      expect(await uids(merchant)).toEqual([kept, orphan].sort());

      // edad aparente = grace + margen + 10 s ⇒ se borra
      const late = reconciler({ orphanGraceMs: GRACE, clockMarginMs: MARGIN, now: () => new Date(Date.now() + GRACE + MARGIN + 10_000) });
      expect((await late.runOnce()).orphansDeleted).toBe(1);
      expect(await uids(merchant)).toEqual([kept]);
    });
  });
});
