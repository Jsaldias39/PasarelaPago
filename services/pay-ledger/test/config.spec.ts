import { publicId, useIdNamespace } from '../src/ledger/ids';
import { accountTbId } from './helpers/ids';
import { loadLedgerConfig } from '../src/ledger/ledger.config';

describe('configuración de pay-ledger', () => {
  it('sin TB_ADDRESS no arranca; los valores por defecto son los de producción (sin job del invariante propio ni namespace)', () => {
    expect(() => loadLedgerConfig({})).toThrow('TB_ADDRESS');
    expect(loadLedgerConfig({ TB_ADDRESS: '127.0.0.1:3000', PAY_MODE: 'sandbox' })).toMatchObject({ tb: { address: '127.0.0.1:3000', clusterId: 0n, timeoutMs: 8000 }, invariantIntervalMs: 0, holdSweepIntervalMs: 0, holdExpirySkewMs: 2000, idNamespace: '' });
  });

  it.each([
    ['TB_CLUSTER_ID', '-1'],
    ['TB_TIMEOUT_MS', '5'],
    ['LEDGER_INVARIANT_INTERVAL_MS', 'x'],
    ['LEDGER_ID_NAMESPACE', 'con espacios'],
    ['LEDGER_ID_NAMESPACE', 'a'.repeat(41)],
    ['LEDGER_ID_NAMESPACE', 'ñandú'],
  ])('%s=%p es inválido', (name, value) => {
    expect(() => loadLedgerConfig({ TB_ADDRESS: 'x:1', PAY_MODE: 'sandbox', [name]: value })).toThrow();
  });

  it('LEDGER_ID_NAMESPACE válido se acepta', () => {
    expect(loadLedgerConfig({ TB_ADDRESS: 'x:1', PAY_MODE: 'sandbox', LEDGER_ID_NAMESPACE: 'it_abc-123' }).idNamespace).toBe('it_abc-123');
  });
});

describe('namespace de ids de TigerBeetle', () => {
  it('apartar el namespace cambia TODOS los ids (cuentas e ids públicos) y es determinista', () => {
    const before = accountTbId('platform:fees');
    const beforePublic = publicId('tx', 'pi_abcdefghijkl:capture', 1);
    useIdNamespace('it_uno');
    const uno = accountTbId('platform:fees');
    expect(uno).not.toBe(before);
    expect(publicId('tx', 'pi_abcdefghijkl:capture', 1)).not.toBe(beforePublic);
    useIdNamespace('it_dos');
    expect(accountTbId('platform:fees')).not.toBe(uno);
    useIdNamespace('it_uno');
    expect(accountTbId('platform:fees')).toBe(uno);
  });
});

describe('EVENTS_CARRY_MODE', () => {
  it('apagado por defecto; acepta true|false; cualquier otro valor falla al arrancar', () => {
    expect(loadLedgerConfig({ TB_ADDRESS: 'x:1', PAY_MODE: 'sandbox' }).eventsCarryMode).toBe(false);
    expect(loadLedgerConfig({ TB_ADDRESS: 'x:1', PAY_MODE: 'sandbox', EVENTS_CARRY_MODE: 'true' }).eventsCarryMode).toBe(true);
    expect(loadLedgerConfig({ TB_ADDRESS: 'x:1', PAY_MODE: 'sandbox', EVENTS_CARRY_MODE: 'false' }).eventsCarryMode).toBe(false);
    expect(() => loadLedgerConfig({ TB_ADDRESS: 'x:1', PAY_MODE: 'sandbox', EVENTS_CARRY_MODE: 'yes' })).toThrow(/EVENTS_CARRY_MODE/);
  });
});
