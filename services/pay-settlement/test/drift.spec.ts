import { type IsolatedDatabase, createIsolatedDatabase } from '@pay/testing';
import { SETTLEMENT_SCHEMA_MAP } from '../src/settlement/schema-map';
import { detectDrift } from './helpers/drift';
import { repoPath } from './helpers/app';

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase([
    repoPath('services/pay-settlement/sql/ddl.sql'), // vendorizado del modelo (D-18): trae también las tablas de outbox, inbox e idempotencia
  ]);
});
afterAll(async () => db.drop());

describe('deriva SQL ↔ base ↔ mapa del código (P2.H2.M1, 97.2)', () => {
  it('sin deriva: el SQL aplicado coincide con lo que el código asume', async () => {
    expect(await detectDrift(db.pool, SETTLEMENT_SCHEMA_MAP, ['outbox_events', 'inbox_events', 'idempotency_keys'])).toEqual([]);
  });

  describe('el verificador detecta cada tipo de deriva (si no detecta, el «sin deriva» de arriba no vale)', () => {
    afterEach(async () => {
      await db.pool.query('ALTER TABLE settlement_audit DROP COLUMN IF EXISTS extra_required');
      await db.pool.query('ALTER TABLE settlement_audit DROP COLUMN IF EXISTS extra_optional');
    });

    it('columna obligatoria no mapeada', async () => {
      await db.pool.query("ALTER TABLE settlement_audit ADD COLUMN extra_required text NOT NULL DEFAULT ''");
      await db.pool.query('ALTER TABLE settlement_audit ALTER COLUMN extra_required DROP DEFAULT');
      expect(await detectDrift(db.pool, SETTLEMENT_SCHEMA_MAP)).toEqual([{ kind: 'columna_obligatoria_no_mapeada', detail: 'settlement_audit.extra_required' }]);
    });

    it('columna opcional que el mapa no conoce', async () => {
      await db.pool.query('ALTER TABLE settlement_audit ADD COLUMN extra_optional text');
      expect((await detectDrift(db.pool, SETTLEMENT_SCHEMA_MAP)).map((d) => d.kind)).toEqual(['columna_sobrante_en_el_mapa']);
    });

    it('tabla ausente, columna ausente, tipo y nulabilidad divergentes', async () => {
      const map = {
        ...SETTLEMENT_SCHEMA_MAP,
        settlement_fantasma: { id: { type: 'text', nullable: false } },
        settlement_audit: { ...SETTLEMENT_SCHEMA_MAP.settlement_audit, columna_fantasma: { type: 'text', nullable: false }, actor: { type: 'integer', nullable: true } },
      } as const;
      const kinds = (await detectDrift(db.pool, map)).map((d) => `${d.kind}:${d.detail}`).sort();
      expect(kinds).toEqual(
        [
          'columna_ausente:settlement_audit.columna_fantasma',
          'nulabilidad_divergente:settlement_audit.actor: base NOT NULL, mapa NULL',
          'tabla_ausente:settlement_fantasma',
          'tipo_divergente:settlement_audit.actor: base text, mapa integer',
        ].sort(),
      );
    });

    it('tabla sin mapear e índice con nombre generado', async () => {
      await db.pool.query('CREATE TABLE settlement_nueva (id text PRIMARY KEY)');
      await db.pool.query('CREATE INDEX ON settlement_audit (actor)');
      try {
        const kinds = (await detectDrift(db.pool, SETTLEMENT_SCHEMA_MAP)).map((d) => d.kind).sort();
        expect(kinds).toEqual(['indice_sin_nombre_propio', 'tabla_sin_mapear'].sort());
      } finally {
        await db.pool.query('DROP TABLE settlement_nueva');
        await db.pool.query('DROP INDEX settlement_audit_actor_idx');
      }
    });
  });

  it('las restricciones del esquema rechazan lo que el código nunca debe escribir', async () => {
    const bad = async (sql: string, params: unknown[] = []) => db.pool.query(sql, params).then(() => 'aceptó', (e: { code?: string }) => e.code);
    // payout terminal sin step resolved, o failed sin failure_code, o monto 0
    const base = `INSERT INTO settlement_payouts (id, mode, merchant_id, amount_minor, currency, rail, simulated, reason, status, step, hold_business_ref, requested_by, period_from, period_to)
                  VALUES ($1, 'test', 'mc_x', $2, 'BOB', 'bank_transfer', false, 'manual', $3, $4, 'r', 'pay-backoffice', now(), now())`;
    expect(await bad(base, ['po_a', 0, 'pending', 'created'])).toBe('23514');
    expect(await bad(base, ['po_b', 10, 'paid', 'created'])).toBe('23514');
    expect(await bad(base, ['po_c', 10, 'failed', 'resolved'])).toBe('23514');
    expect(await bad(base, ['po_d', 10, 'pending', 'created'])).toBe('aceptó');
    expect(await bad(base, ['po_d', 10, 'pending', 'created'])).toBe('23505'); // id repetido
    // un cobro cobrado de más
    expect(await bad(`INSERT INTO settlement_charges (id, mode, merchant_id, kind, period_key, credit_account, ledger_code, amount_minor, collected_minor, status, requested_by) VALUES ('cg_a','test','mc_x','monthly_fee','2026-10','platform:fees','fee',100,101,'open','x')`)).toBe('23514');
    // dos abonos del mismo mes
    const charge = `INSERT INTO settlement_charges (id, mode, merchant_id, kind, period_key, credit_account, ledger_code, amount_minor, status, requested_by) VALUES ($1,$2,'mc_x','monthly_fee','2026-10','platform:fees','fee',100,'open','x')`;
    expect(await bad(charge, ['cg_b', 'test'])).toBe('aceptó');
    expect(await bad(charge, ['cg_c', 'test'])).toBe('23505');
    // el mismo abono del mismo mes en el OTRO modo es otro cobro (D-28); un modo fuera de test|live no entra
    expect(await bad(charge, ['cg_d', 'live'])).toBe('aceptó');
    expect(await bad(charge, ['cg_e', 'prod'])).toBe('23514');
    // dos lotes para el mismo corte
    const batch = `INSERT INTO settlement_batches (id, mode, cutoff_date, release_days, release_before, period_from, status) VALUES ($1, $2, '2026-10-19', 7, now(), now(), 'running')`;
    expect(await bad(batch, ['sb_a', 'test'])).toBe('aceptó');
    expect(await bad(batch, ['sb_b', 'test'])).toBe('23505');
    expect(await bad(batch, ['sb_c', 'live'])).toBe('aceptó'); // el mismo lunes en el otro modo es otro corte
    expect(await bad(batch, ['sb_d', 'prod'])).toBe('23514');
    // una excepción abierta con resolución, o la misma diferencia dos veces
    const exception = `INSERT INTO settlement_reconciliation_runs (id, mode, connector, period_from, period_to, source, status, requested_by) VALUES ('rr_a','test','mock',now(),now(),'api','running','x')`;
    await db.pool.query(exception);
    const ex = `INSERT INTO settlement_exceptions (id, mode, run_id, connector, kind, difference_minor, statement_line_ref, status, resolution, dedupe_key) VALUES ($1,'test','rr_a','mock','amount_mismatch',1,'l',$2,$3,$4)`;
    expect(await bad(ex, ['rx_a', 'open', 'dismiss', 'a'.repeat(64)])).toBe('23514');
    expect(await bad(ex, ['rx_b', 'open', null, 'b'.repeat(64)])).toBe('aceptó');
    expect(await bad(ex, ['rx_c', 'open', null, 'b'.repeat(64)])).toBe('23505');
    // forma de la excepción según su origen: una contradicción de pay-payments no tiene corrida ni conector; las de una corrida sí, y siempre con modo
    const contradiction = (columns: string, values: string) => `INSERT INTO settlement_exceptions (id, kind, difference_minor, statement_line_ref, status, dedupe_key, ${columns}) VALUES ($1, 'payment_contradiction', 0, 'c', 'open', $2, ${values})`;
    expect(await bad(contradiction('source_detail', `'{"kind":"status_conflict"}'::jsonb`), ['rx_d', 'd'.repeat(64)])).toBe('aceptó'); // modo desconocido (NULL) permitido
    expect(await bad(contradiction('source_detail, run_id', `'{}'::jsonb, 'rr_a'`), ['rx_e', 'e'.repeat(64)])).toBe('23514'); // no tiene corrida
    expect(await bad(contradiction('mode', `'test'`), ['rx_f', 'f'.repeat(64)])).toBe('23514'); // sin detalle de origen
    expect(await bad(`INSERT INTO settlement_exceptions (id, run_id, connector, kind, difference_minor, statement_line_ref, status, dedupe_key, mode) VALUES ('rx_g','rr_a','mock','amount_mismatch',1,'l','open','${'g'.repeat(64)}', NULL)`)).toBe('23514'); // una de corrida exige modo
  });
});
