import { createPrivateKey, createSign, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { generateApiKey } from '@pay/api-key';
import { enqueue, newCloudEvent } from '@pay/outbox';
import type { Stack } from '../stack.ts';
import { waitFor } from './process.ts';
import { OPERATOR_ISSUER, type RunSecrets } from './services.ts';

/**
 * Lo mínimo que necesita el alta de un comercio de «el sistema contra el que se siembra»: el arnés (`Stack`, procesos locales) o la capa sandbox en Compose
 * (`yarn seed:sandbox`, contenedores en 127.0.0.1). Un `Stack` cumple esta interfaz tal cual.
 */
export interface OnboardingTarget {
  url(name: 'pay-merchants' | 'pay-edge' | 'pay-ledger'): string;
  readonly secrets: Pick<RunSecrets, 'operatorPrivateKeyPem'>;
  callAs: Stack['callAs'];
}

export interface SeededMerchant {
  readonly merchantId: string;
  readonly keyId: string;
  /** Token `sk_test_…`: se muestra una sola vez; solo vive en memoria de la prueba. */
  readonly token: string;
}

/**
 * Razón social y nombre de pagador SINTÉTICOS. Se eligieron para que NO se parezcan a ninguna entrada de las listas de sanciones: contra el
 * Watchman del Compose (listas OFAC de 2019) puntúan 0,35 y 0,38 como máximo, lejos del umbral de revisión (0,60). `flows/synthetic-names.e2e.ts`
 * lo comprueba contra el Watchman real y falla si alguien cambia los nombres por otros que puntúen alto.
 */
export const SYNTHETIC_LEGAL_NAME = 'TALLER MECANICO VALLE VERDE SRL';
export const SYNTHETIC_PAYER_NAME = 'Cliente Anonimo Prueba';

/**
 * RESPALDO declarado como DOBLE — alta directa en la base de pay-merchants. Úsalo solo con `seedMerchant(stack, { mode: 'sql' })`.
 * SEMILLA SINTÉTICA DE SANDBOX (P1.H5.M2): un comercio activo con KYC, contrato y tarifario, y una clave `sk_test_`, escritos en la
 * base de `pay-merchants` con SUS tablas y sus eventos por outbox (el relé de pay-merchants los publica al bus, y de ahí los
 * toman `pay-edge`, `pay-payments`, `pay-schedules`, `pay-webhooks`).
 *
 * Por defecto el arnés NO usa esto: da de alta por la API real del back-office con una credencial de operador sintética (`onboardMerchant`).
 * Queda como respaldo para aislar un fallo del alta real. Es un DOBLE del alta, declarado como tal: todos los datos son inventados.
 */
export async function seedMerchantDirect(stack: Stack, options: { label?: string; legalName?: string } = {}): Promise<SeededMerchant> {
  const merchantId = `mc_${randomBytes(6).toString('hex')}`;
  const key = generateApiKey('test');
  const client = new Client({ host: stack.infra.postgres.host, port: stack.infra.postgres.port, database: 'pay_merchants', user: 'pay_merchants', password: 'dev_only_merchants' });
  await client.connect();
  try {
    await client.query('BEGIN');
    const now = new Date();
    await client.query(
      `INSERT INTO merchants (id, display_name, legal_name, legal_type, tax_id, status, activated_at) VALUES ($1, $2, $3, 'srl', $4, 'active', $5)`,
      [merchantId, options.label ?? 'COMERCIO E2E (SINTÉTICO)', options.legalName ?? SYNTHETIC_LEGAL_NAME, `E2E${randomBytes(5).toString('hex')}`, now],
    );
    await client.query(`INSERT INTO merchant_kyc (merchant_id, status, risk_level, reviewed_by, reviewed_at) VALUES ($1, 'approved', 'low', 'e2e-seed', $2)`, [merchantId, now]);
    await client.query(`INSERT INTO contract_versions (version, text_sha256, effective_from, published_by) VALUES (1, $1, $2, 'e2e-seed') ON CONFLICT DO NOTHING`, ['0'.repeat(64), now]);
    await client.query(`INSERT INTO contract_acceptances (id, merchant_id, version, text_sha256, accepted_by_ref, recorded_by) VALUES ($1, $2, 1, $3, 'e2e-seed', 'e2e-seed')`, [`ca_${randomBytes(6).toString('hex')}`, merchantId, '0'.repeat(64)]);
    await client.query(`INSERT INTO fee_schedule_versions (merchant_id, version, currency, effective_from, monthly_fee_minor, published_by) VALUES ($1, 1, 'BOB', $2, 0, 'e2e-seed')`, [merchantId, now]);
    const channels = [
      { channel: 'qr', percent: '2.5', fixed_minor: 50 },
      { channel: 'card', percent: '3.25', fixed_minor: 0, min_minor: 100, cap_minor: 5000 },
      { channel: 'bank_transfer', percent: '1', fixed_minor: 0 },
      { channel: 'wallet', percent: '1', fixed_minor: 0 },
      { channel: 'direct', percent: '1.8', fixed_minor: 50, min_minor: 100, cap_minor: 5000 },
    ];
    for (const c of channels) {
      await client.query(`INSERT INTO fee_schedule_channels (merchant_id, version, channel, percent, fixed_minor, min_minor, cap_minor) VALUES ($1, 1, $2, $3, $4, $5, $6)`, [merchantId, c.channel, c.percent, c.fixed_minor, 'min_minor' in c ? c.min_minor : null, 'cap_minor' in c ? c.cap_minor : null]);
    }
    await client.query(`INSERT INTO api_keys (key_id, merchant_id, mode, label, last4, key_hash) VALUES ($1, $2, 'test', 'e2e', $3, $4)`, [key.keyId, merchantId, key.last4, key.keyHash]);

    const iso = now.toISOString();
    const emit = (type: string, subject: string, data: Record<string, unknown>, aggregateType: string) =>
      enqueue(client, newCloudEvent({ source: '/pay-merchants', type, subject, merchantId, data }), { aggregateType, aggregateId: subject });
    await emit('merchant.created', merchantId, { merchant_id: merchantId, status: 'pending', created_at: iso, legal_name: options.legalName ?? SYNTHETIC_LEGAL_NAME }, 'merchant');
    await emit('merchant.activated', merchantId, { merchant_id: merchantId, status: 'active', activated_at: iso, legal_name: options.legalName ?? SYNTHETIC_LEGAL_NAME }, 'merchant');
    await emit('fee_schedule.published', merchantId, { merchant_id: merchantId, version: 1, currency: 'BOB', effective_from: iso, effective_to: null, channels, monthly_fee_minor: 0 }, 'fee_schedule');
    await emit('api_key.created', key.keyId, { key_id: key.keyId, merchant_id: merchantId, mode: 'test', key_hash: key.keyHash, last4: key.last4, created_at: iso }, 'api_key');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  return { merchantId, keyId: key.keyId, token: key.token };
}

export interface SeedOptions {
  readonly label?: string;
  readonly legalName?: string;
  /** NIT sintético fijo (por defecto uno aleatorio por alta). La siembra de sandbox lo fija para poder reconocer su comercio. */
  readonly taxId?: string;
  /** Emisor de la credencial de operador (por defecto el del arnés). */
  readonly operatorIssuer?: string;
  /** Prefijo de las `Idempotency-Key` del alta; con uno fijo, repetir el alta dentro de las 24 h devuelve el mismo comercio. */
  readonly idempotencyPrefix?: string;
  /** `api` (por defecto): alta por la API real de pay-merchants. `sql`: el respaldo directo en la base (DOBLE). */
  readonly mode?: 'api' | 'sql';
}

/** Emite un JWT RS256 de operador SINTÉTICO de sandbox, con la misma forma que `scripts/sandbox-operator-token.mjs` de pay-merchants. */
export function mintOperatorToken(stack: Pick<OnboardingTarget, 'secrets'>, roles: readonly string[], options: { sub?: string; ttlSeconds?: number; issuer?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: options.issuer ?? OPERATOR_ISSUER, aud: 'pay-merchants', sub: options.sub ?? 'operador_e2e_01', roles, mode: 'sandbox', iat: now, exp: now + (options.ttlSeconds ?? 600) })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(createPrivateKey(stack.secrets.operatorPrivateKeyPem)).toString('base64url')}`;
}

const OPERATOR_ROLES = ['merchant_operator', 'kyc_reviewer', 'legal_admin', 'pricing_admin'] as const;
const KYC_KINDS = ['constitucion', 'nit', 'seprec', 'licencia_funcionamiento', 'certificado_sedes', 'poder_representante'] as const;
/** PNG mínimo con firma válida: es lo que detecta el almacén de KYC por los primeros bytes. Contenido sintético, sin datos de nadie. */
const SYNTHETIC_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('DOCUMENTO SINTETICO DE PRUEBA')]);
const FEE_CHANNELS = [
  { channel: 'qr', percent: '2.5', fixed_minor: 50 },
  { channel: 'card', percent: '3.25', fixed_minor: 0, min_minor: 100, cap_minor: 5000 },
  { channel: 'bank_transfer', percent: '1', fixed_minor: 0 },
  { channel: 'wallet', percent: '1', fixed_minor: 0 },
  { channel: 'direct', percent: '1.8', fixed_minor: 50, min_minor: 100, cap_minor: 5000 },
];

/**
 * ALTA POR LA API REAL de pay-merchants, como la haría el back-office de ALOVIDA: crea el comercio, sube los 6 documentos de KYC, aprueba el KYC,
 * publica y acepta el contrato, publica el tarifario y activa. Todo con una credencial de operador SINTÉTICA (JWT firmado por el arnés) y la
 * identidad de servicio `pay-backoffice`. Los eventos (`merchant.created|activated` con `legal_name`, `fee_schedule.published`, `api_key.created`) los
 * publica el propio servicio por outbox: nada se escribe en su base.
 *
 * Único paso que NO es la API real de un operador: la PRIMERA clave `sk_test_`. Se pide a `POST /api_keys` con la identidad de `pay-edge` y el
 * `X-Merchant-Id` del comercio (lo que el borde reenviaría), porque el borde exige una clave para llegar a esa ruta y no hay otro camino para la primera
 * (hallazgo para P5/P1 en ARNES.md: ¿quién emite la primera clave de un comercio?).
 */
export async function onboardMerchant(stack: OnboardingTarget, options: SeedOptions = {}): Promise<SeededMerchant> {
  const bearer = `Bearer ${mintOperatorToken(stack, OPERATOR_ROLES, options.operatorIssuer ? { issuer: options.operatorIssuer } : {})}`;
  const backoffice = async (method: string, path: string, init: { json?: unknown; idempotencyKey?: string; form?: FormData } = {}) => {
    const res = await fetch(`${stack.url('pay-merchants')}${path}`, {
      method,
      headers: { 'x-service-id': 'pay-backoffice', authorization: bearer, ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}), ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const must = async (what: string, call: Promise<{ status: number; json: Record<string, unknown> }>, ok: readonly number[] = [200, 201]) => {
    const res = await call;
    if (!ok.includes(res.status)) throw new Error(`Alta de comercio: «${what}» respondió ${res.status}: ${JSON.stringify(res.json).slice(0, 300)}`);
    return res.json;
  };

  const created = await must('crear comercio', backoffice('POST', '/merchants', {
    idempotencyKey: `e2e-merchant-${randomBytes(8).toString('hex')}`,
    json: { display_name: options.label ?? 'COMERCIO E2E (SINTÉTICO)', legal_name: options.legalName ?? SYNTHETIC_LEGAL_NAME, legal_type: 'srl', tax_id: `E2E${randomBytes(5).toString('hex')}` },
  }));
  const merchantId = created.id as string;
  for (const kind of KYC_KINDS) {
    const form = new FormData();
    form.set('kind', kind);
    form.set('file', new Blob([new Uint8Array(SYNTHETIC_PNG)], { type: 'image/png' }), `${kind}.png`);
    await must(`subir documento ${kind}`, backoffice('POST', `/merchants/${merchantId}/kyc/documents`, { form }));
  }
  await must('aprobar KYC', backoffice('PUT', `/merchants/${merchantId}/kyc/review`, { json: { decision: 'approved', risk_level: 'low', note: 'sintético' } }));
  // La versión 1 del contrato se publica una sola vez por corrida; las siguientes altas la reutilizan (la API contesta `not_next`).
  const published = await backoffice('POST', '/contract_versions', { json: { version: 1, text_sha256: '0'.repeat(64) } });
  if (published.status >= 400 && !JSON.stringify(published.json).includes('not_next')) throw new Error(`Alta de comercio: «publicar contrato» respondió ${published.status}: ${JSON.stringify(published.json).slice(0, 300)}`);
  await must('aceptar contrato', backoffice('POST', `/merchants/${merchantId}/contract_acceptances`, { json: { version: 1, accepted_by_ref: 'e2e-sintetico' } }));
  await must('publicar tarifario', backoffice('POST', `/merchants/${merchantId}/fee_schedules`, { json: { monthly_fee_minor: 0, channels: FEE_CHANNELS } }));
  await must('activar comercio', backoffice('POST', `/merchants/${merchantId}/activate`));

  const key = await stack.callAs('pay-edge', 'pay-merchants', 'POST', '/api_keys', { merchantId, payMode: 'test', headers: { 'idempotency-key': `e2e-first-key-${randomBytes(8).toString('hex')}` }, json: { mode: 'test', label: 'e2e' } });
  if (key.status !== 201) throw new Error(`Alta de comercio: «primera clave» respondió ${key.status}: ${JSON.stringify(key.json).slice(0, 300)}`);
  const body = key.json as { id: string; secret: string };
  return { merchantId, keyId: body.id, token: body.secret };
}

/** Da de alta un comercio sintético con su clave `sk_test_`: por la API real de pay-merchants (por defecto) o con el respaldo directo (DOBLE). */
export async function seedMerchant(stack: Stack, options: SeedOptions = {}): Promise<SeededMerchant> {
  return options.mode === 'sql' ? seedMerchantDirect(stack, options) : onboardMerchant(stack, options);
}

/** Espera (por condición) a que el borde reconozca la clave: prueba el camino pay-merchants → outbox → NATS → réplica de pay-edge. */
export async function waitForEdgeToKnow(stack: Stack, merchant: SeededMerchant, timeoutMs = 30_000): Promise<{ ok: boolean; reason?: string }> {
  return waitFor(
    async () => (await stack.call('pay-edge', 'GET', '/v1/merchants/me', { headers: { authorization: `Bearer ${merchant.token}` } })).status !== 401,
    timeoutMs,
  );
}

export type MerchantTransition = 'suspend' | 'reactivate' | 'close';

/**
 * [DOBLE] de la acción de un operador sobre un comercio (el back-office real exige una credencial que hoy nadie puede obtener):
 * hace lo MISMO que `MerchantsService.suspend|activate|close` de pay-merchants — cambia la fila y publica los eventos por outbox en la
 * misma transacción. D-32: cerrar revoca todas las claves vivas (un `api_key.revoked` por clave) y además publica `merchant.closed`;
 * suspender solo bloquea. `announceKeyRevocations: false` publica SOLO `merchant.closed` (el peor caso para quien consume: la
 * revocación por clave no llega o llega después).
 */
export async function changeMerchantStatus(stack: Stack, merchant: SeededMerchant, transition: MerchantTransition, options: { announceKeyRevocations?: boolean } = {}): Promise<void> {
  const client = new Client({ host: stack.infra.postgres.host, port: stack.infra.postgres.port, database: 'pay_merchants', user: 'pay_merchants', password: 'dev_only_merchants' });
  await client.connect();
  try {
    await client.query('BEGIN');
    const now = new Date();
    const iso = now.toISOString();
    const { merchantId } = merchant;
    const emit = (type: string, subject: string, data: Record<string, unknown>, aggregateType: string) =>
      enqueue(client, newCloudEvent({ source: '/pay-merchants', type, subject, merchantId, data }), { aggregateType, aggregateId: subject });
    if (transition === 'suspend') {
      await client.query(`UPDATE merchants SET status = 'suspended', suspended_at = $2, suspension_reason = 'manual' WHERE id = $1`, [merchantId, now]);
      await emit('merchant.suspended', merchantId, { merchant_id: merchantId, status: 'suspended', suspended_at: iso, reason: 'manual' }, 'merchant');
    } else if (transition === 'reactivate') {
      await client.query(`UPDATE merchants SET status = 'active', activated_at = $2, suspended_at = NULL, suspension_reason = NULL WHERE id = $1`, [merchantId, now]);
      await emit('merchant.activated', merchantId, { merchant_id: merchantId, status: 'active', activated_at: iso }, 'merchant');
    } else {
      await client.query(`UPDATE merchants SET status = 'closed', closed_at = $2 WHERE id = $1`, [merchantId, now]);
      const live = await client.query('SELECT key_id, mode FROM api_keys WHERE merchant_id = $1 AND revoked_at IS NULL ORDER BY created_at, key_id', [merchantId]);
      for (const key of live.rows as { key_id: string; mode: 'test' | 'live' }[]) {
        await client.query(`UPDATE api_keys SET revoked_at = $2, revoke_reason = 'merchant_closed' WHERE key_id = $1`, [key.key_id, now]);
        if (options.announceKeyRevocations !== false) {
          await emit('api_key.revoked', key.key_id, { key_id: key.key_id, merchant_id: merchantId, mode: key.mode, reason: 'merchant_closed', revoked_at: iso }, 'api_key');
        }
      }
      await emit('merchant.closed', merchantId, { merchant_id: merchantId, status: 'closed', closed_at: iso }, 'merchant');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
