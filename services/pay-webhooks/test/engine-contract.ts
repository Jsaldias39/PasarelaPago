import { randomBytes } from 'node:crypto';
import type { Queryable } from '@pay/outbox';
import type { DeliveryEngine } from '../src/engine/delivery-engine';
import { insertEndpoint } from '../src/endpoints/endpoint.repository';
import type { EndpointRecord, SignatureScheme } from '../src/endpoints/endpoint.types';

export interface EngineFixture {
  readonly engine: DeliveryEngine;
  readonly db: Queryable;
}

/**
 * Contrato que TODO `DeliveryEngine` debe cumplir. Lo corren `InProcessEngine` ([DOBLE de Svix], engine-contract.spec.ts) y `SvixEngine`
 * contra un svix-server REAL (svix/svix-engine-contract.spec.ts): la misma suite, sin excepciones.
 */
export function describeEngineContract(name: string, setup: () => Promise<EngineFixture & { dispose(): Promise<void> }>): void {
  describe(`contrato DeliveryEngine — ${name}`, () => {
    let fixture: EngineFixture & { dispose(): Promise<void> };
    beforeAll(async () => {
      fixture = await setup();
    });
    afterAll(async () => fixture.dispose());

    const newEndpoint = async (scheme: SignatureScheme = 'v1', events: string[] = ['payment_intent.succeeded']): Promise<EndpointRecord> =>
      insertEndpoint(fixture.db, { id: `we_${randomBytes(10).toString('hex')}`, merchantId: `mc_${randomBytes(6).toString('hex')}`, url: 'https://hooks.comercio.example/pay', description: null, enabledEvents: events, signatureScheme: scheme });

    it('provisionEndpoint v1 devuelve un whsec_ y v1a una whpk_', async () => {
      expect((await fixture.engine.provisionEndpoint(fixture.db, await newEndpoint('v1'))).secret).toMatch(/^whsec_/);
      expect((await fixture.engine.provisionEndpoint(fixture.db, await newEndpoint('v1a'))).secret).toMatch(/^whpk_/);
    });

    it('rotateEndpointSecret devuelve un secreto distinto del anterior', async () => {
      const endpoint = await newEndpoint();
      const first = await fixture.engine.provisionEndpoint(fixture.db, endpoint);
      const second = await fixture.engine.rotateEndpointSecret(fixture.db, endpoint);
      expect(second.secret).toMatch(/^whsec_/);
      expect(second.secret).not.toBe(first.secret);
    });

    it('publish: repetir el mismo eventId no crea otra entrega; un evento sin suscriptores crea 0', async () => {
      const endpoint = await newEndpoint('v1', ['payment_intent.succeeded']);
      await fixture.engine.provisionEndpoint(fixture.db, endpoint);
      const message = { merchantId: endpoint.merchantId, eventId: `00000000-0000-4000-8000-${randomBytes(6).toString('hex')}`, eventType: 'payment_intent.succeeded', payload: '{"a":1}' };
      expect(await fixture.engine.publish(fixture.db, message)).toBe(1);
      expect(await fixture.engine.publish(fixture.db, message)).toBe(0);
      expect(await fixture.engine.publish(fixture.db, { ...message, eventId: `00000000-0000-4000-8000-${randomBytes(6).toString('hex')}`, eventType: 'payout.paid' })).toBe(0);
    });

    it('publish no entrega a un comercio ajeno', async () => {
      const endpoint = await newEndpoint();
      await fixture.engine.provisionEndpoint(fixture.db, endpoint);
      const other = { merchantId: 'mc_otrocomercio1', eventId: `00000000-0000-4000-8000-${randomBytes(6).toString('hex')}`, eventType: 'payment_intent.succeeded', payload: '{}' };
      expect(await fixture.engine.publish(fixture.db, other)).toBe(0);
    });
  });
}
