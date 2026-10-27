// Pruebas de check-breaking.mjs (node --test). Necesitan oasdiff: OASDIFF=/ruta/a/oasdiff node --test contracts/scripts/check-breaking.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'check-breaking.mjs');
const dirs = [];

const spec = ({ status = 'v1-draft', responseRequired = ['id', 'amount'], extraOptional = false, requestRequired = ['a'] } = {}) => `# API de prueba (${status})
openapi: 3.1.0
info: { title: t, version: 1.0.0 }
paths:
  /x:
    post:
      operationId: x
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: '#/components/schemas/X' } } }
      responses:
        '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/Y' } } } }
components:
  schemas:
    X: { type: object, required: [${requestRequired.join(', ')}], properties: { a: { type: string }, b: { type: string } } }
    Y: { type: object, required: [${responseRequired.join(', ')}], properties: { id: { type: string }, amount: { type: integer }${extraOptional ? ', note: { type: string }' : ''} } }
`;

function run({ base, head, args = [], env = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'check-breaking-'));
  dirs.push(root);
  for (const [folder, files] of [['base', base], ['head', head]]) {
    mkdirSync(join(root, folder), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, folder, name), text);
  }
  // `--dir` relativo al repo no sirve acá: se pasa la carpeta «nueva» como --dir absoluto vía una ruta relativa a la raíz del script
  const result = spawnSync('node', [script, '--base-dir', join(root, 'base'), '--dir', join(root, 'head'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('check-breaking', () => {
  it('un contrato CONGELADO al que se le quita una propiedad requerida de la respuesta FALLA (exit 1) y lo explica', () => {
    const { status, out } = run({ base: { 'a-v1.yaml': spec({ status: 'v1-frozen' }) }, head: { 'a-v1.yaml': spec({ status: 'v1-frozen', responseRequired: ['id'] }) } });
    assert.equal(status, 1);
    assert.match(out, /FALLA\s+a-v1\.yaml \(congelado\)/);
    assert.match(out, /response-property-became-optional/);
  });

  it('un cambio de congelado a borrador en el MISMO cambio no esquiva la regla (manda el encabezado de la base)', () => {
    const { status } = run({ base: { 'a-v1.yaml': spec({ status: 'v1-frozen' }) }, head: { 'a-v1.yaml': spec({ status: 'v1-draft', responseRequired: ['id'] }) } });
    assert.equal(status, 1);
  });

  it('un BORRADOR puede romperse: avisa pero no falla (exit 0); con --strict falla', () => {
    const files = { base: { 'a-v1.yaml': spec() }, head: { 'a-v1.yaml': spec({ responseRequired: ['id'] }) } };
    const lenient = run(files);
    assert.equal(lenient.status, 0);
    assert.match(lenient.out, /AVISO\s+a-v1\.yaml/);
    assert.equal(run({ ...files, args: ['--strict'] }).status, 1);
  });

  it('agregar un campo OPCIONAL a la respuesta de un congelado es compatible (exit 0)', () => {
    const { status, out } = run({ base: { 'a-v1.yaml': spec({ status: 'v1-frozen' }) }, head: { 'a-v1.yaml': spec({ status: 'v1-frozen', extraOptional: true }) } });
    assert.equal(status, 0);
    assert.match(out, /OK\s+a-v1\.yaml \(congelado\)/);
  });

  it('volver REQUERIDO un campo de la petición de un congelado rompe a los clientes: FALLA', () => {
    const { status, out } = run({ base: { 'a-v1.yaml': spec({ status: 'v1-frozen' }) }, head: { 'a-v1.yaml': spec({ status: 'v1-frozen', requestRequired: ['a', 'b'] }) } });
    assert.equal(status, 1);
    assert.match(out, /request-property-became-required/);
  });

  it('sin cambios: exit 0', () => {
    assert.equal(run({ base: { 'a-v1.yaml': spec({ status: 'v1-frozen' }) }, head: { 'a-v1.yaml': spec({ status: 'v1-frozen' }) } }).status, 0);
  });

  it('borrar un contrato congelado FALLA; borrar un borrador solo avisa; uno nuevo es OK', () => {
    assert.equal(run({ base: { 'a-v1.yaml': spec({ status: 'v1-frozen' }) }, head: {} }).status, 1);
    assert.equal(run({ base: { 'a-v1.yaml': spec() }, head: {} }).status, 0);
    const added = run({ base: {}, head: { 'nuevo-v1.yaml': spec() } });
    assert.equal(added.status, 0);
    assert.match(added.out, /NUEVO\s+nuevo-v1\.yaml/);
  });

  it('un cambio en solo UNO de varios contratos congelados se atribuye al correcto', () => {
    const { status, out } = run({
      base: { 'a-v1.yaml': spec({ status: 'v1-frozen' }), 'b-v1.yaml': spec({ status: 'v1-frozen' }) },
      head: { 'a-v1.yaml': spec({ status: 'v1-frozen' }), 'b-v1.yaml': spec({ status: 'v1-frozen', responseRequired: ['id'] }) },
    });
    assert.equal(status, 1);
    assert.match(out, /OK\s+a-v1\.yaml/);
    assert.match(out, /FALLA\s+b-v1\.yaml/);
  });

  it('sin oasdiff instalado sale con 2 y un mensaje claro (nunca un verde falso)', () => {
    const { status, out } = run({ base: { 'a-v1.yaml': spec() }, head: { 'a-v1.yaml': spec() }, env: { OASDIFF: '/no/existe/oasdiff' } });
    assert.equal(status, 2);
    assert.match(out, /No se encontró oasdiff/);
  });

  it('un contrato que NO se puede cargar (referencia rota) sale con 2, aunque sea un borrador: nunca un verde falso', () => {
    const broken = spec().replace("$ref: '#/components/schemas/X'", "$ref: 'no-existe.yaml#/components/schemas/X'");
    const { status, out } = run({ base: { 'a-v1.yaml': broken }, head: { 'a-v1.yaml': broken } });
    assert.equal(status, 2);
    assert.match(out, /ERROR\s+a-v1\.yaml/);
  });

  it('una referencia de git inexistente sale con 2', () => {
    const result = spawnSync('node', [script, '--base', 'no-existe-esta-rama'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
  });
});
