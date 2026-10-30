// Valida los contratos (P1.H1.M7): OpenAPI con Redocly y AsyncAPI con el parser oficial.
// Uso: yarn contracts:lint [archivo ...]   (sin argumentos valida todo contracts/openapi y contracts/asyncapi)
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from '@asyncapi/parser';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const list = (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((f) => f.endsWith('.yaml')).map((f) => join(dir, f)) : []);
// common.yaml es una biblioteca de componentes: se valida a través de quienes la referencian.
const all = [...list('contracts/openapi').filter((f) => !f.endsWith('common.yaml')), ...list('contracts/asyncapi')];
const files = args.length > 0 ? args : all;

let failures = 0;
for (const file of files) {
  const isAsync = file.includes('/asyncapi/');
  if (!isAsync) {
    const run = spawnSync('node', [join(root, 'node_modules/@redocly/cli/bin/cli.js'), 'lint', '--config', join(root, 'redocly.yaml'), file], { cwd: root, encoding: 'utf8' });
    const tail = (run.stdout + run.stderr).trim().split('\n').slice(-3).join(' | ');
    if (run.status === 0) console.log(`OK    ${file}`);
    else {
      failures += 1;
      console.log(`FALLA ${file}\n${run.stdout}${run.stderr}`);
    }
    void tail;
  } else {
    const parser = new Parser();
    const { document, diagnostics } = await parser.parse(readFileSync(resolve(root, file), 'utf8'), { source: resolve(root, file) });
    const errors = diagnostics.filter((d) => d.severity === 0);
    if (document && errors.length === 0) console.log(`OK    ${file}`);
    else {
      failures += 1;
      console.log(`FALLA ${file}`);
      for (const d of errors) console.log(`  ${d.code}: ${d.message} (${d.path.join('/')})`);
    }
  }
}
console.log(failures === 0 ? `\n${files.length} contrato(s) válido(s)` : `\n${failures} contrato(s) con errores`);
process.exit(failures === 0 ? 0 : 1);
