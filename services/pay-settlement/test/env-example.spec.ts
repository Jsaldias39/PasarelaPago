import { readFileSync } from 'node:fs';
import { loadSettlementConfig } from '../src/settlement/settlement.config';
import { repoPath } from './helpers/app';

/**
 * El `.env.example` es lo que alguien copia para arrancar pay-settlement: tiene que ser CONSISTENTE con lo que el arnés e2e (`e2e/lib/services.ts`) le pasa,
 * con la configuración real y con los puertos de los servicios a los que apunta (se leen los `.env.example` vecinos como datos; no se modifican).
 */
const parse = (text: string, includeCommented = false) =>
  Object.fromEntries(
    text
      .split('\n')
      .map((l) => (includeCommented ? l.replace(/^#\s*(?=[A-Z][A-Z0-9_]*=)/, '') : l))
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
const envOf = (service: string) => readFileSync(repoPath(`services/${service}/.env.example`), 'utf8');
const example = envOf('pay-settlement');

function harnessKeys(service: string): string[] {
  const source = readFileSync(repoPath('e2e/lib/services.ts'), 'utf8');
  const keysOf = (block: string) => [...block.matchAll(/\b([A-Z][A-Z0-9_]{2,}):/g)].map((m) => m[1]);
  const common = source.slice(source.indexOf('function common('), source.indexOf('export function envFor('));
  const start = source.indexOf(`case '${service}':`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {4}case '/);
  return [...new Set([...keysOf(common), ...keysOf(rest.slice(0, next === -1 ? undefined : next))])];
}

describe('.env.example de pay-settlement', () => {
  it('declara PAY_MODE activo (obligatorio, sin valor por defecto) y, con la clave de operador, la configuración carga', () => {
    const active = parse(example);
    expect(active.PAY_MODE).toBe('sandbox');
    const config = loadSettlementConfig({ ...active, OPERATOR_TOKEN_PUBLIC_KEY: 'k', OPERATOR_TOKEN_ISSUER: 'i' });
    expect(config).toMatchObject({ payMode: 'sandbox', mode: 'bank', transferConnector: 'mock' });
  });

  it('documenta TODAS las variables que el arnés e2e le pasa a pay-settlement (activas o comentadas)', () => {
    const documented = parse(example, true);
    const keys = harnessKeys('pay-settlement');
    expect(keys).toEqual(expect.arrayContaining(['PAY_MODE', 'LEDGER_URL', 'CONNECTORS_URL', 'OPERATOR_TOKEN_PUBLIC_KEY', 'OPERATOR_TOKEN_ISSUER', 'OPERATOR_TOKEN_AUDIENCE', 'SETTLEMENT_MODE', 'SETTLEMENT_TRANSFER_CONNECTOR']));
    expect(keys.filter((k) => !(k in documented))).toEqual([]);
  });

  it('las URLs entre servicios apuntan al puerto que esos servicios declaran en SU .env.example (LEDGER_URL → pay-ledger, CONNECTORS_URL → pay-connectors)', () => {
    const active = parse(example);
    const portOf = (service: string) => parse(envOf(service)).PORT;
    expect(active.LEDGER_URL).toBe(`http://127.0.0.1:${portOf('pay-ledger')}`);
    expect(active.CONNECTORS_URL).toBe(`http://127.0.0.1:${portOf('pay-connectors')}`);
    expect(active.PORT).toBe('3106');
  });

  it('la audiencia del ejemplo es la que el arnés usa para firmar la credencial de operador', () => {
    expect(parse(example).OPERATOR_TOKEN_AUDIENCE).toBe('pay-settlement');
    expect(readFileSync(repoPath('e2e/lib/services.ts'), 'utf8')).toContain("OPERATOR_TOKEN_AUDIENCE: 'pay-settlement'");
  });
});
