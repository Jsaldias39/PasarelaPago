import { readFileSync } from 'node:fs';
import { loadLedgerConfig } from '../src/ledger/ledger.config';
import { repoPath } from './helpers/app';

/**
 * El `.env.example` es lo que alguien copia para arrancar el ledger: tiene que ser CONSISTENTE con lo que el arnés e2e (`e2e/lib/services.ts`) le pasa y
 * con la configuración real. Se prueba contra el arnés leyéndolo como texto (es de otro carril; no se importa ni se toca).
 */
const parse = (text: string, includeCommented = false) =>
  Object.fromEntries(
    text
      .split('\n')
      .map((l) => (includeCommented ? l.replace(/^#\s*(?=[A-Z][A-Z0-9_]*=)/, '') : l))
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
const example = readFileSync(repoPath('services/pay-ledger/.env.example'), 'utf8');

/** Las variables que el arnés le pasa a un servicio: las comunes (`common()`) y las de su `case`. */
function harnessKeys(service: string): string[] {
  const source = readFileSync(repoPath('e2e/lib/services.ts'), 'utf8');
  const keysOf = (block: string) => [...block.matchAll(/\b([A-Z][A-Z0-9_]{2,}):/g)].map((m) => m[1]);
  const common = source.slice(source.indexOf('function common('), source.indexOf('export function envFor('));
  const start = source.indexOf(`case '${service}':`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {4}case '/);
  return [...new Set([...keysOf(common), ...keysOf(rest.slice(0, next === -1 ? undefined : next))])];
}

describe('.env.example de pay-ledger', () => {
  it('declara PAY_MODE activo (es obligatorio, sin valor por defecto) y alcanza para que la configuración cargue', () => {
    const active = parse(example);
    expect(active.PAY_MODE).toBe('sandbox');
    expect(loadLedgerConfig(active)).toMatchObject({ payMode: 'sandbox', tb: { address: '127.0.0.1:54300' } });
  });

  it('documenta TODAS las variables que el arnés e2e le pasa al ledger (activas o comentadas)', () => {
    const documented = parse(example, true);
    const keys = harnessKeys('pay-ledger');
    expect(keys).toEqual(expect.arrayContaining(['PORT', 'DB_HOST', 'NATS_URL', 'PAY_MODE', 'TB_ADDRESS', 'TB_CLUSTER_ID', 'LEDGER_ID_NAMESPACE']));
    expect(keys.filter((k) => !(k in documented))).toEqual([]);
  });

  it('el puerto y el TigerBeetle del ejemplo son los del plan: 3105 y el de desarrollo (54300)', () => {
    const active = parse(example);
    expect(active.PORT).toBe('3105');
    expect(active.TB_ADDRESS).toBe('127.0.0.1:54300');
    expect(readFileSync(repoPath('platform/scripts/tigerbeetle-dev.sh'), 'utf8')).toContain('54300');
  });

  it('el ledger arranca en el arnés sin ningún paso manual: no necesita nada más que lo que el arnés le pasa (TigerBeetle propio incluido)', () => {
    const passed = Object.fromEntries(harnessKeys('pay-ledger').map((k) => [k, k === 'PAY_MODE' ? 'sandbox' : k === 'TB_ADDRESS' ? '127.0.0.1:1' : k === 'TB_CLUSTER_ID' ? '0' : k === 'LEDGER_ID_NAMESPACE' ? 'e2eabc' : 'x']));
    expect(() => loadLedgerConfig(passed)).not.toThrow();
  });
});
