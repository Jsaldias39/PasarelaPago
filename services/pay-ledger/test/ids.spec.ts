import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseAccount } from '../src/ledger/accounts';
import { hash128, holdResolveTbId, publicId, toHex128 } from '../src/ledger/ids';
import { accountTbId, holdTbId, legTbId } from './helpers/ids';

const MAX = (1n << 128n) - 1n;

describe('ids deterministas (P2.H1.M3)', () => {
  it('la misma cuenta lógica da siempre el mismo id de 128 bits, y cuentas distintas dan ids distintos', () => {
    expect(accountTbId('platform:fees')).toBe(accountTbId('platform:fees'));
    expect(accountTbId('platform:fees')).not.toBe(accountTbId('payout:clearing'));
    expect(toHex128(accountTbId('platform:fees'))).toMatch(/^[0-9a-f]{32}$/);
  });

  it('valor fijado: un cambio accidental del algoritmo de derivación rompería todos los ids ya asentados', () => {
    const expected = BigInt('0x' + createHash('sha256').update('alovida-pay|ledger|v1|account|test|platform:fees').digest().subarray(0, 16).toString('hex'));
    expect(accountTbId('platform:fees')).toBe(expected);
  });

  it('el id de la pata depende de business_ref, attempt e índice (H-TB1: un reintento tras rechazo usa un id nuevo)', () => {
    const base = legTbId('pi_abcdefghij:capture', 1, 0);
    expect(legTbId('pi_abcdefghij:capture', 1, 0)).toBe(base);
    expect(legTbId('pi_abcdefghij:capture', 2, 0)).not.toBe(base);
    expect(legTbId('pi_abcdefghij:capture', 1, 1)).not.toBe(base);
    expect(legTbId('pi_abcdefghik:capture', 1, 0)).not.toBe(base);
  });

  it('el MODO entra en todos los ids: la misma cuenta, pata y retención de `test` y de `live` son identidades distintas (D-28)', () => {
    expect(accountTbId('platform:fees', 'test')).not.toBe(accountTbId('platform:fees', 'live'));
    expect(legTbId('pi_abcdefghij:capture', 1, 0, 'main', 'test')).not.toBe(legTbId('pi_abcdefghij:capture', 1, 0, 'main', 'live'));
    expect(legTbId('pi_abcdefghij:capture', 1, 0, 'debt', 'test')).not.toBe(legTbId('pi_abcdefghij:capture', 1, 0, 'debt', 'live'));
    expect(holdTbId('pi_abcdefghij:capture', 1, 'test')).not.toBe(holdTbId('pi_abcdefghij:capture', 1, 'live'));
    expect(publicId('tx', 'test', 'pi_abcdefghij:capture', 1)).not.toBe(publicId('tx', 'live', 'pi_abcdefghij:capture', 1));
    expect(publicId('hd', 'test', 'pi_abcdefghij:capture', 1)).not.toBe(publicId('hd', 'live', 'pi_abcdefghij:capture', 1));
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

describe('los ids con el modo son deterministas y estables entre reinicios y entre réplicas (D-28)', () => {
  const REF = 'pi_abcdefghij1k:capture';
  // VALORES FIJADOS. Si esta tabla cambia, todo ledger con datos pierde la correspondencia entre sus filas de Postgres y sus cuentas y
  // transferencias de TigerBeetle: cambiar la derivación exige una migración (README del ledger, «Cambiar la derivación de ids»).
  const GOLDEN = {
    acct_test: '41bda7c00ea9b23771a88b4483d5463e',
    acct_live: 'ea95f847af21d92d9e06dab1a8d5a998',
    leg: '25eb009ed9d85040bb59101e812bb84d',
    legdebt: '85cbaf5fb4d1c454e72e777a7ca5bbe4',
    hold: '6080f5b5967d46d770d7800d77be4cdf',
    tx_test: 'tx_6dgzaawf56hpf3zfekxs',
    tx_live: 'tx_c4yrjqyn6ioi7wplu5mj',
    hd_live: 'hd_jdjuxyof5cjwi27mykym',
    tf: 'tf_jyj6y5mu3ulgqdssynpb',
    sl: 'sl_vgp4lzyhmm4zd5ci33mz',
  };
  const compute = (m: typeof import('../src/ledger/ids')) => {
    const txTest = m.publicId('tx', 'test', REF, 1);
    return {
      acct_test: m.accountTbId('test', 'platform:fees').toString(16),
      acct_live: m.accountTbId('live', 'platform:fees').toString(16),
      leg: m.legTbId('test', REF, 1, 0).toString(16),
      legdebt: m.legTbId('live', REF, 2, 3, 'debt').toString(16),
      hold: m.holdTbId('live', REF, 1).toString(16),
      tx_test: txTest,
      tx_live: m.publicId('tx', 'live', REF, 1),
      hd_live: m.publicId('hd', 'live', REF, 1),
      tf: m.publicId('tf', txTest, 0),
      sl: m.publicId('sl', m.publicId('tf', txTest, 0), 'debit'),
    };
  };

  it('valores fijados: la derivación de hoy da exactamente estos ids', async () => {
    expect(compute(await import('../src/ledger/ids'))).toEqual(GOLDEN);
  });

  it('un reinicio y dos réplicas (procesos nuevos y aparte, con otra zona horaria, otro idioma y otro entorno) calculan los mismos ids que este proceso', () => {
    const script = `const m = await import(${JSON.stringify(`${process.cwd()}/src/ledger/ids.ts`)});
      const REF = ${JSON.stringify(REF)}; const tx = m.publicId('tx','test',REF,1);
      console.log(JSON.stringify({acct_test:m.accountTbId('test','platform:fees').toString(16),acct_live:m.accountTbId('live','platform:fees').toString(16),leg:m.legTbId('test',REF,1,0).toString(16),legdebt:m.legTbId('live',REF,2,3,'debt').toString(16),hold:m.holdTbId('live',REF,1).toString(16),tx_test:tx,tx_live:m.publicId('tx','live',REF,1),hd_live:m.publicId('hd','live',REF,1),tf:m.publicId('tf',tx,0),sl:m.publicId('sl',m.publicId('tf',tx,0),'debit')}));`;
    const replica = (env: NodeJS.ProcessEnv) => {
      const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
      expect(out.status).toBe(0);
      return JSON.parse(out.stdout.trim().split('\n').pop() as string) as typeof GOLDEN;
    };
    expect(replica({ TZ: 'America/La_Paz', LANG: 'es_BO.UTF-8' })).toEqual(GOLDEN);
    expect(replica({ TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', NODE_ENV: 'production', HOSTNAME: 'replica-2' })).toEqual(GOLDEN);
  });

  it('el modo, el business_ref y el intento cambian el id; nada más (sin reloj, sin azar, sin dependencia del entorno)', () => {
    const base = legTbId(REF, 1, 0);
    const again = Array.from({ length: 50 }, () => legTbId(REF, 1, 0));
    expect(new Set(again)).toEqual(new Set([base]));
    expect(legTbId(REF, 1, 0, 'main', 'live')).not.toBe(base);
    expect(legTbId(REF, 2, 0)).not.toBe(base);
    expect(legTbId(`${REF}x`, 1, 0)).not.toBe(base);
  });
});
