import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { loadContract, type ContractValidator } from '@pay/testing';

/**
 * [DOBLE] de pay-ledger (`contracts/openapi/internal-ledger-v1.yaml`). NO es el libro mayor: es un servidor HTTP en memoria que
 * cumple lo que el contrato promete a quien lo llama y que se puede FUNDAR y ROMPER a pedido para ejercitar los tres niveles
 * (correcto, límite, inválido). Cada petición que recibe y cada respuesta que da se validan contra el contrato; las
 * violaciones quedan en `violations` y las pruebas exigen que esté vacío.
 *
 * Fiel a lo contratado: idempotencia por `business_ref` + `attempt` (repetir = `exists`; contenido distinto = 422
 * `idempotency_key_reused`), un `attempt` nuevo solo tras un rechazo (409 si ya hay uno aceptado), saldos que no pueden quedar en
 * negativo (422 `insufficient_funds`), retenciones que se resuelven una sola vez, saldo separado por modo (D-28).
 * Extensión PROPUESTA (PR-09): la respuesta de `POST /transactions` trae `transfer_ids` (`tf_…`).
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const rand = (prefix: string): string => {
  let body = '';
  for (const byte of randomBytes(16)) body += ALPHABET[byte % 32];
  return `${prefix}_${body}`;
};

interface Hold {
  id: string;
  mode: string;
  business_ref: string;
  attempt: number;
  status: 'pending' | 'posted' | 'voided' | 'expired';
  debit_account: string;
  credit_account: string;
  amount_minor: number;
  expires_at: string;
  created_at: string;
  postKey?: string;
}

interface Attempt {
  kind: 'hold' | 'tx';
  attempt: number;
  fingerprint: string;
  rejected: boolean;
  response: Record<string, unknown>;
}

export type Fault =
  | { when: (req: Recorded) => boolean; kind: 'drop-before' } // corta la conexión SIN aplicar nada
  | { when: (req: Recorded) => boolean; kind: 'drop-after' } // aplica el efecto y corta la conexión sin responder
  | { when: (req: Recorded) => boolean; kind: 'status'; status: number; body?: unknown; applied: boolean }; // responde un error (aplicando o no el efecto)

/** Cuerpo JSON recibido (el tipo de `JSON.parse`, a propósito). */
type Body = ReturnType<typeof JSON.parse>;

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: Body;
}

export interface LedgerDouble {
  url: string;
  calls: Recorded[];
  violations: string[];
  /** Saldo disponible por modo y cuenta. */
  fund(mode: string, account: string, amountMinor: number): void;
  balanceOf(mode: string, account: string): number;
  holds(): Hold[];
  /** Fallas a pedido; cada una se usa UNA vez, en orden. */
  faults: Fault[];
  /** Si es `false`, `POST /transactions` no devuelve `transfer_ids` (como el libro mayor real hoy). */
  includeTransferIds: boolean;
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' });
  res.end(JSON.stringify(body));
};
const problem = (res: ServerResponse, status: number, code: string): void => json(res, status, { type: `urn:alovida:pay:problem:${code}`, title: code, status, code });

export async function startLedgerDouble(contractPath: string): Promise<LedgerDouble> {
  const contract: ContractValidator = await loadContract(contractPath);
  const balances = new Map<string, number>();
  const pending = new Map<string, number>();
  const holds = new Map<string, Hold>();
  const attempts = new Map<string, Attempt[]>();
  const double: LedgerDouble = {
    url: '',
    calls: [],
    violations: [],
    faults: [],
    includeTransferIds: true,
    fund: (mode, account, amount) => balances.set(`${mode}|${account}`, (balances.get(`${mode}|${account}`) ?? 0) + amount),
    balanceOf: (mode, account) => balances.get(`${mode}|${account}`) ?? 0,
    holds: () => [...holds.values()],
    close: async () => undefined,
  };
  const available = (mode: string, account: string): number => (balances.get(`${mode}|${account}`) ?? 0) - (pending.get(`${mode}|${account}`) ?? 0);
  const mustNotGoNegative = (account: string): boolean => /^(merchant:[^:]+:available|user:[^:]+:wallet|schedule:[^:]+:reserve)$/.test(account);

  const send = (req: Recorded, res: ServerResponse, status: number, body: unknown): void => {
    const path = req.path;
    const errors = contract.validateResponse({ method: req.method.toLowerCase(), path, status, body });
    if (errors.length > 0) double.violations.push(`respuesta ${req.method} ${path} ${status}: ${errors.join('; ')}`);
    json(res, status, body);
  };

  function handle(req: Recorded, res: ServerResponse): void {
    const mode = req.headers['x-pay-mode'] ?? 'test';
    if (req.headers['x-service-id'] !== 'pay-schedules') return problem(res, 403, 'forbidden');
    // Validación de la petición contra el contrato.
    if (req.method === 'POST' && req.body !== undefined && req.body !== null) {
      const errors = contract.validateRequest({ method: 'post', path: req.path, body: req.body });
      if (errors.length > 0) double.violations.push(`petición POST ${req.path}: ${errors.join('; ')}`);
    }
    if ((req.path === '/holds' || req.path === '/transactions') && !req.headers['idempotency-key']) double.violations.push(`petición POST ${req.path} sin Idempotency-Key`);
    if (/^\/holds\/[^/]+\/post$/.test(req.path) && !req.headers['idempotency-key']) double.violations.push(`petición POST ${req.path} sin Idempotency-Key`);

    if (req.method === 'POST' && req.path === '/holds') {
      const b = req.body;
      const key = `${mode}|${b.business_ref}`;
      const list = attempts.get(key) ?? [];
      const fingerprint = JSON.stringify([b.debit_account, b.credit_account, b.amount_minor, b.currency]);
      const same = list.find((a) => a.kind === 'hold' && a.attempt === b.attempt);
      if (same) {
        if (same.fingerprint !== fingerprint) return problem(res, 422, 'idempotency_key_reused');
        if (same.rejected) return problem(res, 422, 'insufficient_funds');
        const hold = holds.get(same.response.id as string) as Hold;
        return send(req, res, 200, holdView(hold, 'exists'));
      }
      if (list.some((a) => !a.rejected)) return problem(res, 409, 'invalid_state_transition');
      const last = list.length === 0 ? 0 : Math.max(...list.map((a) => a.attempt));
      if (b.attempt !== last + 1) return problem(res, 409, 'invalid_state_transition');
      if (mustNotGoNegative(b.debit_account) && available(mode, b.debit_account) < b.amount_minor) {
        list.push({ kind: 'hold', attempt: b.attempt, fingerprint, rejected: true, response: {} });
        attempts.set(key, list);
        return problem(res, 422, 'insufficient_funds');
      }
      const hold: Hold = {
        id: rand('hd'), mode, business_ref: b.business_ref, attempt: b.attempt, status: 'pending', debit_account: b.debit_account, credit_account: b.credit_account,
        amount_minor: b.amount_minor, expires_at: new Date(Date.now() + b.expires_in_seconds * 1000).toISOString(), created_at: new Date().toISOString(),
      };
      holds.set(hold.id, hold);
      pending.set(`${mode}|${b.debit_account}`, (pending.get(`${mode}|${b.debit_account}`) ?? 0) + b.amount_minor);
      list.push({ kind: 'hold', attempt: b.attempt, fingerprint, rejected: false, response: { id: hold.id } });
      attempts.set(key, list);
      return send(req, res, 201, holdView(hold, 'created'));
    }

    const holdMatch = /^\/holds\/(hd_[a-z0-9]+)(\/post)?$/.exec(req.path);
    if (holdMatch) {
      const hold = holds.get(holdMatch[1]);
      if (!hold || hold.mode !== mode) return problem(res, 404, 'resource_not_found');
      if (req.method === 'GET' && !holdMatch[2]) return send(req, res, 200, holdView(hold, 'exists'));
      if (req.method === 'POST' && holdMatch[2]) {
        if (hold.status === 'posted' && hold.postKey === req.headers['idempotency-key']) return send(req, res, 200, holdView(hold, 'exists'));
        if (hold.status !== 'pending') return problem(res, 409, 'invalid_state_transition');
        hold.status = 'posted';
        hold.postKey = req.headers['idempotency-key'];
        pending.set(`${mode}|${hold.debit_account}`, (pending.get(`${mode}|${hold.debit_account}`) ?? 0) - hold.amount_minor);
        balances.set(`${mode}|${hold.debit_account}`, (balances.get(`${mode}|${hold.debit_account}`) ?? 0) - hold.amount_minor);
        balances.set(`${mode}|${hold.credit_account}`, (balances.get(`${mode}|${hold.credit_account}`) ?? 0) + hold.amount_minor);
        return send(req, res, 200, holdView(hold, 'exists'));
      }
    }

    if (req.method === 'POST' && req.path === '/transactions') {
      const b = req.body;
      const key = `${mode}|${b.business_ref}`;
      const list = attempts.get(key) ?? [];
      const fingerprint = JSON.stringify(b.legs);
      const same = list.find((a) => a.kind === 'tx' && a.attempt === b.attempt);
      if (same) {
        if (same.fingerprint !== fingerprint) return problem(res, 422, 'idempotency_key_reused');
        if (same.rejected) return problem(res, 422, 'insufficient_funds');
        return send(req, res, 200, { ...same.response, result: 'exists' });
      }
      if (list.some((a) => !a.rejected)) return problem(res, 409, 'invalid_state_transition');
      const last = list.length === 0 ? 0 : Math.max(...list.map((a) => a.attempt));
      if (b.attempt !== last + 1) return problem(res, 409, 'invalid_state_transition');
      for (const leg of b.legs) {
        if (mustNotGoNegative(leg.debit_account) && available(mode, leg.debit_account) < leg.amount_minor) {
          list.push({ kind: 'tx', attempt: b.attempt, fingerprint, rejected: true, response: {} });
          attempts.set(key, list);
          return problem(res, 422, 'insufficient_funds');
        }
      }
      for (const leg of b.legs) {
        balances.set(`${mode}|${leg.debit_account}`, (balances.get(`${mode}|${leg.debit_account}`) ?? 0) - leg.amount_minor);
        balances.set(`${mode}|${leg.credit_account}`, (balances.get(`${mode}|${leg.credit_account}`) ?? 0) + leg.amount_minor);
      }
      const response = {
        id: rand('tx'), object: 'transaction', result: 'created', business_ref: b.business_ref, attempt: b.attempt, status: 'posted', reject_code: null, currency: b.currency, legs: b.legs,
        created_at: new Date().toISOString(),
        ...(double.includeTransferIds && { transfer_ids: b.legs.map(() => rand('tf')) }),
      };
      list.push({ kind: 'tx', attempt: b.attempt, fingerprint, rejected: false, response });
      attempts.set(key, list);
      return send(req, res, 201, response);
    }

    return problem(res, 404, 'resource_not_found');
  }

  const holdView = (hold: Hold, result: 'created' | 'exists') => ({
    id: hold.id, object: 'hold', result, business_ref: hold.business_ref, attempt: hold.attempt, status: hold.status, debit_account: hold.debit_account, credit_account: hold.credit_account,
    amount_minor: hold.amount_minor, posted_amount_minor: hold.status === 'posted' ? hold.amount_minor : null, currency: 'BOB', expires_at: hold.expires_at, created_at: hold.created_at,
    resolved_at: hold.status === 'pending' ? null : new Date().toISOString(),
  });

  const server = createServer((rawReq, res) => {
    const chunks: Buffer[] = [];
    rawReq.on('data', (c: Buffer) => chunks.push(c));
    rawReq.on('end', () => {
      const url = new URL(rawReq.url ?? '/', 'http://localhost');
      let body: unknown;
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      } catch {
        body = undefined;
      }
      const recorded: Recorded = {
        method: rawReq.method ?? 'GET',
        path: url.pathname,
        headers: Object.fromEntries(Object.entries(rawReq.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])),
        body,
      };
      double.calls.push(recorded);
      const index = double.faults.findIndex((f) => f.when(recorded));
      const fault = index >= 0 ? double.faults.splice(index, 1)[0] : undefined;
      const process = (): void => {
        // `GET /balances?account=…` se resuelve acá porque necesita la query.
        if (recorded.method === 'GET' && recorded.path === '/balances') {
          const account = url.searchParams.get('account') ?? '';
          const mode = recorded.headers['x-pay-mode'] ?? 'test';
          return send(recorded, res, 200, {
            object: 'balance', account, currency: 'BOB', balance_minor: Math.max(0, available(mode, account)), pending_debits_minor: pending.get(`${mode}|${account}`) ?? 0,
            pending_credits_minor: 0, nature: 'credit', as_of: new Date().toISOString(),
          });
        }
        handle(recorded, res);
      };
      if (!fault) return process();
      if (fault.kind === 'drop-before') return void rawReq.socket.destroy();
      if (fault.kind === 'drop-after') {
        // Aplica el efecto contra una respuesta descartable y corta la conexión real.
        applyDiscardingResponse(recorded);
        return void rawReq.socket.destroy();
      }
      if (!fault.applied) return json(res, fault.status, fault.body ?? { error: 'falla simulada' });
      applyDiscardingResponse(recorded);
      return json(res, fault.status, fault.body ?? { error: 'falla simulada' });
    });
  });

  function applyDiscardingResponse(recorded: Recorded): void {
    if (recorded.method === 'GET') return;
    handle(recorded, { writeHead: () => undefined, end: () => undefined } as unknown as ServerResponse);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  double.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  double.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return double;
}
