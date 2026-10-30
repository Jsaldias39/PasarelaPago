import { join } from 'node:path';
import { type IsolatedDatabase, createIsolatedDatabase } from '@pay/testing';
import { REQUIRED_KYC_KINDS } from '../src/merchants/merchants.service';
import { MERCHANTS_SCHEMA_MAP } from '../src/schema-map';

/**
 * P5.H1.M1 — contraste del esquema GENERADO (`sql/ddl.sql`) con el bloque de alta legal del stakeholder (registro de procesos 3.1; se repite en
 * los módulos 3, 4, 5 y 6). Cada renglón de la fuente tiene un destino declarado (D5-01): o una columna / documento de `pay-merchants`, o el
 * `directory` (M04) por la referencia opaca `merchants.directory_tenant_ref` (pregunta abierta Q-22: referenciar o recapturar). Si el modelo
 * cambia un destino, esta prueba falla y obliga a revisar D5-01.
 */
type Destino = { en: 'merchants'; columna: string } | { en: 'kyc'; tipo: (typeof REQUIRED_KYC_KINDS)[number] } | { en: 'directory' };
const PUNTOS: readonly { renglon: string; destino: Destino }[] = [
  { renglon: 'Nombre o razón social de la empresa', destino: { en: 'merchants', columna: 'legal_name' } },
  { renglon: 'Tipo societario (selección cerrada)', destino: { en: 'merchants', columna: 'legal_type' } },
  { renglon: 'Constitución de la empresa en PDF', destino: { en: 'kyc', tipo: 'constitucion' } },
  { renglon: 'Número de NIT', destino: { en: 'merchants', columna: 'tax_id' } },
  { renglon: 'NIT en PDF', destino: { en: 'kyc', tipo: 'nit' } },
  { renglon: 'SEPREC en PDF', destino: { en: 'kyc', tipo: 'seprec' } },
  { renglon: 'Licencia de funcionamiento en PDF', destino: { en: 'kyc', tipo: 'licencia_funcionamiento' } },
  { renglon: 'Certificado del SEDES en PDF', destino: { en: 'kyc', tipo: 'certificado_sedes' } },
  { renglon: 'Poder del representante legal en PDF', destino: { en: 'kyc', tipo: 'poder_representante' } },
  ...[
    'Dirección legal de la central',
    'Ubicación GPS de la dirección central',
    'Nombre del representante legal',
    'Correo del representante legal',
    'Gerente General: nombre',
    'Gerente General: celular',
    'Gerente General: correo',
    'Gerente Comercial: nombre',
    'Gerente Comercial: celular',
    'Gerente Comercial: correo',
    'Gerente Marketing: nombre',
    'Gerente Marketing: celular',
    'Gerente Marketing: correo',
    'Ubicación GPS de cada sucursal',
  ].map((renglon) => ({ renglon, destino: { en: 'directory' } as Destino })),
];
/** Los ocho valores de la lista cerrada de tipo societario del registro 3.1. */
const TIPOS_SOCIETARIOS = ['unipersonal', 'srl', 'ltda', 'sa', 'sociedad_colectiva', 'sociedad_comandita_simple', 'sociedad_comandita_acciones', 'sucursal_sociedad_extranjera'];

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase([join(process.cwd(), 'sql/ddl.sql')]);
});
afterAll(async () => db.drop());

let n = 0;
const insertMerchant = (legalType: string) =>
  db.pool.query(`INSERT INTO merchants (id, display_name, legal_name, legal_type, tax_id, status) VALUES ($1, 'Comercio sintético', 'Razón social sintética', $2, $3, 'pending')`, [`mc_altalegal${String((n += 1)).padStart(3, '0')}`, legalType, `2000${String(n).padStart(6, '0')}`]);

describe('los puntos del alta legal (3.1) siguen mapeados contra el esquema generado', () => {
  it('los 23 renglones de la fuente (agrupados como «18 puntos») tienen destino: 9 en pay-merchants y 14 por la referencia al directory', () => {
    expect(PUNTOS).toHaveLength(23);
    expect(PUNTOS.filter((p) => p.destino.en !== 'directory')).toHaveLength(9);
    expect(PUNTOS.filter((p) => p.destino.en === 'directory')).toHaveLength(14);
  });

  it('cada columna de pay-merchants que recibe un punto existe en el esquema generado y es obligatoria', () => {
    for (const { renglon, destino } of PUNTOS) {
      if (destino.en !== 'merchants') continue;
      expect({ renglon, columna: MERCHANTS_SCHEMA_MAP.merchants![destino.columna] }).toEqual({ renglon, columna: { type: 'text', nullable: false } });
    }
  });

  it('los seis PDF son exactamente los tipos de documento que acepta la base y los que exige el KYC; un séptimo se rechaza', async () => {
    const tipos = PUNTOS.flatMap((p) => (p.destino.en === 'kyc' ? [p.destino.tipo] : [])).sort();
    expect(tipos).toEqual([...REQUIRED_KYC_KINDS].sort());
    await insertMerchant('srl');
    const id = (await db.pool.query(`SELECT id FROM merchants ORDER BY id DESC LIMIT 1`)).rows[0].id as string;
    for (const kind of tipos) {
      await db.pool.query(
        `INSERT INTO kyc_documents (id, merchant_id, kind, object_key, sha256, size_bytes, detected_type, uploaded_by) VALUES ($1, $2, $3, $4, $5, 10, 'application/pdf', 'operador_sintetico')`,
        [`kd_${kind}`.slice(0, 40), id, kind, `kyc/${id}/${kind}`, 'a'.repeat(64)],
      );
    }
    await expect(
      db.pool.query(`INSERT INTO kyc_documents (id, merchant_id, kind, object_key, sha256, size_bytes, detected_type, uploaded_by) VALUES ('kd_septimo', $1, 'otro_documento', 'k', $2, 10, 'application/pdf', 'x')`, [id, 'b'.repeat(64)]),
    ).rejects.toThrow(/kyc_documents_kind_valid/);
  });

  it('el tipo societario es una selección cerrada de ocho valores: los ocho entran, uno inventado se rechaza', async () => {
    for (const tipo of TIPOS_SOCIETARIOS) await insertMerchant(tipo);
    await expect(insertMerchant('cooperativa_inventada')).rejects.toThrow(/merchants_legal_type_valid/);
  });

  it('los datos que viven en el directory se referencian con una columna opcional y opaca (Q-22 sigue abierta)', () => {
    expect(MERCHANTS_SCHEMA_MAP.merchants!.directory_tenant_ref).toEqual({ type: 'text', nullable: true });
  });
});
