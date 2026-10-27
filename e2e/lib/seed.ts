import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { generateApiKey } from '@pay/api-key';
import { enqueue, newCloudEvent } from '@pay/outbox';
import type { Stack } from '../stack.ts';
import { waitFor } from './process.ts';

export interface SeededMerchant {
  readonly merchantId: string;
  readonly keyId: string;
  /** Token `sk_test_…`: se muestra una sola vez; solo vive en memoria de la prueba. */
  readonly token: string;
}

/**
 * SEMILLA SINTÉTICA DE SANDBOX (P1.H5.M2): un comercio activo con KYC, contrato y tarifario, y una clave `sk_test_`, escritos en la
 * base de `pay-merchants` con SUS tablas y sus eventos por outbox (el relé de pay-merchants los publica al bus, y de ahí los
 * toman `pay-edge`, `pay-payments`, `pay-schedules`, `pay-webhooks`).
 *
 * POR QUÉ NO POR LA API: el back-office de `pay-merchants` exige una credencial de operador y hoy el verificador es
 * `DenyAllOperatorAuthenticator` (sin configuración posible): en un despliegue real nadie puede dar de alta el primer comercio
 * (ver docs/trabajo/ola-2/P1/ARNES.md). Esto es un DOBLE del alta, declarado como tal: todos los datos son inventados.
 */
export async function seedMerchant(stack: Stack, options: { label?: string } = {}): Promise<SeededMerchant> {
  const merchantId = `mc_${randomBytes(6).toString('hex')}`;
  const key = generateApiKey('test');
  const client = new Client({ host: stack.infra.postgres.host, port: stack.infra.postgres.port, database: 'pay_merchants', user: 'pay_merchants', password: 'dev_only_merchants' });
  await client.connect();
  try {
    await client.query('BEGIN');
    const now = new Date();
    await client.query(
      `INSERT INTO merchants (id, display_name, legal_name, legal_type, tax_id, status, activated_at) VALUES ($1, $2, $3, 'srl', $4, 'active', $5)`,
      [merchantId, options.label ?? 'COMERCIO E2E (SINTÉTICO)', 'COMERCIO E2E SINTETICO SRL', `E2E${randomBytes(5).toString('hex')}`, now],
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
    await emit('merchant.created', merchantId, { merchant_id: merchantId, status: 'pending', created_at: iso }, 'merchant');
    await emit('merchant.activated', merchantId, { merchant_id: merchantId, status: 'active', activated_at: iso }, 'merchant');
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

/** Espera (por condición) a que el borde reconozca la clave: prueba el camino pay-merchants → outbox → NATS → réplica de pay-edge. */
export async function waitForEdgeToKnow(stack: Stack, merchant: SeededMerchant, timeoutMs = 30_000): Promise<{ ok: boolean; reason?: string }> {
  return waitFor(
    async () => (await stack.call('pay-edge', 'GET', '/v1/merchants/me', { headers: { authorization: `Bearer ${merchant.token}` } })).status !== 401,
    timeoutMs,
  );
}
