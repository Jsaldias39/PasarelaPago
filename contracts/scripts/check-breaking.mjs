// Detecta cambios que ROMPEN los contratos OpenAPI (P1.H1.M7), con oasdiff.
// Uso: node contracts/scripts/check-breaking.mjs [--base <ref-de-git>] [--base-dir <carpeta>] [--dir contracts/openapi] [--strict]
//   --base      rama o commit contra el que se compara (por defecto origin/dev; se extrae con `git archive`).
//   --base-dir  carpeta con los contratos «de antes» (para pruebas; reemplaza a --base).
//   --strict    los borradores también fallan (por defecto solo avisan).
// Requisito: el binario `oasdiff` en el PATH o en la variable OASDIFF (go install github.com/oasdiff/oasdiff@latest).
// Código de salida: 0 sin rupturas en contratos congelados · 1 ruptura en un contrato congelado · 2 falta la herramienta o la base.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
};
const strict = argv.includes('--strict');
const dir = option('--dir', 'contracts/openapi');
const oasdiff = process.env.OASDIFF ?? 'oasdiff';

const probe = spawnSync(oasdiff, ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error(`No se encontró oasdiff (${oasdiff}). Instalalo con: go install github.com/oasdiff/oasdiff@latest`);
  process.exit(2);
}

const cleanup = [];
let baseDir = option('--base-dir');
if (baseDir === undefined) {
  const ref = option('--base', 'origin/dev');
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    console.error(`La referencia ${ref} no existe (¿falta un git fetch? el CI necesita fetch-depth: 0).`);
    process.exit(2);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'contracts-base-'));
  cleanup.push(tmp);
  try {
    // Los contratos referencian ../schemas (JSON Schema): hay que traer también esa carpeta de la base.
    const sibling = join(dirname(dir), 'schemas');
    const archive = execFileSync('git', ['archive', ref, dir, sibling], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    execFileSync('tar', ['-x', '-C', tmp], { input: archive });
  } catch {
    // La referencia existe pero todavía no tiene contratos (primer cambio que los introduce): no hay nada contra qué comparar.
    console.log(`La referencia ${ref} no tiene ${dir}: no hay base contra la cual comparar (todo es nuevo).`);
    for (const dirToClean of cleanup.concat(tmp)) rmSync(dirToClean, { recursive: true, force: true });
    process.exit(0);
  }
  baseDir = join(tmp, dir);
}
const headDir = resolve(root, dir);

// Un contrato está congelado si SU VERSIÓN BASE lo declara (`v1-frozen` en el encabezado): no se puede esquivar la
// regla cambiando el encabezado en el mismo cambio.
const isFrozen = (file) => existsSync(file) && readFileSync(file, 'utf8').split('\n').slice(0, 15).some((line) => /v1-frozen/.test(line));
const specs = (folder) => (existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith('.yaml') && f !== 'common.yaml') : []);

let failures = 0;
let warnings = 0;
let toolErrors = 0;
for (const name of new Set([...specs(baseDir), ...specs(headDir)])) {
  const base = join(baseDir, name);
  const head = join(headDir, name);
  const frozen = isFrozen(base);
  if (!existsSync(base)) {
    console.log(`NUEVO  ${name}`);
    continue;
  }
  if (!existsSync(head)) {
    if (frozen || strict) {
      failures += 1;
      console.log(`FALLA  ${name}: se borró un contrato ${frozen ? 'congelado' : 'existente'}`);
    } else {
      warnings += 1;
      console.log(`AVISO  ${name}: se borró un borrador`);
    }
    continue;
  }
  const run = spawnSync(oasdiff, ['breaking', base, head, '--fail-on', 'ERR'], { encoding: 'utf8', cwd: root });
  const output = `${run.stdout}${run.stderr}`.trim();
  // «Error: failed to load…» no es una ruptura: es que no se pudo comparar. Nunca se trata como verde.
  if (run.status !== 0 && /^Error:/m.test(output) && !/changes:/.test(output)) {
    toolErrors += 1;
    console.log(`ERROR  ${name}: no se pudo comparar\n${output.replace(/^/gm, '       ')}`);
  } else if (run.status === 0) {
    console.log(`OK     ${name}${frozen ? ' (congelado)' : ''}`);
  } else if (frozen || strict) {
    failures += 1;
    console.log(`FALLA  ${name}${frozen ? ' (congelado)' : ''}\n${output.replace(/^/gm, '       ')}`);
  } else {
    warnings += 1;
    console.log(`AVISO  ${name} (borrador: se permite romper, pero queda a la vista)\n${output.replace(/^/gm, '       ')}`);
  }
}

for (const tmp of cleanup) rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'Sin rupturas en contratos congelados' : `${failures} contrato(s) con rupturas`} · ${warnings} aviso(s) en borradores`);
if (toolErrors > 0) {
  console.error(`${toolErrors} contrato(s) no se pudieron comparar: el resultado NO es válido.`);
  process.exit(2);
}
process.exit(failures === 0 ? 0 : 1);
