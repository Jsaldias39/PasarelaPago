import type { Resolver } from '../../src/ssrf/target-guard';

/** [DOBLE] de DNS: una tabla nombre → direcciones que la prueba puede cambiar entre el alta y la entrega (rebinding). */
export class FakeResolver implements Resolver {
  readonly calls: string[] = [];
  constructor(public table: Record<string, readonly string[] | Error>) {}

  async resolve(hostname: string): Promise<readonly string[]> {
    this.calls.push(hostname);
    const entry = this.table[hostname];
    if (entry === undefined) throw new Error('ENOTFOUND');
    if (entry instanceof Error) throw entry;
    return entry;
  }
}
