import type { Pool } from 'pg';

/**
 * Detector de datos sensibles para el gate «Datos sensibles» (PLAN-MAESTRO §7, regla 90.2). Se cuelan valores CANARIO en cada lugar por el
 * que podría entrar algo (campos desconocidos, ids malformados, glosas de extractos, mensajes de error) y después se busca TODO lo que
 * el servicio produjo: logs, respuestas (errores incluidos), eventos del outbox y filas de la base. Datos 100 % sintéticos: el PAN es el
 * número de prueba público de Visa (4111…1111) y el resto son valores inventados.
 */
export const CANARY = {
  pan: '4111111111111111',
  panSpaced: '4111 1111 1111 1111',
  panDashed: '4111-1111-1111-1111',
  cvv: 'CVV=737',
  document: '7654321-LP',
  name: 'JUANA CANARIO QUISPE',
} as const;
export const CANARY_VALUES: string[] = Object.values(CANARY);

/** Nombres de campo que no deben existir en nada que el servicio escriba o emita (ledger y settlement no manejan tarjeta, documento ni nombres). */
const SENSITIVE_KEY = /["']?\b(pan|card_?number|cvv2?|cvc2?|card_?holder|holder_?name|full_?name|first_?name|last_?name|document_?(?:number|id)|national_?id|ci_?number|nit)\b["']?\s*[:=]/i;

const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
};

/**
 * Cualquier valor con forma de PAN: 15 a 19 dígitos (con espacios o guiones) que cumplan Luhn. No se buscan 13 dígitos porque un instante en
 * milisegundos tiene 13 y daría falsos positivos (el 10 % pasa Luhn); los instantes de los logs se quitan antes de buscar.
 */
export function panLikeValues(text: string): string[] {
  const cleaned = text.replace(/"(?:time|timestamp|responseTime)":\s*\d+/g, '');
  const found: string[] = [];
  for (const m of cleaned.matchAll(/(?<![\d.])(?:\d[ -]?){14,18}\d(?![\d])/g)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 15 && digits.length <= 19 && luhn(digits)) found.push(m[0]);
  }
  return found;
}

export interface Leak {
  readonly where: string;
  readonly what: string;
}

/** Todo lo que delata un dato sensible en `text`, con su procedencia. Lista vacía = limpio. */
export function findLeaks(where: string, text: string): Leak[] {
  const leaks: Leak[] = [];
  for (const canary of CANARY_VALUES) if (text.includes(canary)) leaks.push({ where, what: `canario «${canary}»` });
  if (/CANARIO/i.test(text) && !leaks.some((l) => l.what.includes('JUANA'))) leaks.push({ where, what: 'fragmento de nombre «CANARIO»' });
  for (const pan of panLikeValues(text)) leaks.push({ where, what: `valor con forma de PAN «${pan}»` });
  const key = SENSITIVE_KEY.exec(text);
  if (key) leaks.push({ where, what: `campo sensible «${key[1]}»` });
  return leaks;
}

/** Captura lo que el proceso escribe en stdout y stderr (pino, el logger de Nest y cualquier `console`) mientras corre `body`. */
export async function captureOutput<T>(body: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const grab = (original: typeof process.stdout.write) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = grab(out);
  process.stderr.write = grab(err);
  try {
    const result = await body();
    return { result, output: chunks.join('') };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** Vuelca como texto TODAS las filas de TODAS las tablas del esquema de la prueba (eventos del outbox, bandeja, idempotencia, rechazos, auditoría…). */
export async function dumpSchema(pool: Pool): Promise<{ tables: string[]; text: string }> {
  const tables = (await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.table_name);
  const parts: string[] = [];
  for (const table of tables) {
    const rows = await pool.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM "${table}" t`);
    for (const r of rows.rows) parts.push(`${table} ${r.row}`);
  }
  return { tables, text: parts.join('\n') };
}
