import { callbackResultOf, decideCallback, type Decision } from './callback-machine';
import type { ProviderStatus } from './connector';
import { ConnectorRegistry } from './registry';
import { DEFAULT_RULE_SET, parseRuleSet, selectCandidates, type Availability } from './routing';
import { EnvSecretProvider, namespaceOf, ScopedSecretProvider } from './secrets';
import { csvCell, toCamt053, toCsv } from './statement-formats';
import { chargeStatusOf, eventFailureCode, transferFailureCode } from './status-map';
import { evaluateCallbackEndpoint } from './endpoint-policy';
import { newId, newTransferReference } from '../ids';
import { loadConfig } from '../config';
import { MockConnector } from '../connectors/mock/mock.connector';
import { SimulatedBank } from '../connectors/mock/simulated-bank';

const STATES: ProviderStatus[] = ['pending', 'authorized', 'captured', 'failed', 'canceled', 'expired'];

describe('callback-machine: matriz completa de transiciones', () => {
  const E: Record<string, Decision> = {};
  // mismo estado ⇒ duplicado
  for (const s of STATES) E[`${s}>${s}`] = 'duplicado';
  // avances legítimos
  for (const to of ['authorized', 'captured', 'failed', 'canceled', 'expired']) E[`pending>${to}`] = 'aplicar';
  for (const to of ['captured', 'failed', 'canceled', 'expired']) E[`authorized>${to}`] = 'aplicar';
  // hecho anterior ya superado
  E['authorized>pending'] = 'obsoleto';
  E['captured>pending'] = 'obsoleto';
  E['captured>authorized'] = 'obsoleto';
  // todo lo demás es incompatible con un estado terminal
  for (const from of STATES) for (const to of STATES) E[`${from}>${to}`] ??= 'contradiccion';

  it.each(Object.entries(E))('%s ⇒ %s', (pair, expected) => {
    const [from, to] = pair.split('>') as [ProviderStatus, ProviderStatus];
    expect(decideCallback(from, to)).toBe(expected);
  });

  it('cubre las 36 combinaciones', () => {
    expect(Object.keys(E)).toHaveLength(36);
  });

  it('el resultado público es el del contrato', () => {
    expect(callbackResultOf('aplicar')).toBe('applied');
    expect(callbackResultOf('duplicado')).toBe('duplicate');
    expect(callbackResultOf('obsoleto')).toBe('stale');
    expect(callbackResultOf('contradiccion')).toBe('contradiction');
  });
});

describe('status-map', () => {
  it('estado público a partir del del proveedor', () => {
    expect(chargeStatusOf('pending', true)).toBe('requires_action');
    expect(chargeStatusOf('pending', false)).toBe('pending');
    expect(chargeStatusOf('authorized', true)).toBe('pending');
    expect(chargeStatusOf('captured', true)).toBe('succeeded');
    expect(chargeStatusOf('failed', false)).toBe('failed');
    expect(chargeStatusOf('canceled', false)).toBe('canceled');
    expect(chargeStatusOf('expired', false)).toBe('expired');
  });

  it('el código de fallo de los eventos de transacción admite los cuatro del catálogo; lo demás sale como `validation_failed`', () => {
    expect(eventFailureCode(null)).toBeNull();
    expect(eventFailureCode(undefined)).toBeNull();
    expect(eventFailureCode('card_declined')).toBe('card_declined');
    expect(eventFailureCode('rechazado_por_otra_razon')).toBe('validation_failed');
    expect(eventFailureCode('connector_unavailable')).toBe('connector_unavailable');
    expect(eventFailureCode('internal_error')).toBe('internal_error');
  });
});

describe('transferFailureCode', () => {
  it('los cuatro del contrato pasan; cualquier otro sale como `rejected_by_provider` (nunca nulo: `failed` prueba que NO se pagó)', () => {
    for (const code of ['rejected_by_bank', 'rejected_by_provider', 'connector_unavailable', 'validation_failed']) expect(transferFailureCode(code)).toBe(code);
    for (const code of ['internal_error', 'invalid_state_transition', null, undefined, '']) expect(transferFailureCode(code)).toBe('rejected_by_provider');
  });
});

describe('endpoint-policy (fail-closed)', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  const base = { callbackPath: '/callbacks/mock', active: true };

  it('sin endpoints registrados no hay nada que aplicar', () => {
    expect(evaluateCallbackEndpoint([], { callbackPath: '/callbacks/mock', now })).toEqual({ allowed: true, enforced: false });
  });

  it.each([
    ['ruta no registrada', [{ ...base, callbackPath: '/callbacks/otro' }], { callbackPath: '/callbacks/mock' }, 'endpoint_not_allowed'],
    ['endpoint inactivo', [{ ...base, active: false }], {}, 'endpoint_not_allowed'],
    ['IP fuera de la red', [{ ...base, allowedSourceCidrs: ['10.0.0.0/8'] }], { sourceIp: '192.168.1.1' }, 'source_not_allowed'],
    ['sin IP de origen', [{ ...base, allowedSourceCidrs: ['10.0.0.0/8'] }], {}, 'source_not_allowed'],
    ['CIDR con prefijo imposible', [{ ...base, allowedSourceCidrs: ['10.0.0.0/33'] }], { sourceIp: '10.0.0.1' }, 'source_not_allowed'],
    ['una entrada que no es red invalida la lista', [{ ...base, allowedSourceCidrs: ['10.0.0.0/8', 'basura'] }], { sourceIp: '10.0.0.1' }, 'source_not_allowed'],
    ['lista con un valor que no es texto', [{ ...base, allowedSourceCidrs: [42] }], { sourceIp: '10.0.0.1' }, 'source_not_allowed'],
    ['timestamp fuera de la ventana', [{ ...base, replayWindowSeconds: 60 }], { timestamp: String(Math.floor(now.getTime() / 1000) - 61) }, 'outside_replay_window'],
    ['ventana declarada y sin timestamp', [{ ...base, replayWindowSeconds: 60 }], {}, 'outside_replay_window'],
    ['timestamp no numérico', [{ ...base, replayWindowSeconds: 60 }], { timestamp: 'ayer' }, 'outside_replay_window'],
  ])('%s ⇒ rechazado', (_name, endpoints, context, reason) => {
    expect(evaluateCallbackEndpoint(endpoints, { callbackPath: '/callbacks/mock', now, ...context })).toEqual({ allowed: false, reason });
  });

  it.each([
    ['IPv4 dentro del CIDR', '10.1.2.3'],
    ['IPv4 mapeada en IPv6 (socket dual-stack)', '::ffff:10.1.2.3'],
  ])('%s ⇒ permitido', (_name, sourceIp) => {
    expect(evaluateCallbackEndpoint([{ ...base, allowedSourceCidrs: ['10.0.0.0/8'] }], { callbackPath: '/callbacks/mock', sourceIp, now })).toEqual({ allowed: true, enforced: true });
  });

  it('límites de la ventana: justo dentro pasa', () => {
    const timestamp = String(Math.floor(now.getTime() / 1000) - 60);
    expect(evaluateCallbackEndpoint([{ ...base, replayWindowSeconds: 60 }], { callbackPath: '/callbacks/mock', timestamp, now })).toEqual({ allowed: true, enforced: true });
  });
});

describe('ruteo', () => {
  const available = (down: string[] = [], registered = ['mercantil_qr', 'mock', 'bank_transfer', 'mercantil_card']) =>
    (code: string): Availability => ({ registered: registered.includes(code), down: down.includes(code), methods: code === 'bank_transfer' ? ['bank_transfer'] : ['qr', 'card', 'bank_transfer'] });

  it('la primera regla que coincide fija el orden; se saltan los caídos y los no registrados', () => {
    const request = { method: 'qr' as const, amountMinor: 100n };
    expect(selectCandidates(DEFAULT_RULE_SET, request, available()).candidates).toEqual(['mercantil_qr', 'mock']);
    expect(selectCandidates(DEFAULT_RULE_SET, request, available(['mercantil_qr'])).candidates).toEqual(['mock']);
    expect(selectCandidates(DEFAULT_RULE_SET, request, available([], ['mock'])).candidates).toEqual(['mock']);
    expect(selectCandidates(DEFAULT_RULE_SET, request, available(['mercantil_qr', 'mock'])).candidates).toEqual([]);
  });

  it('un conector que no soporta el medio no es candidato', () => {
    expect(selectCandidates({ version: 1, rules: [{ id: 'x', when: {}, route: ['bank_transfer', 'mock'] }] }, { method: 'qr', amountMinor: 1n }, available()).candidates).toEqual(['mock']);
  });

  it('límites de monto: min y max son inclusivos', () => {
    const set = { version: 3, rules: [{ id: 'mid', when: { amount_min_minor: 100, amount_max_minor: 200 }, route: ['mock' as const] }] };
    const pick = (amountMinor: bigint) => selectCandidates(set, { method: 'qr', amountMinor }, available());
    expect(pick(99n).ruleId).toBeNull();
    expect(pick(100n)).toMatchObject({ ruleId: 'mid', version: 3, candidates: ['mock'] });
    expect(pick(200n).ruleId).toBe('mid');
    expect(pick(201n)).toMatchObject({ ruleId: null, candidates: [] });
  });

  it('`preferred` reordena solo dentro de lo que la regla permite', () => {
    const request = { method: 'qr' as const, amountMinor: 1n };
    expect(selectCandidates(DEFAULT_RULE_SET, { ...request, preferred: 'mock' }, available()).candidates).toEqual(['mock', 'mercantil_qr']);
    expect(selectCandidates(DEFAULT_RULE_SET, { ...request, preferred: 'bank_transfer' }, available()).candidates).toEqual(['mercantil_qr', 'mock']);
  });

  it('parseRuleSet acepta las reglas por defecto y rechaza lo mal formado', () => {
    expect(parseRuleSet(JSON.parse(JSON.stringify(DEFAULT_RULE_SET)))).toEqual(DEFAULT_RULE_SET);
    const bad: unknown[] = [
      null,
      { version: 0, rules: [] },
      { version: 1 },
      { version: 1, rules: [], extra: 1 },
      { version: 1, rules: [{ id: 'a', when: {}, route: [] }] },
      { version: 1, rules: [{ id: 'a', when: {}, route: ['paypal'] }] },
      { version: 1, rules: [{ id: 'a', when: { method: 'cash' }, route: ['mock'] }] },
      { version: 1, rules: [{ id: 'a', when: { color: 'rojo' }, route: ['mock'] }] },
      { version: 1, rules: [{ id: 'a', when: { amount_min_minor: -1 }, route: ['mock'] }] },
      { version: 1, rules: [{ id: 'a', when: {}, route: ['mock'] }, { id: 'a', when: {}, route: ['mock'] }] },
      { version: 1, rules: [{ id: 'a', when: {}, route: ['mock'], surprise: 1 }] },
    ];
    for (const input of bad) expect(() => parseRuleSet(input)).toThrow(/Reglas de ruteo inválidas/);
  });
});

describe('secretos (P4.H2.M6)', () => {
  it('lee PAY_SECRET_<NOMBRE> del entorno; una lista permite rotar; sin valor ⇒ []', async () => {
    const secrets = new EnvSecretProvider({ PAY_SECRET_CONNECTOR_MOCK_K: ' a , b ,', PAY_SECRET_CONNECTOR_MOCK_EMPTY: '' });
    expect(await secrets.getSecrets('CONNECTOR_MOCK_K')).toEqual(['a', 'b']);
    expect(await secrets.getSecrets('CONNECTOR_MOCK_EMPTY')).toEqual([]);
    expect(await secrets.getSecrets('CONNECTOR_MOCK_NADA')).toEqual([]);
  });

  it('un nombre fuera del espacio CONNECTOR_… no se resuelve (no se leen variables arbitrarias)', async () => {
    const secrets = new EnvSecretProvider({ PAY_SECRET_DB_PASSWORD: 'x', PATH: '/bin' });
    for (const name of ['DB_PASSWORD', 'PATH', '../CONNECTOR_X', 'connector_mock_k', '']) expect(await secrets.getSecrets(name)).toEqual([]);
  });

  it('cada conector solo ve su espacio de nombres', async () => {
    const all = new EnvSecretProvider({ PAY_SECRET_CONNECTOR_MOCK_K: 'mio', PAY_SECRET_CONNECTOR_MERCANTIL_QR_K: 'ajeno' });
    const scoped = new ScopedSecretProvider(all, namespaceOf('mock'));
    expect(await scoped.getSecrets('CONNECTOR_MOCK_K')).toEqual(['mio']);
    expect(await scoped.getSecrets('CONNECTOR_MERCANTIL_QR_K')).toEqual([]);
    expect(namespaceOf('mercantil_qr')).toBe('CONNECTOR_MERCANTIL_QR_');
  });
});

describe('registro y guardia de modo (D-26)', () => {
  const sandboxConnector = () => new MockConnector({ bank: new SimulatedBank(), secrets: new EnvSecretProvider({}), qr: { issue: async () => ({ payload: '', expiresAt: new Date() }) } });

  it('sandbox: carga el simulador; cargarlo dos veces falla', () => {
    const registry = new ConnectorRegistry('sandbox').register(sandboxConnector());
    expect(registry.has('mock')).toBe(true);
    expect(registry.list().map((c) => c.code)).toEqual(['mock']);
    expect(() => registry.register(sandboxConnector())).toThrow(/ya está registrado/);
  });

  it('live: el simulador NO se carga y el arranque falla', () => {
    expect(() => new ConnectorRegistry('live').register(sandboxConnector())).toThrow(/PAY_MODE=live/);
  });

  it('un conector de producción no se carga en sandbox', () => {
    const live = { ...sandboxConnector(), code: 'mercantil_qr', mode: 'live' } as unknown as Parameters<ConnectorRegistry['register']>[0];
    expect(() => new ConnectorRegistry('sandbox').register(live)).toThrow(/PAY_MODE=sandbox/);
  });

  it('PAY_MODE es obligatorio y solo admite sandbox o live', () => {
    const env = { DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p' };
    expect(() => loadConfig({ ...env })).toThrow(/PAY_MODE/);
    expect(() => loadConfig({ ...env, PAY_MODE: 'Live' })).toThrow(/PAY_MODE/);
    expect(() => loadConfig({ ...env, PAY_MODE: 'produccion' })).toThrow(/PAY_MODE/);
    // Bajo live el proveedor de secretos es explícito (P4.H2.M6): ver la prueba «SECRET_PROVIDER» más abajo.
    const openbao = { SECRET_PROVIDER: 'openbao', OPENBAO_ADDR: 'https://openbao.invalid:8200', OPENBAO_TOKEN: 'tok-sintetico-de-prueba' };
    expect(loadConfig({ ...env, PAY_MODE: 'live', ...openbao }).mode).toBe('live');
    expect(loadConfig({ ...env, PAY_MODE: 'sandbox' }).mode).toBe('sandbox');
  });

  it('configuración numérica inválida falla al arrancar', () => {
    const env = { DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p', PAY_MODE: 'sandbox' };
    expect(() => loadConfig({ ...env, POLLER_BATCH_SIZE: '0' })).toThrow(/POLLER_BATCH_SIZE/);
    expect(() => loadConfig({ ...env, HEALTH_DOWN_AFTER_FAILURES: 'x' })).toThrow(/HEALTH_DOWN_AFTER_FAILURES/);
    expect(() => loadConfig({ ...env, TIMEOUT_RETRIES: '-1' })).toThrow(/TIMEOUT_RETRIES/);
  });
});

describe('formatos de extracto', () => {
  const line = { providerReference: 'BNK-1', ourReference: 'ch_aaaaaaaaaaaaaaaa', direction: 'credit' as const, amountMinor: 12345n, currency: 'BOB' as const, valueDate: '2026-10-27', bookedAt: new Date('2026-10-27T10:00:00Z'), description: null };

  it('CSV: RFC 4180 con CRLF y protección contra inyección de fórmulas', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('di "hola"')).toBe('"di ""hola"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(0)).toBe('0');
    const csv = toCsv([{ ...line, providerReference: '=cmd|calc' }]);
    expect(csv.split('\r\n')[1]).toContain("'=cmd|calc");
    expect(toCsv([])).toBe('provider_reference,our_reference,charge_id,direction,amount_minor,currency,value_date,booked_at,description\r\n');
  });

  it('camt.053: importes con 2 decimales, signo por CRDT/DBIT y saldo de cierre = créditos − débitos', () => {
    const xml = toCamt053([line, { ...line, providerReference: 'BNK-2', direction: 'debit', amountMinor: 2345n }], { connector: 'mock', accountId: 'ACC', from: new Date('2026-10-27T00:00:00Z'), to: new Date('2026-10-28T00:00:00Z'), generatedAt: new Date('2026-10-28T00:00:01Z') });
    expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:camt.053.001.02');
    expect(xml).toContain('>123.45<');
    expect(xml).toContain('>23.45<');
    expect(xml).toContain('CRDT');
    expect(xml).toContain('DBIT');
    expect(xml).toMatch(/<Cd>CLBD<\/Cd>[\s\S]*?>100\.00</);
  });
});

describe('ids', () => {
  it('forma estable y sin repetidos', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId('ch')));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^ch_[a-z2-7]{16}$/);
    const refs = new Set(Array.from({ length: 2000 }, () => newTransferReference()));
    expect(refs.size).toBe(2000);
    for (const r of refs) expect(r).toMatch(/^TR[A-Z2-7]{10}$/);
  });
});

describe('safeUrl (logs sin datos del cliente en la ruta)', () => {
  const load = async () => (await import('../log-safe')).safeUrl;

  it.each([
    ['/charges', '/charges'],
    ['/charges/ch_abcdefghijklmnop/status?refresh=true', '/charges/ch_abcdefghijklmnop/status'],
    ['/callbacks/mock', '/callbacks/mock'],
    ['/health/live', '/health/live'],
    ['/callbacks/4111111111111111', '/callbacks/:x'],
    ['/callbacks/Juan%20Perez', '/callbacks/:x'],
    ['/callbacks/x4111111111111111', '/callbacks/:x'],
    ['/charges/TRABCDEFGHIJ', '/charges/:x'],
    ['/a/b?card=4111111111111111', '/a/b'],
    ['/', '/'],
    ['', ''],
  ])('%s ⇒ %s', async (input, expected) => {
    expect((await load())(input)).toBe(expected);
  });
});
