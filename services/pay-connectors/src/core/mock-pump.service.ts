import { Inject, Injectable } from '@nestjs/common';
import type { ConnectorRegistry } from '../domain/registry';
import { MockConnector } from '../connectors/mock/mock.connector';
import type { SimulatedBank } from '../connectors/mock/simulated-bank';
import { CallbacksService } from './callbacks.service';
import { CLOCK, REGISTRY, type Clock } from './tokens';

export const SIMULATED_BANK = Symbol('SIMULATED_BANK');

/**
 * [DOBLE] Hace de «banco» en sandbox: toma los callbacks que el simulador programó, los FIRMA y los entrega al servicio de
 * callbacks, que los verifica igual que a los de un proveedor real. Sin esto el simulador cobraría pero nadie se enteraría.
 * En `live` no existe: el módulo no lo crea.
 */
@Injectable()
export class MockPumpService {
  constructor(
    @Inject(SIMULATED_BANK) private readonly bank: SimulatedBank,
    @Inject(REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly callbacks: CallbacksService,
  ) {}

  /** Entrega todo lo vencido. Devuelve cuántos callbacks entregó y qué respondió el servicio. */
  async tick(): Promise<Array<{ eventId: string; result: string }>> {
    const connector = this.registry.get('mock');
    if (!(connector instanceof MockConnector)) return [];
    const now = this.clock.now();
    const delivered: Array<{ eventId: string; result: string }> = [];
    for (const callback of this.bank.dueCallbacks(now)) {
      const signed = await connector.signCallback(callback, now);
      const outcome = await this.callbacks.receive({ connectorId: 'mock', headers: signed.headers, rawBody: signed.rawBody, sourceIp: '127.0.0.1' });
      delivered.push({ eventId: callback.eventId, result: outcome.result });
    }
    return delivered;
  }
}
