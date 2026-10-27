import { createHash } from 'node:crypto';
import { parseAccount } from '../src/ledger/accounts';
import { accountTbId, hash128, holdResolveTbId, holdTbId, legTbId, publicId, toHex128 } from '../src/ledger/ids';

const MAX = (1n << 128n) - 1n;

describe('ids deterministas (P2.H1.M3)', () => {
  it('la misma cuenta lógica da siempre el mismo id de 128 bits, y cuentas distintas dan ids distintos', () => {
    expect(accountTbId('platform:fees')).toBe(accountTbId('platform:fees'));
    expect(accountTbId('platform:fees')).not.toBe(accountTbId('payout:clearing'));
    expect(toHex128(accountTbId('platform:fees'))).toMatch(/^[0-9a-f]{32}$/);
  });

  it('valor fijado: un cambio accidental del algoritmo de derivación rompería todos los ids ya asentados', () => {
    const expected = BigInt('0x' + createHash('sha256').update('alovida-pay|ledger|v1|account|platform:fees').digest().subarray(0, 16).toString('hex'));
    expect(accountTbId('platform:fees')).toBe(expected);
  });

  it('el id de la pata depende de business_ref, attempt e índice (H-TB1: un reintento tras rechazo usa un id nuevo)', () => {
    const base = legTbId('pi_abcdefghij:capture', 1, 0);
    expect(legTbId('pi_abcdefghij:capture', 1, 0)).toBe(base);
    expect(legTbId('pi_abcdefghij:capture', 2, 0)).not.toBe(base);
    expect(legTbId('pi_abcdefghij:capture', 1, 1)).not.toBe(base);
    expect(legTbId('pi_abcdefghik:capture', 1, 0)).not.toBe(base);
  });

  it('los dominios no se pisan: la misma cadena como cuenta, pata, retención y resolución da ids distintos', () => {
    const ids = new Set([accountTbId('x'), legTbId('x', 1, 0), holdTbId('x', 1), holdResolveTbId(holdTbId('x', 1))]);
    expect(ids.size).toBe(4);
  });

  it('propiedad (20.000 casos): nunca 0 ni 2^128−1, sin colisiones, y los ids públicos cumplen los patrones del contrato', () => {
    const seen = new Set<bigint>();
    const publicIds = new Set<string>();
    for (let i = 0; i < 20000; i += 1) {
      const id = legTbId(`pi_${i.toString(36).padStart(10, '0')}:capture`, (i % 1000) + 1, i % 100);
      expect(id).toBeGreaterThan(0n);
      expect(id).toBeLessThan(MAX);
      seen.add(id);
      publicIds.add(publicId('tf', `tx_${i}`, i % 100));
    }
    expect(seen.size).toBe(20000);
    expect(publicIds.size).toBe(20000);
    expect(publicId('tx', 'a', 1)).toMatch(/^tx_[a-z0-9]{10,40}$/);
    expect(publicId('hd', 'a', 1)).toMatch(/^hd_[a-z0-9]{10,40}$/);
    expect(publicId('tf', 'a', 1)).toMatch(/^tf_[a-z0-9]{10,40}$/);
    expect(publicId('sl', 'a', 1)).toMatch(/^sl_[a-z0-9]{10,40}$/);
  });

  it('hash128 corrige los dos valores prohibidos de TigerBeetle', () => {
    // No se puede forzar una colisión con 0 o 2^128−1 con sha256; se comprueba el contrato de la función con muchos valores.
    for (let i = 0; i < 2000; i += 1) {
      const v = hash128('x', i);
      expect(v !== 0n && v !== MAX).toBe(true);
    }
  });
});

describe('plan de cuentas', () => {
  it.each([
    ['merchant:mc_k3m9x2q7ab:pending', 'merchant_pending', 'credit', true],
    // La deuda del comercio: cuenta deudora que no se puede pagar de más (P2-D2)
    ['merchant:mc_k3m9x2q7ab:debt', 'merchant_debt', 'debit', true],
    ['merchant:mc_k3m9x2q7ab:available', 'merchant_available', 'credit', true],
    ['user:usr_abc-123:wallet', 'user_wallet', 'credit', true],
    ['platform:fees', 'platform_fees', 'credit', false],
    ['connector:mercantil_qr:clearing', 'connector_clearing', 'debit', false],
    ['payout:clearing', 'payout_clearing', 'credit', false],
    ['schedule:md_k3m9x2q7ab:reserve', 'schedule_reserve', 'credit', true],
  ])('%s → %s (%s, no negativo: %s)', (name, kind, nature, limited) => {
    expect(parseAccount(name)).toMatchObject({ name, kind, nature, limited });
  });

  it.each(['', 'platform:fee', 'merchant:mc_short:pending', 'merchant:mc_k3m9x2q7ab:other', 'user:a:wallet', 'connector:AB:clearing', 'x', 'merchant:mc_k3m9x2q7ab:pending ', 'platform:fees\n'])(
    'rechaza %p',
    (name) => expect(parseAccount(name)).toBeNull(),
  );

  it('extrae el comercio dueño', () => {
    expect(parseAccount('merchant:mc_k3m9x2q7ab:pending')?.merchantId).toBe('mc_k3m9x2q7ab');
    expect(parseAccount('platform:fees')?.merchantId).toBeUndefined();
  });
});
