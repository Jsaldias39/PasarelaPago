/**
 * `yarn test:parity` — corre la suite de contrato de P4 (`CONNECTOR=mock yarn test:contract` y la de `bank_transfer`) y comprueba que el conector `mock` contra el
 * banco EN PROCESO y contra `pay-mockbank` por HTTP den las mismas pruebas con el mismo resultado. Los conectores reales del Mercantil se informan BLOQUEADOS
 * (sin documentación del banco). Cuando exista un adaptador real, se agrega su enlace a la suite de P4 y su par a `PARITY_PAIRS` (e2e/lib/parity.ts).
 * Requisitos: Postgres del Compose (platform/compose.yml) arriba y los `dist/` de pay-connectors y pay-mockbank construibles (la suite construye pay-mockbank sola).
 * Salida 0 = paridad en todos los pares. No levanta ningún stack de los 12 servicios.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './lib/infra.ts';
import { comparePair, groupByBinding, PARITY_PAIRS, parityExitCode, renderParity, type JestJson } from './lib/parity.ts';

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), 'parity-'));
  const outputFile = join(dir, 'contract.json');
  try {
    // Sin CONNECTOR la suite corre todos los enlaces (mock, bank_transfer y los bloqueados) en una sola corrida de jest.
    const env = { ...process.env };
    delete env.CONNECTOR;
    const run = spawnSync('yarn', ['test:contract', '--json', `--outputFile=${outputFile}`], { cwd: join(ROOT, 'services/pay-connectors'), env, stdio: ['ignore', 'inherit', 'inherit'] });
    let json: JestJson;
    try {
      json = JSON.parse(readFileSync(outputFile, 'utf8')) as JestJson;
    } catch {
      process.stderr.write(`parity: jest no dejó resultados (código ${run.status}). ¿Está Postgres arriba y compilan pay-connectors y pay-mockbank?\n`);
      return 2;
    }
    const verdicts = PARITY_PAIRS.map((pair) => comparePair(groupByBinding(json), pair));
    const report = renderParity(verdicts);
    process.stdout.write(`\n${report}\n`);
    const outDir = process.env.PARITY_OUT_DIR;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'paridad.txt'), `${report}\n`);
    }
    return parityExitCode(verdicts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
