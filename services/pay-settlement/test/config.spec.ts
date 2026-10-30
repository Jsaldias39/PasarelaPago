import { loadSettlementConfig } from '../src/settlement/settlement.config';

const PEM = '-----BEGIN PUBLIC KEY-----\\nMIIB\\n-----END PUBLIC KEY-----';
const base = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PAY_MODE: 'sandbox',
  LEDGER_URL: 'http://pay-ledger:3000',
  CONNECTORS_URL: 'http://pay-connectors:3000/',
  OPERATOR_TOKEN_PUBLIC_KEY: PEM,
  OPERATOR_TOKEN_ISSUER: 'https://identidad.alovida.test',
  OPERATOR_TOKEN_AUDIENCE: 'pay-settlement',
  ...over,
});

describe('configuración de pay-settlement: falla al arrancar con algo faltante o peligroso', () => {
  it('valores por defecto: modo A, sandbox, corte los lunes (D-19), UTC−4, T+7, retención de 7 días, conector de pruebas', () => {
    const config = loadSettlementConfig(base());
    expect(config).toMatchObject({
      mode: 'bank',
      payMode: 'sandbox',
      cutoffWeekday: 1,
      tzOffsetMinutes: -240,
      releaseDays: 7,
      payoutHoldTtlSeconds: 604_800,
      transferConnector: 'mock',
      ledgerUrl: 'http://pay-ledger:3000',
      connectorsUrl: 'http://pay-connectors:3000',
      sweepIntervalMs: 0,
      statementFormats: {},
    });
    expect(config.operator.publicKeyPem).toContain('\n'); // los \n escapados de una variable de entorno se vuelven saltos de línea
  });

  it('PAY_MODE es obligatorio y NO tiene valor por defecto: ausente o vacío no arranca; nunca se asume sandbox ni live', () => {
    expect(() => loadSettlementConfig(base({ PAY_MODE: undefined }))).toThrow(/PAY_MODE.*sandbox \| live.*no tiene valor por defecto/);
    expect(() => loadSettlementConfig(base({ PAY_MODE: '' }))).toThrow(/PAY_MODE.*no tiene valor por defecto/);
    expect(loadSettlementConfig(base({ PAY_MODE: 'sandbox' })).payMode).toBe('sandbox');
  });

  it.each(['LEDGER_URL', 'CONNECTORS_URL', 'OPERATOR_TOKEN_PUBLIC_KEY', 'OPERATOR_TOKEN_ISSUER', 'OPERATOR_TOKEN_AUDIENCE'])('falta %s ⇒ no arranca y dice cuál', (name) => {
    expect(() => loadSettlementConfig(base({ [name]: undefined }))).toThrow(name);
    expect(() => loadSettlementConfig(base({ [name]: '' }))).toThrow(name);
  });

  it.each([
    ['LEDGER_URL', 'pay-ledger:3000'],
    ['LEDGER_URL', 'ftp://pay-ledger'],
    ['CONNECTORS_URL', 'no es una url'],
    ['SETTLEMENT_MODE', 'cualquiera'],
    ['PAY_MODE', 'staging'],
    ['SETTLEMENT_CUTOFF_WEEKDAY', '7'],
    ['SETTLEMENT_CUTOFF_WEEKDAY', 'lunes'],
    ['SETTLEMENT_TZ_OFFSET_MINUTES', '9999'],
    ['SETTLEMENT_RELEASE_DAYS', '61'],
    ['SETTLEMENT_RELEASE_DAYS', '-1'],
    ['SETTLEMENT_PAYOUT_HOLD_TTL_SECONDS', '10'],
    ['SETTLEMENT_PAYOUT_HOLD_TTL_SECONDS', '3000000'],
    ['SETTLEMENT_HTTP_TIMEOUT_MS', '10'],
    ['SETTLEMENT_SWEEP_INTERVAL_MS', '-5'],
    ['SETTLEMENT_TRANSFER_CONNECTOR', 'visa'],
    ['SETTLEMENT_STATEMENT_FORMATS', 'mock:xlsx'],
    ['SETTLEMENT_STATEMENT_FORMATS', 'sin-formato'],
  ])('%s=%p ⇒ no arranca', (name, value) => {
    expect(() => loadSettlementConfig(base({ [name]: value }))).toThrow(name === 'LEDGER_URL' || name === 'CONNECTORS_URL' ? name : /./);
  });

  it('settlement.mode=acquirer es un doble: arranca en sandbox y NUNCA con PAY_MODE=live (marcaría como pagado lo que no salió)', () => {
    expect(loadSettlementConfig(base({ SETTLEMENT_MODE: 'acquirer' })).mode).toBe('acquirer');
    expect(() => loadSettlementConfig(base({ SETTLEMENT_MODE: 'acquirer', PAY_MODE: 'live' }))).toThrow(/acquirer.*live/);
    expect(loadSettlementConfig(base({ SETTLEMENT_MODE: 'bank', PAY_MODE: 'live' }))).toMatchObject({ mode: 'bank', payMode: 'live', transferConnector: 'bank_transfer' });
  });

  it('el conector de pruebas `mock` no puede mover dinero en producción', () => {
    expect(() => loadSettlementConfig(base({ PAY_MODE: 'live', SETTLEMENT_TRANSFER_CONNECTOR: 'mock' }))).toThrow(/mock.*live/);
    expect(loadSettlementConfig(base({ PAY_MODE: 'live', SETTLEMENT_TRANSFER_CONNECTOR: 'mercantil_qr' })).transferConnector).toBe('mercantil_qr');
  });

  it('día de corte: 0–6 o `any`; formatos de extracto por conector', () => {
    expect(loadSettlementConfig(base({ SETTLEMENT_CUTOFF_WEEKDAY: '0' })).cutoffWeekday).toBe(0);
    expect(loadSettlementConfig(base({ SETTLEMENT_CUTOFF_WEEKDAY: '6' })).cutoffWeekday).toBe(6);
    expect(loadSettlementConfig(base({ SETTLEMENT_CUTOFF_WEEKDAY: 'any' })).cutoffWeekday).toBeNull();
    expect(loadSettlementConfig(base({ SETTLEMENT_STATEMENT_FORMATS: 'mercantil_qr:camt053, bank_transfer:csv' })).statementFormats).toEqual({ mercantil_qr: 'camt053', bank_transfer: 'csv' });
  });
});
