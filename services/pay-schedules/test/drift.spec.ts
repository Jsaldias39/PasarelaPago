import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type IsolatedDatabase, createIsolatedDatabase } from '@pay/testing';
import type { Pool } from 'pg';
import { SCHEDULES_SCHEMA_MAP } from '../src/schema-map';
import { codeSql, extractSql } from './support/code-sql';
import { detectDrift, type Run, type SchemaMap } from './support/drift';

/**
 * Deriva de esquema (P5.H3.M1, regla 97.2): SQL vendorizado (`sql/ddl.sql`, generado por el modelo) ↔ base ↔ mapa del código (`src/schema-map.ts`).
 * Sin ORM: el mapa es la «capa de entidades». Además se comprueba que el SQL literal del código SOLO nombra tablas y columnas del mapa.
 * Cada tipo de deriva tiene su CONTROL NEGATIVO por mutación (si no detecta, el «sin deriva» no vale). El contraste del `ddl.sql` con el repo
 * del modelo lo hace `node scripts/p5-vendor-model-sql.mjs --check` (no falla si el repo hermano no está).
 */
const DDL = join(process.cwd(), 'sql/ddl.sql');
const MAP: SchemaMap = SCHEDULES_SCHEMA_MAP;
// Mutaciones: una tabla del mapa, una columna NOT NULL de texto, una opcional y una de otro tipo.
const T = { table: 'mandates', required: 'kind', optional: 'description' };

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase([DDL]);
});
afterAll(async () => db.drop());

const onPool = (pool: Pool): Run => (sql) => pool.query(sql);

/** Aplica una mutación DDL dentro de una transacción, mide la deriva y la deshace (el resto de las pruebas no ve nada). */
async function drifted(mutation: string[], map: SchemaMap = MAP) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of mutation) await client.query(sql);
    return (await detectDrift((sql) => client.query(sql), map)).map((d) => `${d.kind}:${d.detail}`).sort();
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('sin deriva: mapa ↔ base ↔ SQL vendorizado', () => {
  it('el SQL aplicado coincide con lo que el código asume (tablas, columnas, tipos, nulabilidad), y aplicarlo dos veces no cambia nada', async () => {
    expect(await detectDrift(onPool(db.pool), MAP)).toEqual([]);
    await db.pool.query(readFileSync(DDL, 'utf8'));
    expect(await detectDrift(onPool(db.pool), MAP)).toEqual([]);
  });

  it('el SQL vendorizado conserva su cabecera de generado y declara cada tabla del mapa', () => {
    const sql = readFileSync(DDL, 'utf8');
    expect(sql).toMatch(/Generado de diagram_\d+_\w+\.puml — NO editar a mano/);
    for (const table of Object.keys(MAP)) expect({ table, declarada: new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`).test(sql) }).toEqual({ table, declarada: true });
  });

  it('el código solo nombra tablas y columnas del mapa (INSERT, UPDATE … SET y FROM/JOIN literales de src/)', () => {
    const used = codeSql(join(process.cwd(), 'src'));
    const technical = ['outbox_events', 'inbox_events', 'idempotency_keys'];
    const unknown: string[] = [];
    for (const { file, table, columns } of [...used.inserts, ...used.updates]) {
      if (technical.includes(table)) continue;
      if (!MAP[table]) unknown.push(`${file}: tabla ${table} no está en el mapa`);
      else for (const column of columns) if (!MAP[table]![column]) unknown.push(`${file}: ${table}.${column} no está en el mapa`);
    }
    for (const { file, table } of used.tables) if (!MAP[table] && !technical.includes(table)) unknown.push(`${file}: tabla ${table} no está en el mapa`);
    expect(unknown).toEqual([]);
    // No es un extractor mudo: ve sentencias de verdad.
    expect(used.inserts.length + used.updates.length).toBeGreaterThan(10);
  });

  it('el extractor del código detecta una columna y una tabla que no existen (control negativo del cruce código → mapa)', () => {
    const fake = extractSql('x.ts', "const a = 'INSERT INTO mandates (kind, columna_fantasma) VALUES ($1, $2)'; const b = 'UPDATE mandates SET description = $1, otra_fantasma = $2 WHERE id = $3'; const c = 'SELECT 1 FROM tabla_fantasma t'");
    expect(fake.inserts).toEqual([{ file: 'x.ts', table: 'mandates', columns: ['kind', 'columna_fantasma'] }]);
    expect(fake.updates[0]?.columns).toEqual(['description', 'otra_fantasma']);
    expect(fake.tables.map((t) => t.table)).toContain('tabla_fantasma');
    expect(Object.keys(MAP['mandates']!)).not.toContain('columna_fantasma');
    expect(MAP['tabla_fantasma']).toBeUndefined();
  });
});

describe('el verificador detecta cada tipo de deriva (control negativo por mutación de la base)', () => {
  it('columna AUSENTE en la base', async () => {
    expect(await drifted([`ALTER TABLE ${T.table} DROP COLUMN ${T.optional}`])).toEqual([`columna_ausente:${T.table}.${T.optional}`]);
  });

  it('tabla AUSENTE en la base', async () => {
    expect(await drifted([`DROP TABLE ${T.table} CASCADE`])).toContain(`tabla_ausente:${T.table}`);
  });

  it('columna OBLIGATORIA no mapeada (NOT NULL sin valor por defecto)', async () => {
    expect(await drifted([`ALTER TABLE ${T.table} ADD COLUMN extra_required text NOT NULL DEFAULT ''`, `ALTER TABLE ${T.table} ALTER COLUMN extra_required DROP DEFAULT`])).toEqual([`columna_obligatoria_no_mapeada:${T.table}.extra_required`]);
  });

  it('columna opcional que el mapa no conoce', async () => {
    expect(await drifted([`ALTER TABLE ${T.table} ADD COLUMN extra_optional text`])).toEqual([`columna_sobrante_en_el_mapa:${T.table}.extra_optional existe en la base y no está en el mapa`]);
  });

  it('NULABILIDAD divergente: el modelo vuelve opcional una columna que el código asume obligatoria', async () => {
    expect(await drifted([`ALTER TABLE ${T.table} ALTER COLUMN ${T.required} DROP NOT NULL`])).toEqual([`nulabilidad_divergente:${T.table}.${T.required}: base NULL, mapa NOT NULL`]);
  });

  it('NULABILIDAD divergente: el modelo vuelve obligatoria una columna que el código asume opcional', async () => {
    expect(await drifted([`ALTER TABLE ${T.table} ALTER COLUMN ${T.optional} SET NOT NULL`])).toEqual([`nulabilidad_divergente:${T.table}.${T.optional}: base NOT NULL, mapa NULL`]);
  });

  it('TIPO divergente', async () => {
    expect(await drifted([`ALTER TABLE ${T.table} ALTER COLUMN ${T.required} TYPE varchar(300)`])).toEqual([`tipo_divergente:${T.table}.${T.required}: base character varying, mapa text`]);
  });

  it('tabla sin mapear e índice con nombre generado por Postgres', async () => {
    expect(await drifted(['CREATE TABLE tabla_nueva_sin_mapa (id text PRIMARY KEY)', `CREATE INDEX ON ${T.table} (${T.required})`])).toEqual(
      [`indice_sin_nombre_propio:${T.table}: ${T.table}_${T.required}_idx`, 'tabla_sin_mapear:tabla_nueva_sin_mapa'].sort(),
    );
  });

  it('el mapa del código también diverge: tabla fantasma, columna fantasma, tipo y nulabilidad equivocados', async () => {
    const wrong: SchemaMap = {
      ...MAP,
      tabla_fantasma: { id: { type: 'text', nullable: false } },
      [T.table]: { ...MAP[T.table], columna_fantasma: { type: 'text', nullable: false }, [T.required]: { type: 'integer', nullable: true } },
    };
    expect((await detectDrift(onPool(db.pool), wrong)).map((d) => `${d.kind}:${d.detail}`).sort()).toEqual(
      [
        `columna_ausente:${T.table}.columna_fantasma`,
        `nulabilidad_divergente:${T.table}.${T.required}: base NOT NULL, mapa NULL`,
        'tabla_ausente:tabla_fantasma',
        `tipo_divergente:${T.table}.${T.required}: base text, mapa integer`,
      ].sort(),
    );
  });

  it('las mutaciones se deshacen: tras todas, la base vuelve a no tener deriva', async () => {
    expect(await detectDrift(onPool(db.pool), MAP)).toEqual([]);
  });
});
