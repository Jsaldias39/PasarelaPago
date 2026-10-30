import { SERVICES } from '../lib/services.ts';
import { startStack, stopStack } from '../stack.ts';

/**
 * `PAY_MODE` explícito en los 11 (D-26): sin valor por defecto y sin tolerancia a variantes. Un servicio con el modo ausente, vacío o mal
 * escrito no debe quedar sano (si lo hiciera, estaría eligiendo un modo por su cuenta).
 */
const BAD: readonly [string, string | null][] = [['ausente', null], ['vacío', ''], ['con otro valor («prod»)', 'prod'], ['con otra capitalización («LIVE»)', 'LIVE']];

describe('PAY_MODE obligatorio y estricto en los 11 servicios', () => {
  it.each(BAD)('PAY_MODE %s ⇒ ningún servicio queda sano', async (_name, value) => {
    const envOverrides = Object.fromEntries(SERVICES.map((n) => [n, { PAY_MODE: value }]));
    const stack = await startStack({ envOverrides, readyTimeoutMs: 20_000 });
    let healthy: string[] = [];
    try {
      healthy = SERVICES.filter((n) => stack.services[n].healthy);
    } finally {
      expect((await stopStack(stack)).leftoverPids).toEqual([]);
    }
    expect(healthy).toEqual([]);
  });
});
