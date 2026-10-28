import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mintOperatorToken, onboardMerchant, SYNTHETIC_LEGAL_NAME, type OnboardingTarget, type SeededMerchant } from './seed.ts';

/**
 * SEMILLAS SINTÉTICAS DE SANDBOX (P1.H5.M2, D-26). `yarn seed:sandbox` deja la capa sandbox (platform/compose.mock.yml) con datos para probar a mano: comercios,
 * claves `sk_test_`, tarifas, billeteras con saldo y mandatos. TODO es inventado y se DECLARA así: los nombres llevan «(SINTÉTICO)», los NIT empiezan por `SBX`, los
 * asientos de apertura y los mandatos llevan la marca {@link SEED_MARK}. Nada de personas reales, nada de dinero real (el saldo sale de la cuenta de compensación del
 * conector `mock`, la misma que usa el cobro del simulador).
 *
 * IDEMPOTENTE: la segunda corrida inserta 0. Cómo se reconoce lo ya sembrado:
 *  - comercios y claves: un archivo de estado (`platform/.sandbox/seed-state.json`, modo 0600, con las claves `sk_test_`: se muestran UNA sola vez al crearlas) y se
 *    comprueba con la API que el comercio siga existiendo (si se borró la base, se vuelve a crear);
 *  - billeteras: el `business_ref` fijo del asiento de apertura (`<comercio>:sandbox_seed_opening_<ref>`) (el ledger contesta `exists` a la repetición);
 *  - mandatos: la marca en su descripción (se listan los mandatos del pagador por la API pública).
 * Usa las APIs REALES (back-office de pay-merchants con una credencial de operador SINTÉTICA, API pública del borde con la clave sembrada, ledger por su API interna)
 * y reutiliza el alta de `e2e/lib/seed.ts`. Si el estado se perdió pero el comercio existe, no se puede recuperar su clave: se informa y se pide recrear la base.
 */
export const SEED_MARK = 'SEED-SANDBOX-SINTETICO';

export interface SeedMerchantSpec {
  readonly ref: string;
  readonly label: string;
  readonly taxId: string;
  /** Saldo de apertura en unidades menores (BOB), 0 = sin billetera cargada. */
  readonly walletMinor: number;
}

/** Nombre legal: el único verificado contra el Watchman real (`flows/synthetic-names.e2e.ts`); si se cambia, correr esa prueba. */
export const SEED_LEGAL_NAME = SYNTHETIC_LEGAL_NAME;

export const SEED_MERCHANTS: readonly SeedMerchantSpec[] = [
  { ref: 'taller', label: 'SANDBOX TALLER (SINTÉTICO)', taxId: 'SBX0000TALLER1', walletMinor: 100_000 },
  { ref: 'medico', label: 'SANDBOX MÉDICO (SINTÉTICO)', taxId: 'SBX0000MEDICO1', walletMinor: 500_000 },
  { ref: 'proveedor', label: 'SANDBOX PROVEEDOR (SINTÉTICO)', taxId: 'SBX0000PROVEE1', walletMinor: 0 },
];

export interface SeedMandateSpec {
  readonly ref: string;
  readonly payer: string;
  readonly beneficiary: string;
  readonly kind: 'pay_obligation' | 'pay_commission';
  readonly amountMinor: number;
  readonly dayOfMonth: number;
}

export const SEED_MANDATES: readonly SeedMandateSpec[] = [{ ref: 'medico-a-proveedor', payer: 'medico', beneficiary: 'proveedor', kind: 'pay_obligation', amountMinor: 10_000, dayOfMonth: 5 }];

export interface SeedState {
  readonly version: 1;
  merchants: Record<string, { merchantId: string; keyId: string; token: string }>;
  wallets: Record<string, { reference: string }>;
  mandates: Record<string, { mandateId: string }>;
}

export const emptyState = (): SeedState => ({ version: 1, merchants: {}, wallets: {}, mandates: {} });

export interface SeedCounts {
  merchants: number;
  api_keys: number;
  wallets: number;
  mandates: number;
}
export interface SeedReport {
  readonly inserted: SeedCounts;
  readonly reused: SeedCounts;
}

/** Lo que la siembra necesita del mundo: se inyecta para probar la lógica de idempotencia sin servicios. */
export interface SeedDeps {
  merchantExists(merchantId: string): Promise<boolean>;
  onboard(spec: SeedMerchantSpec): Promise<SeededMerchant>;
  /** `true` si el asiento de apertura se creó ahora; `false` si ya existía (`exists`). */
  fundWallet(merchantId: string, amountMinor: number, reference: string): Promise<boolean>;
  /** Id del mandato del pagador con esa marca en su descripción, si existe. */
  findMandate(token: string, description: string): Promise<string | undefined>;
  createMandate(token: string, body: Record<string, unknown>, idempotencyKey: string): Promise<string>;
}

export const mandateDescription = (spec: SeedMandateSpec): string => `${SEED_MARK} ${spec.ref}`;
/**
 * Verbo del `business_ref` del asiento de apertura. El ledger exige `<id del comercio>:<verbo>` con el verbo en letras minúsculas y `_` (3–30 caracteres, sin dígitos ni `-` ni `:`):
 * lo descubrió la corrida contra el stack real (`flows/seed-sandbox.e2e.ts`; la versión anterior, `sandbox-seed:opening:<ref>`, el ledger la rechazaba con 422). El `business_ref` completo es
 * `${merchantId}:${walletReference(ref)}`.
 */
export const walletReference = (ref: string): string => `sandbox_seed_opening_${ref}`;

/** La siembra. Guarda el estado (`save`) después de CADA paso: si se corta, la siguiente corrida sigue donde quedó. */
export async function runSeed(deps: SeedDeps, state: SeedState, save: (state: SeedState) => void): Promise<SeedReport> {
  const inserted: SeedCounts = { merchants: 0, api_keys: 0, wallets: 0, mandates: 0 };
  const reused: SeedCounts = { merchants: 0, api_keys: 0, wallets: 0, mandates: 0 };

  for (const spec of SEED_MERCHANTS) {
    const known = state.merchants[spec.ref];
    if (known && (await deps.merchantExists(known.merchantId))) {
      reused.merchants += 1;
      reused.api_keys += 1;
    } else {
      const created = await deps.onboard(spec);
      state.merchants[spec.ref] = { merchantId: created.merchantId, keyId: created.keyId, token: created.token };
      save(state);
      inserted.merchants += 1;
      inserted.api_keys += 1;
    }
  }

  for (const spec of SEED_MERCHANTS) {
    if (spec.walletMinor <= 0) continue;
    const merchant = state.merchants[spec.ref]!;
    const reference = walletReference(spec.ref);
    const created = await deps.fundWallet(merchant.merchantId, spec.walletMinor, reference);
    state.wallets[spec.ref] = { reference };
    save(state);
    if (created) inserted.wallets += 1;
    else reused.wallets += 1;
  }

  for (const spec of SEED_MANDATES) {
    const payer = state.merchants[spec.payer];
    const beneficiary = state.merchants[spec.beneficiary];
    if (!payer || !beneficiary) throw new Error(`Mandato ${spec.ref}: falta el comercio ${payer ? spec.beneficiary : spec.payer}`);
    const description = mandateDescription(spec);
    const existing = await deps.findMandate(payer.token, description);
    if (existing) {
      state.mandates[spec.ref] = { mandateId: existing };
      save(state);
      reused.mandates += 1;
      continue;
    }
    const today = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10); // La Paz, UTC-4 todo el año (la regla de pay-schedules)
    const body = {
      kind: spec.kind,
      beneficiary_merchant_id: beneficiary.merchantId,
      amount_minor: spec.amountMinor,
      currency: 'BOB',
      schedule: { frequency: 'monthly', day_of_month: spec.dayOfMonth, start_date: today },
      description,
    };
    const mandateId = await deps.createMandate(payer.token, body, `sandbox-seed-mandate-${spec.ref}`);
    state.mandates[spec.ref] = { mandateId };
    save(state);
    inserted.mandates += 1;
  }
  return { inserted, reused };
}

// ───────────── estado en disco ─────────────

export function loadState(file: string): SeedState {
  if (!existsSync(file)) return emptyState();
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SeedState>;
  if (parsed.version !== 1) throw new Error(`${file}: versión de estado desconocida (${String(parsed.version)})`);
  return { version: 1, merchants: parsed.merchants ?? {}, wallets: parsed.wallets ?? {}, mandates: parsed.mandates ?? {} };
}

/** Las claves `sk_test_` viven acá: modo 0600, fuera del control de versiones (`platform/.sandbox/` está en .gitignore). */
export function saveState(file: string, state: SeedState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

// ───────────── las APIs reales ─────────────

export interface SandboxEndpoints {
  readonly merchants: string;
  readonly edge: string;
  readonly ledger: string;
}

/** `Stack.callAs` contra URLs fijas: la misma forma de identidad interna (X-Service-Id, X-Pay-Mode, X-Merchant-Id) que usa el arnés. */
export function remoteTarget(endpoints: SandboxEndpoints, operatorPrivateKeyPem: string): OnboardingTarget {
  const base: Record<string, string> = { 'pay-merchants': endpoints.merchants, 'pay-edge': endpoints.edge, 'pay-ledger': endpoints.ledger };
  return {
    url: (name) => base[name]!,
    secrets: { operatorPrivateKeyPem },
    callAs: async (from, name, method, path, opts = {}) => {
      const { merchantId, payMode = 'test', ...rest } = opts;
      const headers: Record<string, string> = { accept: 'application/json', 'x-service-id': from, ...(payMode ? { 'x-pay-mode': payMode } : {}), ...(merchantId ? { 'x-merchant-id': merchantId } : {}), ...rest.headers };
      let body = rest.body;
      if (rest.json !== undefined) {
        body = JSON.stringify(rest.json);
        headers['content-type'] ??= 'application/json';
      }
      const res = await fetch(`${base[name]}${path}`, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(rest.timeoutMs ?? 20_000) });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.status, headers: res.headers, text, json };
    },
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function realDeps(target: OnboardingTarget, issuer: string): SeedDeps {
  const edge = (token: string, method: string, path: string, init: { json?: unknown; idempotencyKey?: string } = {}) =>
    fetch(`${target.url('pay-edge')}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}), ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      signal: AbortSignal.timeout(20_000),
    }).then(async (res) => ({ status: res.status, json: (await res.json().catch(() => undefined)) as unknown }));

  return {
    async merchantExists(merchantId) {
      const probe = await target.callAs('pay-backoffice', 'pay-merchants', 'GET', `/merchants/${merchantId}`, { payMode: null, headers: { authorization: `Bearer ${operatorBearer(target, issuer)}` } });
      return probe.status === 200;
    },
    onboard: (spec) =>
      onboardMerchant(target, { label: spec.label, legalName: SEED_LEGAL_NAME, taxId: spec.taxId, operatorIssuer: issuer, idempotencyPrefix: `sandbox-seed-${spec.ref}` }),
    async fundWallet(merchantId, amountMinor, reference) {
      const res = await target.callAs('pay-payments', 'pay-ledger', 'POST', '/transactions', {
        merchantId,
        payMode: 'test',
        headers: { 'idempotency-key': `${merchantId}:${reference}:1` },
        json: { business_ref: `${merchantId}:${reference}`, attempt: 1, currency: 'BOB', legs: [{ debit_account: 'connector:mock:clearing', credit_account: `merchant:${merchantId}:available`, amount_minor: amountMinor, code: 'adjustment' }] },
      });
      if (res.status !== 201 && res.status !== 200) throw new Error(`Asiento de apertura sintético de ${reference} falló (${res.status}): ${res.text.slice(0, 200)}`);
      return res.status === 201;
    },
    async findMandate(token, description) {
      // El borde aprende la clave recién creada por NATS: puede tardar unos segundos (visto contra el stack real: 401 en la primera consulta). Se espera con tope, nunca sin límite.
      const deadline = Date.now() + 45_000;
      for (;;) {
        const probe = await edge(token, 'GET', '/merchants/me');
        if (probe.status === 200) break;
        if (Date.now() > deadline) throw new Error(`pay-edge no reconoce la clave sembrada después de 45 s (GET /v1/merchants/me respondió ${probe.status})`);
        await pause(500);
      }
      const res = await edge(token, 'GET', '/mandates?limit=100');
      if (res.status !== 200) throw new Error(`GET /v1/mandates respondió ${res.status}`);
      return (res.json as { data: { id: string; description?: string; status: string }[] }).data.find((m) => m.description === description && m.status !== 'canceled')?.id;
    },
    async createMandate(token, body, idempotencyKey) {
      // La réplica de comercios de pay-schedules aprende que el comercio está activo por NATS: puede tardar unos segundos tras el alta.
      const deadline = Date.now() + 45_000;
      for (;;) {
        const res = await edge(token, 'POST', '/mandates', { json: body, idempotencyKey });
        if (res.status === 201 || res.status === 200) return (res.json as { id: string }).id;
        const retryable = res.status === 401 || res.status === 404 || res.status === 409 || res.status === 422 || res.status >= 500;
        if (!retryable || Date.now() > deadline) throw new Error(`POST /v1/mandates respondió ${res.status}: ${JSON.stringify(res.json).slice(0, 200)}`);
        await pause(1000);
      }
    },
  };
}

function operatorBearer(target: OnboardingTarget, issuer: string): string {
  return mintOperatorToken(target, ['merchant_operator'], { issuer });
}
