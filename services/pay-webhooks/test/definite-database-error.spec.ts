import { Pool } from 'pg';
import { isDefiniteDatabaseError } from '../src/endpoints/endpoint.service';

/**
 * RE-REVISION-DINERO F-B3: solo un error que el SERVIDOR de base de datos respondió (SQLSTATE de una clase real de PostgreSQL, severidad ERROR) prueba que la
 * transacción quedó abortada. Los códigos de Node (`EPIPE`, `EBADF`, `ELOOP`, `ECONNRESET`…) y un FATAL (posible COMMIT ya aplicado) NO lo prueban (regla 11).
 */
describe('isDefiniteDatabaseError', () => {
  const server = (code: string, severity = 'ERROR') => Object.assign(new Error('x'), { code, severity });

  it.each(['23505', '23000', '40001', '40P01', '42P01', '22P02', '0A000', '25P02', 'XX000', 'P0001', 'F0000', 'HV000', '08006', '53300'])('CORRECTO: el SQLSTATE %s de una clase real, con severidad ERROR ⇒ definitivo', (code) => {
    expect(isDefiniteDatabaseError(server(code))).toBe(true);
  });

  it.each(['EPIPE', 'EBADF', 'ELOOP', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_X'])('INVÁLIDO: el código de Node %s (aunque tenga 5 caracteres) NO es un SQLSTATE ⇒ ambiguo', (code) => {
    expect(isDefiniteDatabaseError(server(code))).toBe(false);
    expect(isDefiniteDatabaseError(Object.assign(new Error('x'), { code }))).toBe(false);
  });

  it('INVÁLIDO: un SQLSTATE válido con severidad FATAL o PANIC (puede llegar tras un COMMIT aplicado: 57P01) o sin severidad ⇒ ambiguo', () => {
    expect(isDefiniteDatabaseError(server('57P01', 'FATAL'))).toBe(false);
    expect(isDefiniteDatabaseError(server('XX000', 'PANIC'))).toBe(false);
    expect(isDefiniteDatabaseError(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
  });

  it.each([undefined, null, 'cadena', 42, {}, { code: 23505, severity: 'ERROR' }, { code: '2350', severity: 'ERROR' }, { code: '235055', severity: 'ERROR' }, { code: '2350a', severity: 'ERROR' }, { code: 'Z9999', severity: 'ERROR' }])('LÍMITE: %j ⇒ ambiguo', (value) => {
    expect(isDefiniteDatabaseError(value)).toBe(false);
  });

  describe('contra Postgres real (errores de verdad del driver)', () => {
    let pool: Pool;
    beforeAll(() => {
      pool = new Pool({ connectionString: process.env.PAY_TEST_DATABASE_URL, max: 2 });
    });
    afterAll(async () => pool.end());

    it('una sentencia que el servidor rechaza (tabla inexistente, 42P01) es definitiva', async () => {
      const error = await pool.query('SELECT 1 FROM tabla_que_no_existe_fb').catch((e: unknown) => e);
      expect(error).toMatchObject({ code: '42P01', severity: 'ERROR' });
      expect(isDefiniteDatabaseError(error)).toBe(true);
    });

    it('una terminación administrativa de la conexión (57P01, FATAL) NO es definitiva', async () => {
      const victim = await pool.connect();
      const pid = Number((await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const killer = await pool.connect();
      try {
        const pending = victim.query('SELECT pg_sleep(5)').catch((e: unknown) => e);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await killer.query('SELECT pg_terminate_backend($1)', [pid]);
        const error = await pending;
        expect(error).toMatchObject({ code: '57P01' });
        expect((error as { severity?: string }).severity).toBe('FATAL');
        expect(isDefiniteDatabaseError(error)).toBe(false);
      } finally {
        victim.release(true);
        killer.release();
      }
    });
  });
});
