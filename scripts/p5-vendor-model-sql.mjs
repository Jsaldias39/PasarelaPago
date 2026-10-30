#!/usr/bin/env node
// Vendoriza el DDL que GENERA el modelo (mantra-core-health-model, D-18) para los servicios de P5, y lo verifica.
//   node scripts/p5-vendor-model-sql.mjs            copia SQL/pay/<NN>_<svc>/ddl.sql -> services/<svc>/sql/ddl.sql
//   node scripts/p5-vendor-model-sql.mjs --check    compara la copia con el modelo; sale 1 si difieren
// El repo hermano se busca en ../mantra-core-health-model (o en $MODEL_REPO). Si NO está, `--check` NO falla: dice que no pudo comparar y solo
// comprueba que la copia vendorizada exista y conserve la cabecera «Generado de … NO editar a mano». Es la misma idea que `vendor-ddl.sh` de la API.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = join(process.env.MODEL_REPO ?? resolve(ROOT, '../mantra-core-health-model'), 'SQL/pay');
const MAP = { 'pay-merchants': '73_pay_merchants', 'pay-risk': '76_pay_risk', 'pay-schedules': '77_pay_schedules' };
const check = process.argv.includes('--check');
const normalize = (text) => text.replace(/\r\n/g, '\n');
let bad = 0;
const siblingPresent = existsSync(MODEL);
if (check && !siblingPresent) console.log(`AVISO  no está ${MODEL}: no se puede comparar con el modelo; solo se comprueba la copia vendorizada`);
for (const [svc, dir] of Object.entries(MAP)) {
  const src = join(MODEL, dir, 'ddl.sql');
  const dst = join(ROOT, 'services', svc, 'sql', 'ddl.sql');
  if (!check) {
    if (!existsSync(src)) {
      console.log(`FALLA  ${svc}: no existe ${src}`);
      bad += 1;
      continue;
    }
    copyFileSync(src, dst);
    console.log(`COPIADO ${src} -> services/${svc}/sql/ddl.sql`);
    continue;
  }
  if (!existsSync(dst)) {
    console.log(`FALLA  ${svc}: falta services/${svc}/sql/ddl.sql`);
    bad += 1;
    continue;
  }
  const copy = normalize(readFileSync(dst, 'utf8'));
  if (!/Generado de diagram_\d+_\w+\.puml — NO editar a mano/.test(copy)) {
    console.log(`FALLA  ${svc}: la copia no conserva la cabecera «Generado de … NO editar a mano»`);
    bad += 1;
    continue;
  }
  if (!siblingPresent || !existsSync(src)) {
    console.log(`OK     ${svc}: copia presente con su cabecera (sin modelo hermano para comparar)`);
    continue;
  }
  if (normalize(readFileSync(src, 'utf8')) === copy) console.log(`OK     ${svc}: idéntico a ${dir}/ddl.sql del modelo`);
  else {
    console.log(`FALLA  ${svc}: difiere de ${dir}/ddl.sql del modelo (regenerar y vendorizar: node scripts/p5-vendor-model-sql.mjs)`);
    bad += 1;
  }
}
process.exit(bad === 0 ? 0 : 1);
