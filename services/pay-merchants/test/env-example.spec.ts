import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { loadSettings as LOADER } from '../src/settings';

/** Variables activas (no comentadas) de un `.env.example`. */
export function parseEnvExample(file: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

const SERVICES = join(process.cwd(), '..');
const own = parseEnvExample(join(process.cwd(), '.env.example'));

describe('.env.example de pay-merchants (consistencia con el arnés y con los demás servicios)', () => {
  it('es una configuración que ARRANCA: la plantilla y los parámetros propios la aceptan tal cual', () => {
    expect(() => loadConfig(own)).not.toThrow();
    expect(() => LOADER(own)).not.toThrow();
    expect(own.PAY_MODE).toBe('sandbox'); // el ejemplo de desarrollo declara su modo, nunca live
  });

  it('el PORT es el del plan y no se repite en ningún otro servicio', () => {
    expect(Number(own.PORT)).toBe(3107);
    const ports = ['pay-edge', 'pay-payments', 'pay-connectors', 'pay-qr', 'pay-ledger', 'pay-settlement', 'pay-merchants', 'pay-risk', 'pay-schedules', 'pay-webhooks', 'pay-vault'].map((s) => parseEnvExample(join(SERVICES, s, '.env.example')).PORT);
    expect(new Set(ports).size).toBe(ports.length); // ningún puerto repetido entre los 11 servicios
  });
});
