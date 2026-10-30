// Verificación de los contratos AsyncAPI: cada mensaje trae un ejemplo válido y las mutaciones (tipo ajeno, campo extra, PII,
// sin merchantid…) deben rechazarse. Uso: yarn contracts:events
// Origen: redactado por el agente de eventos de la ola 0; se versiona para que sea parte del gate.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(repoRoot, 'package.json'));
const { Parser } = require('@asyncapi/parser');
const Ajv2020 = require('ajv/dist/2020').default ?? require('ajv/dist/2020');
const addFormats = require('ajv-formats').default ?? require('ajv-formats');

const ROOT = resolve(repoRoot, 'contracts/asyncapi') + '/';
const FILES = ['payments', 'connectors', 'ledger-settlement', 'merchants-schedules'];

const clone = (x) => JSON.parse(JSON.stringify(x));
function strip(node) {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema' || k === '$id' || k.startsWith('x-parser-')) continue; // anotaciones del parser / id repetido del sobre
      out[k] = strip(v);
    }
    return out;
  }
  return node;
}
const PII_KEYS = /(name|document|email|phone|pan|card_number|cvv|account_number|iban|secret)$/i;
function walkKeys(node, hits, path = '') {
  if (Array.isArray(node)) node.forEach((n, i) => walkKeys(n, hits, `${path}[${i}]`));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (PII_KEYS.test(k) && !/^(connector_transaction_id|statement_line_ref)$/.test(k)) hits.push(`${path}.${k}`);
      walkKeys(v, hits, `${path}.${k}`);
    }
  }
}

const totals = { files: 0, channels: 0, messages: 0, sends: 0, receives: 0, valid: 0, mutantsRejected: 0, mutants: 0, piiHits: 0, noExamples: 0, bad: 0 };
for (const file of FILES) {
  const text = readFileSync(`${ROOT}${file}.yaml`, 'utf8');
  const { document, diagnostics } = await new Parser().parse(text, { source: `${ROOT}${file}.yaml` });
  const errors = diagnostics.filter((d) => d.severity === 0);
  if (!document || errors.length) { console.log(`PARSE FALLA ${file}`, errors.map((e) => e.message)); totals.bad++; continue; }
  totals.files++;
  const channels = document.channels().all();
  totals.channels += channels.length;
  const ops = document.operations().all();
  totals.sends += ops.filter((o) => o.action() === 'send').length;
  totals.receives += ops.filter((o) => o.action() === 'receive').length;
  // cada canal tiene exactamente un publicador
  for (const ch of channels) {
    const sends = ops.filter((o) => o.action() === 'send' && o.channels().all().some((c) => c.id() === ch.id()));
    if (sends.length !== 1) { console.log(`  ${file}: canal ${ch.id()} con ${sends.length} publicadores`); totals.bad++; }
  }
  const messages = document.allMessages().all();
  totals.messages += messages.length;
  let ok = 0;
  for (const msg of messages) {
    const schema = strip(msg.payload().json());
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const examples = msg.examples().all().map((e) => e.payload());
    if (examples.length === 0) { totals.noExamples++; console.log(`  SIN EJEMPLOS: ${msg.name()}`); continue; }
    for (const ex of examples) {
      if (validate(ex)) { ok++; totals.valid++; } else { totals.bad++; console.log(`  EJEMPLO INVÁLIDO ${file}/${msg.name()}:`, JSON.stringify(validate.errors.slice(0, 3))); }
      const hits = [];
      walkKeys(ex.data, hits);
      if (hits.length) { totals.piiHits += hits.length; console.log(`  POSIBLE PII en ${msg.name()}: ${hits}`); }
      // mutaciones: todas deben ser rechazadas
      const mutants = [];
      mutants.push(['type ajeno', (m) => { m.type = 'otro.evento'; }]);
      mutants.push(['source ajeno', (m) => { m.source = '/pay-otro'; }]);
      mutants.push(['campo extra en data', (m) => { m.data.campo_extra = 1; }]);
      mutants.push(['PII en data', (m) => { m.data.full_name = 'Fulano de Tal'; }]);
      mutants.push(['sin subject', (m) => { delete m.subject; }]);
      mutants.push(['sin data', (m) => { delete m.data; }]);
      mutants.push(['id no UUID', (m) => { m.id = 'abc'; }]);
      const firstReq = Object.keys(ex.data)[0];
      mutants.push([`sin ${firstReq} en data`, (m) => { delete m.data[firstReq]; }]);
      if (ex.merchantid !== undefined && (schema.allOf?.[1]?.required ?? []).includes('merchantid')) mutants.push(['sin merchantid', (m) => { delete m.merchantid; }]);
      for (const [name, mutate] of mutants) {
        const m = clone(ex); mutate(m);
        totals.mutants++;
        if (!validate(m)) totals.mutantsRejected++; else { totals.bad++; console.log(`  MUTANTE ACEPTADO (${name}) en ${file}/${msg.name()}`); }
      }
    }
  }
  console.log(`${file}: ${channels.length} canales, ${messages.length} mensajes, ${ok} ejemplos válidos, operaciones ${ops.filter((o) => o.action() === 'send').length} send / ${ops.filter((o) => o.action() === 'receive').length} receive`);
}
console.log(JSON.stringify(totals));
process.exit(totals.bad === 0 && totals.noExamples === 0 && totals.piiHits === 0 && totals.mutants === totals.mutantsRejected ? 0 : 1);
