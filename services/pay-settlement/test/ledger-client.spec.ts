import { loadContract, type ContractValidator } from '@pay/testing';
import { LedgerRejectedError, LedgerUnavailableError } from '../src/settlement/errors';
import { HttpLedgerClient } from '../src/settlement/http-clients';
import { repoPath } from './helpers/app';
import { type Behavior, ConnectorsServer, problem } from './helpers/connectors-server';

// El «servidor de conectores» es un servidor HTTP genérico validado contra un contrato; acá se usa con el contrato del ledger.
let contract: ContractValidator;
let server: ConnectorsServer;
let client: HttpLedgerClient;
const template = (path: string) =>
  path
    .replace(/^\/holds\/[^/]+\/(post|void)$/, '/holds/{id}/$1')
    .replace(/^\/holds\/[^/]+$/, '/holds/{id}')
    .replace(/^\/transactions\/.+$/, '/transactions/{business_ref}');

beforeAll(async () => {
  contract = await loadContract(repoPath('contracts/openapi/internal-ledger-v1.yaml'));
});
beforeEach(async () => {
  server = new ConnectorsServer(contract, template);
  await server.start();
  client = new HttpLedgerClient(server.url, 300);
});
afterEach(async () => {
  const violations = server.violations;
  await server.stop();
  expect(violations).toEqual([]);
});

const hold = (status: 'pending' | 'posted' | 'voided' | 'expired', extra: object = {}): Behavior => ({
  kind: 'contract',
  status: 200,
  body: {
    id: 'hd_abcdefghijklmnop',
    object: 'hold',
    result: 'exists',
    business_ref: 'po_abcdefghijklmnop:payout',
    attempt: 1,
    status,
    debit_account: 'merchant:mc_abcdefghijk:available',
    credit_account: 'payout:clearing',
    amount_minor: 9000,
    posted_amount_minor: status === 'posted' ? 9000 : null,
    currency: 'BOB',
    expires_at: '2026-11-03T10:00:00.000Z',
    created_at: '2026-10-27T10:00:00.000Z',
    resolved_at: status === 'pending' ? null : '2026-10-27T11:00:00.000Z',
    ...extra,
  },
});

const holdInput = { businessRef: 'po_abcdefghijklmnop:payout', attempt: 1, debitAccount: 'merchant:mc_abcdefghijk:available', creditAccount: 'payout:clearing', amountMinor: 9000, expiresInSeconds: 600 };

describe('HttpLedgerClient contra el contrato del ledger', () => {
  it('correcto: crea, consulta, confirma y anula retenciones; lo que envía cumple el contrato', async () => {
    server.on('POST /holds', { ...(hold('pending') as { kind: 'contract'; status: number; body: object }), status: 201 });
    expect(await client.createHold(holdInput, 'hold-1234567')).toEqual({ id: 'hd_abcdefghijklmnop', status: 'pending', amount_minor: 9000 });
    server.on('GET /holds/{id}', hold('pending'));
    expect((await client.getHold('hd_abcdefghijklmnop'))?.status).toBe('pending');
    server.on('POST /holds/{id}/post', hold('posted'));
    expect((await client.postHold('hd_abcdefghijklmnop', 'post-1234567')).status).toBe('posted');
    server.on('POST /holds/{id}/void', hold('voided'));
    expect((await client.voidHold('hd_abcdefghijklmnop', 'void-1234567')).status).toBe('voided');
    const create = server.requests.find((r) => r.path === '/holds');
    expect(contract.validateRequest({ method: 'POST', path: '/holds', body: create?.body })).toEqual([]);
    expect(create?.headers['idempotency-key']).toBe('hold-1234567');
    expect(create?.headers['x-service-id']).toBe('pay-settlement');
  });

  it('la transacción de liberación cumple el contrato y 201/200 son éxito', async () => {
    const legs = [{ debit_account: 'merchant:mc_abcdefghijk:pending', credit_account: 'merchant:mc_abcdefghijk:available', amount_minor: 100, code: 'release' as const }];
    const tx = { id: 'tx_abcdefghijkl', object: 'transaction', result: 'created', business_ref: 'rl_abcdefghijklmnop:release', attempt: 1, status: 'posted', reject_code: null, currency: 'BOB', legs, created_at: '2026-10-27T10:00:00.000Z' };
    server.on('POST /transactions', { kind: 'contract', status: 201, body: tx });
    await client.createTransaction({ businessRef: 'rl_abcdefghijklmnop:release', attempt: 1, legs }, 'release-1234567');
    server.on('POST /transactions', { kind: 'contract', status: 200, body: { ...tx, result: 'exists' } });
    await client.createTransaction({ businessRef: 'rl_abcdefghijklmnop:release', attempt: 1, legs }, 'release-1234567');
    for (const r of server.requests) expect(contract.validateRequest({ method: 'POST', path: '/transactions', body: r.body })).toEqual([]);
  });

  describe('un rechazo de negocio solo cuenta si viene del ledger (application/problem+json con su código)', () => {
    it.each([
      ['422 insufficient_funds', problem(422, 'insufficient_funds'), 'insufficient_funds'],
      ['422 validation_failed', problem(422, 'validation_failed'), 'validation_failed'],
      ['409 invalid_state_transition', problem(409, 'invalid_state_transition'), 'invalid_state_transition'],
    ])('%s ⇒ LedgerRejectedError(%s)', async (_n, behavior, code) => {
      server.on('POST /holds', behavior);
      await expect(client.createHold(holdInput, 'hold-1234567')).rejects.toEqual(expect.objectContaining({ name: 'LedgerRejectedError', code }));
    });

    it.each<[string, Behavior]>([
      ['422 con el HTML de un proxy', { kind: 'raw', status: 422, contentType: 'text/html', body: '<h1>Unprocessable</h1>' }],
      ['409 sin cuerpo', { kind: 'raw', status: 409, body: '' }],
      ['422 JSON con el código correcto pero SIN problem+json', { kind: 'raw', status: 422, contentType: 'application/json', body: '{"code":"insufficient_funds"}' }],
      ['502', { kind: 'raw', status: 502, contentType: 'text/html', body: 'Bad Gateway' }],
      ['503 problem+json', { kind: 'raw', status: 503, contentType: 'application/problem+json', body: JSON.stringify({ code: 'ledger_unavailable', status: 503 }) }],
      ['504', { kind: 'raw', status: 504, body: '' }],
      ['500', problem(500, 'internal_error')],
      ['429', { kind: 'raw', status: 429, body: '' }],
      ['403', problem(403, 'forbidden')],
      ['200 con cuerpo ilegible', { kind: 'raw', status: 200, contentType: 'application/json', body: '{"id":' }],
      ['200 con otra cosa', { kind: 'raw', status: 200, contentType: 'application/json', body: '{"ok":true}' }],
      ['corte de socket', { kind: 'cut' }],
      ['tiempo agotado', { kind: 'hang' }],
    ])('%s ⇒ LedgerUnavailableError: no se decide nada con eso (el resultado es desconocido)', async (_n, behavior) => {
      server.on('POST /holds', behavior);
      await expect(client.createHold(holdInput, 'hold-1234567')).rejects.toBeInstanceOf(LedgerUnavailableError);
      server.on('POST /holds/{id}/void', behavior);
      await expect(client.voidHold('hd_abcdefghijklmnop', 'void-1234567')).rejects.not.toBeInstanceOf(LedgerRejectedError);
      server.on('POST /holds/{id}/post', behavior);
      await expect(client.postHold('hd_abcdefghijklmnop', 'post-1234567')).rejects.not.toBeInstanceOf(LedgerRejectedError);
    });
  });

  describe('«no existe» solo lo prueba un 404 problem+json resource_not_found', () => {
    it('saldo, retención y extracto: el 404 del ledger significa «sin movimientos» / «no existe»', async () => {
      server.on('GET /balances', problem(404, 'resource_not_found'));
      expect(await client.getBalance('merchant:mc_abcdefghijk:available')).toBeUndefined();
      server.on('GET /holds/{id}', problem(404, 'resource_not_found'));
      expect(await client.getHold('hd_abcdefghijklmnop')).toBeUndefined();
      server.on('GET /statements', problem(404, 'resource_not_found'));
      expect(await client.listStatement('merchant:mc_abcdefghijk:pending', {})).toEqual([]);
    });

    it.each<[string, Behavior]>([
      ['404 de un proxy (HTML)', { kind: 'raw', status: 404, contentType: 'text/html', body: '<h1>Not Found</h1>' }],
      ['404 sin cuerpo', { kind: 'raw', status: 404, body: '' }],
      ['404 JSON sin problem+json', { kind: 'raw', status: 404, contentType: 'application/json', body: '{"code":"resource_not_found"}' }],
    ])('%s NO se lee como «saldo 0» ni «sin extracto»: es no disponible', async (_n, behavior) => {
      server.on('GET /balances', behavior);
      await expect(client.getBalance('merchant:mc_abcdefghijk:available')).rejects.toBeInstanceOf(LedgerUnavailableError);
      server.on('GET /holds/{id}', behavior);
      await expect(client.getHold('hd_abcdefghijklmnop')).rejects.toBeInstanceOf(LedgerUnavailableError);
      server.on('GET /statements', behavior);
      await expect(client.listStatement('merchant:mc_abcdefghijk:pending', {})).rejects.toBeInstanceOf(LedgerUnavailableError);
    });
  });

  it('recorre las páginas del extracto con el cursor y respeta la ventana [from, to)', async () => {
    const line = (n: number) => ({ id: `sl_abcdefghij${n.toString().padStart(2, '0')}`, business_ref: 'pi_abcdefghijkl:capture', attempt: 1, leg_index: 0, direction: 'credit', counterparty_account: 'connector:mock:clearing', amount_minor: n, code: 'charge', posted_at: '2026-10-05T10:00:00.000Z' });
    const page = (data: object[], more: boolean): Behavior => ({ kind: 'contract', status: 200, body: { object: 'list', has_more: more, next_cursor: more ? 'cursor-1' : null, data } });
    server.on('GET /statements', page([line(1), line(2)], true), page([line(3)], false));
    const entries = await client.listStatement('merchant:mc_abcdefghijk:pending', { from: '2026-10-01T00:00:00.000Z', to: '2026-10-12T04:00:00.000Z' });
    expect(entries.map((e) => e.amount_minor)).toEqual([1, 2, 3]);
    expect(server.requests[0].path).toContain('from=2026-10-01T00%3A00%3A00.000Z');
    expect(server.requests[1].path).toContain('starting_after=cursor-1');
  });

  it('saldo: lee la naturaleza y rechaza un cuerpo sin ella', async () => {
    const balance = (extra: object): Behavior => ({
      kind: 'contract',
      status: 200,
      body: { object: 'balance', account: 'merchant:mc_abcdefghijk:available', currency: 'BOB', balance_minor: 700, nature: 'credit', pending_debits_minor: 300, pending_credits_minor: 0, as_of: '2026-10-27T10:00:00.000Z', ...extra },
    });
    server.on('GET /balances', balance({}));
    expect(await client.getBalance('merchant:mc_abcdefghijk:available')).toEqual({ balance_minor: 700, nature: 'credit', pending_debits_minor: 300 });
    server.on('GET /balances', { kind: 'raw', status: 200, contentType: 'application/json', body: JSON.stringify({ balance_minor: 700 }) });
    await expect(client.getBalance('merchant:mc_abcdefghijk:available')).rejects.toBeInstanceOf(LedgerUnavailableError);
  });
});
