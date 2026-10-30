// Guardianes de SOLO-AGREGAR del modelo, pay-settlement (ola-5/P2; cierra la propuesta ola-3/P2/PROPUESTAS.md #20): settlement_audit.
// El servicio solo hace INSERT en ellas (ver docs/trabajo/ola-5/P2/INFORME.md, evidencia de grep); la regla 5 de CLAUDE.md («los errores se corrigen con asientos inversos,
// nunca con UPDATE ni DELETE») la cumplía el código y no la base. Postgres real, en un esquema descartable; el pool de pruebas es dueño de las tablas (y superusuario).
// Tres niveles: correcto (INSERT y reentrega con ON CONFLICT DO NOTHING), límite (cero filas, tabla hermana sin guardián), inválido (UPDATE, DELETE, TRUNCATE, ON CONFLICT DO UPDATE).
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { type IsolatedDatabase, createIsolatedDatabase } from '@pay/testing';

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase([join(process.cwd(), 'sql/ddl.sql')]);
});
afterAll(async () => db.drop());

const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);
const rnd = () => randomBytes(5).toString('hex');
/** Lo que el modelo promete: SQLSTATE 23000 (integrity_constraint_violation) y el mensaje de forbid_mutation(). */
const immutable = (table: string, op: 'UPDATE' | 'DELETE' | 'TRUNCATE') => ({ code: '23000', message: `la tabla ${table} es inmutable (${op})` });
const snapshot = async (table: string, where: string) => (await q(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${where}`)).rows.map((r) => r.row);

/** TRUNCATE … CASCADE con los guardianes `_no_truncate` de las OTRAS tablas apagados (transacción revertida siempre): prueba que cada tabla tiene el suyo. Devuelve el error. */
async function truncateWithOthersDisarmed(table: string): Promise<unknown> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const other of CASES.map((c) => c.table).filter((t) => t !== table)) await client.query(`ALTER TABLE ${other} DISABLE TRIGGER ${other}_no_truncate`);
    return await client.query(`TRUNCATE ${table} CASCADE`).then(
      () => 'el TRUNCATE no fue rechazado',
      (error: unknown) => error,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

interface Case {
  table: string;
  /** Inserta UNA fila nueva (con lo que necesite de las tablas padre) y devuelve la condición que la identifica. */
  insert(): Promise<string>;
  /** Asignación válida (pasa los CHECK) que cambia el valor de la fila insertada. */
  set: string;
  /** Columnas de la clave primaria, para el INSERT … ON CONFLICT (…) DO UPDATE. */
  pk: string;
  /** Columna de `set`, para el DO UPDATE. */
  setColumn: string;
}

const CASES: Case[] = [
  {
    table: 'settlement_audit',
    pk: 'id',
    setColumn: 'actor',
    set: "actor = 'otro'",
    async insert() {
      const res = await q(`INSERT INTO settlement_audit (actor, role, action, subject, detail) VALUES ('pay-settlement', 'system', 'payout.needs_attention', $1, '{"reason":"sintetico"}'::jsonb) RETURNING id`, [`po_${rnd()}`]);
      return `id = ${res.rows[0].id}`;
    },
  },
];

describe.each(CASES)('$table es de solo-agregar', ({ table, insert, set, pk, setColumn }) => {
  it('correcto: INSERT permitido y legible; la reentrega con ON CONFLICT DO NOTHING no la toca', async () => {
    const where = await insert();
    const before = await snapshot(table, where);
    expect(before).toHaveLength(1);
    const again = await q(`INSERT INTO ${table} OVERRIDING SYSTEM VALUE SELECT * FROM ${table} WHERE ${where} ON CONFLICT DO NOTHING`);
    expect(again.rowCount).toBe(0);
    expect(await snapshot(table, where)).toEqual(before);
  });

  it('inválido: UPDATE rechazado (23000, tabla y operación en el mensaje) y la fila queda intacta', async () => {
    const where = await insert();
    const before = await snapshot(table, where);
    await expect(q(`UPDATE ${table} SET ${set} WHERE ${where}`)).rejects.toMatchObject(immutable(table, 'UPDATE'));
    expect(await snapshot(table, where)).toEqual(before);
  });

  it('inválido: DELETE rechazado y la fila sigue', async () => {
    const where = await insert();
    const before = await snapshot(table, where);
    await expect(q(`DELETE FROM ${table} WHERE ${where}`)).rejects.toMatchObject(immutable(table, 'DELETE'));
    expect(await snapshot(table, where)).toEqual(before);
  });

  it('inválido: TRUNCATE (también con CASCADE) rechazado: no pasa por los triggers de fila, por eso tiene el suyo', async () => {
    const where = await insert();
    const before = await snapshot(table, where);
    // A secas: lo frena el guardián o, si otra tabla la referencia por FK, Postgres (que revisa las FK antes de disparar los triggers).
    await expect(q(`TRUNCATE ${table}`)).rejects.toThrow(/inmutable|foreign key/);
    await expect(q(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject(immutable(table, 'TRUNCATE'));
    // El guardián PROPIO, sin ayuda de los de las demás tablas ni de las FK: se apagan los otros dentro de una transacción que siempre se revierte.
    expect(await truncateWithOthersDisarmed(table)).toMatchObject(immutable(table, 'TRUNCATE'));
    expect(await snapshot(table, where)).toEqual(before);
  });

  it('inválido: INSERT … ON CONFLICT DO UPDATE rechazado (es un UPDATE por la puerta de atrás)', async () => {
    const where = await insert();
    const before = await snapshot(table, where);
    await expect(q(`INSERT INTO ${table} OVERRIDING SYSTEM VALUE SELECT * FROM ${table} WHERE ${where} ON CONFLICT (${pk}) DO UPDATE SET ${setColumn} = EXCLUDED.${setColumn}`)).rejects.toMatchObject(immutable(table, 'UPDATE'));
    expect(await snapshot(table, where)).toEqual(before);
  });

  it('límite: un UPDATE o DELETE que no alcanza ninguna fila no muta nada y pasa (el guardián es por fila)', async () => {
    const where = await insert();
    const before = await snapshot(table, where);
    expect((await q(`UPDATE ${table} SET ${set} WHERE false`)).rowCount).toBe(0);
    expect((await q(`DELETE FROM ${table} WHERE false`)).rowCount).toBe(0);
    expect(await snapshot(table, where)).toEqual(before);
  });
});

describe('alcance del guardián', () => {
  it('límite: una tabla hermana SIN guardián (idempotency_keys) se sigue pudiendo actualizar y vaciar', async () => {
    const key = `p2-${rnd()}`;
    await q(`INSERT INTO idempotency_keys (scope, key, request_hash, state, expires_at) VALUES ('p2', $1, 'h', 'started', now() + interval '1 hour')`, [key]);
    expect((await q(`UPDATE idempotency_keys SET state = 'completed' WHERE key = $1`, [key])).rowCount).toBe(1);
    await expect(q('TRUNCATE idempotency_keys')).resolves.toBeDefined();
  });

  it('límite: el modelo declara los guardianes como triggers habilitados (UPDATE/DELETE por fila y TRUNCATE por sentencia) en cada tabla', async () => {
    const tables = CASES.map((c) => c.table);
    const rows = (
      await q(
        `SELECT c.relname AS tabla, t.tgname, t.tgenabled, (t.tgtype & 1) = 1 AS por_fila, (t.tgtype & 16) = 16 AS upd, (t.tgtype & 8) = 8 AS del, (t.tgtype & 32) = 32 AS trunc
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND c.relname = ANY($1) AND c.relnamespace = current_schema()::regnamespace`,
        [tables],
      )
    ).rows;
    for (const table of tables) {
      const mine = rows.filter((r) => r.tabla === table);
      expect(mine.map((r) => r.tgname).sort()).toEqual([`${table}_immutable`, `${table}_no_truncate`]);
      expect(mine.every((r) => r.tgenabled === 'O')).toBe(true);
      const rowTrigger = mine.find((r) => r.tgname === `${table}_immutable`);
      expect(rowTrigger).toMatchObject({ por_fila: true, upd: true, del: true, trunc: false });
      expect(mine.find((r) => r.tgname === `${table}_no_truncate`)).toMatchObject({ por_fila: false, trunc: true });
    }
  });
});
