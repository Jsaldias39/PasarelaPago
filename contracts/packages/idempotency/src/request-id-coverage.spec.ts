import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * S-03: TODOS los servicios (y la plantilla de servicio nueva) generan el id de correlación con `resolveRequestId` de `@pay/idempotency`. Esta prueba impide que un
 * servicio nuevo, o una edición, vuelva a copiar la regex `^[A-Za-z0-9._-]{8,64}$` sin el filtro de PAN: ése fue el hallazgo.
 */
const ROOT = join(__dirname, '../../../..');
const modules = [
  join(ROOT, 'platform/templates/service/src/app.module.ts'),
  ...readdirSync(join(ROOT, 'services'))
    .map((dir) => join(ROOT, 'services', dir, 'src/app.module.ts'))
    .filter((file) => existsSync(file)),
];

describe('genReqId de todos los servicios usa resolveRequestId (filtro de PAN compartido)', () => {
  it('hay al menos los 12 servicios y la plantilla', () => {
    expect(modules.length).toBeGreaterThanOrEqual(13);
  });

  it.each(modules.map((file) => [file.replace(`${ROOT}/`, ''), file]))('%s', (_name, file) => {
    const source = readFileSync(file!, 'utf8');
    expect(source).toMatch(/genReqId:/);
    expect(source).toContain('resolveRequestId(req.headers[\'x-request-id\'])');
    expect(source).toMatch(/from '@pay\/idempotency'/);
    expect(source).not.toContain('{8,64}');
  });
});
